const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const SftpClient = require("ssh2-sftp-client");
const { createSshSessionRuntime } = require("../ssh/ssh-session-runtime.cjs");

const TEXT_PREVIEW_LIMIT = 1024 * 1024;
const MEDIA_PROTOCOL = "pannel-media";
const IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".avif", "image/avif"]
]);
const VIDEO_MIME_BY_EXTENSION = new Map([
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".ogg", "video/ogg"],
  [".ogv", "video/ogg"],
  [".mov", "video/quicktime"],
  [".m4v", "video/mp4"]
]);

function normalizeRemotePath(value) {
  const remotePath = String(value || ".").trim() || ".";
  return remotePath.replace(/\\/g, "/");
}

function joinRemotePath(basePath, name) {
  if (!basePath || basePath === ".") {
    return name;
  }
  return path.posix.join(normalizeRemotePath(basePath), name);
}

function isLikelyBinary(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function getContentVersion(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getMediaType(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (IMAGE_MIME_BY_EXTENSION.has(extension)) {
    return { kind: "image", mime: IMAGE_MIME_BY_EXTENSION.get(extension) };
  }
  if (VIDEO_MIME_BY_EXTENSION.has(extension)) {
    return { kind: "video", mime: VIDEO_MIME_BY_EXTENSION.get(extension) };
  }
  return null;
}

function getPreviewTokenFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${MEDIA_PROTOCOL}:` || parsed.hostname !== "preview") {
      return "";
    }
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

function parseRangeHeader(rangeHeader, size) {
  if (typeof rangeHeader !== "string" || !rangeHeader.trim()) {
    return null;
  }
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return { invalid: true };
  }
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) {
    return { invalid: true };
  }

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }

  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || start >= size
  ) {
    return { invalid: true };
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

function normalizeWindowsPath(value, fallbackPath) {
  const rawPath = String(value || fallbackPath || os.homedir()).trim() || fallbackPath || os.homedir();
  if (rawPath.includes("\0")) {
    throw new Error("Invalid path.");
  }
  if (path.isAbsolute(rawPath)) {
    return path.resolve(rawPath);
  }
  return path.resolve(fallbackPath || os.homedir(), rawPath);
}

function normalizeWslPath(value, fallbackPath = "~") {
  const rawPath = String(value || fallbackPath || "~").trim() || fallbackPath || "~";
  if (rawPath.includes("\0")) {
    throw new Error("Invalid WSL path.");
  }
  if (rawPath === "~") {
    return "~";
  }
  const normalized = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) {
    throw new Error("WSL path must be an absolute Linux path.");
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function validateWslDistro(wslDistro) {
  const distro = String(wslDistro || "").trim();
  if (!/^[\w.-]+$/.test(distro)) {
    throw new Error("A valid WSL distro is required.");
  }
  return distro;
}

function toWslHostPath(wslDistro, linuxPath) {
  const distro = validateWslDistro(wslDistro);
  const normalized = normalizeWslPath(linuxPath);
  if (normalized === "~") {
    return path.win32.join(`\\\\wsl.localhost\\${distro}`, "home");
  }
  return path.win32.join(`\\\\wsl.localhost\\${distro}`, ...normalized.split("/").filter(Boolean));
}

function fromWslHostPath(hostPath, wslDistro) {
  const distro = validateWslDistro(wslDistro);
  const prefix = `\\\\wsl.localhost\\${distro}`;
  const normalizedHostPath = String(hostPath || "").replace(/\//g, "\\");
  if (!normalizedHostPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizeWslPath(hostPath);
  }
  const rest = normalizedHostPath.slice(prefix.length).replace(/\\/g, "/");
  return rest ? normalizeWslPath(rest) : "/";
}

function joinWslPath(basePath, name) {
  const normalizedBase = normalizeWslPath(basePath);
  if (normalizedBase === "~") {
    return normalizeWslPath(`/${name}`);
  }
  return path.posix.join(normalizedBase, name);
}

function createRemoteFileService({ terminalManager, sessionStore, knownHostStore, sshSessionRuntime, sftpFactory = () => new SftpClient(), fsApi = fs, shellApi }) {
  const clients = new Map();
  const previews = new Map();
  const sshRuntime = sshSessionRuntime || createSshSessionRuntime({
    terminalManager,
    sessionStore,
    knownHostStore,
    sftpFactory
  });

  function getSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }
    if (!["windows", "wsl", "ssh"].includes(session.type)) {
      throw new Error("Files are only available for Windows, WSL, and SSH sessions.");
    }
    return session;
  }

  function getLocalHome(session) {
    if (session.type === "windows") {
      return normalizeWindowsPath(session.cwd, os.homedir());
    }
    const cwd = normalizeWslPath(session.cwd || "~");
    return cwd === "~" ? "/home" : cwd;
  }

  function toLocalHostPath(session, filePath) {
    if (session.type === "windows") {
      return normalizeWindowsPath(filePath, getLocalHome(session));
    }
    if (session.type === "wsl") {
      return toWslHostPath(session.wslDistro, filePath || getLocalHome(session));
    }
    throw new Error("Local files are only available for Windows and WSL sessions.");
  }

  function fromLocalHostPath(session, hostPath) {
    if (session.type === "windows") {
      return normalizeWindowsPath(hostPath);
    }
    return fromWslHostPath(hostPath, session.wslDistro);
  }

  function joinLocalPath(session, basePath, name) {
    if (session.type === "windows") {
      return path.join(normalizeWindowsPath(basePath, getLocalHome(session)), name);
    }
    return joinWslPath(basePath, name);
  }

  async function getClient(sessionId) {
    getSession(sessionId);
    const cached = clients.get(sessionId);
    if (cached) {
      return cached;
    }

    const client = await sshRuntime.createSftpClient(sessionId);
    clients.set(sessionId, client);
    return client;
  }

  async function listLocal(session, filePath) {
    const displayPath = session.type === "wsl"
      ? normalizeWslPath(filePath || getLocalHome(session))
      : normalizeWindowsPath(filePath, getLocalHome(session));
    const hostPath = toLocalHostPath(session, displayPath);
    const dirents = await fsApi.promises.readdir(hostPath, { withFileTypes: true });
    const entries = await Promise.all(dirents.map(async (dirent) => {
      const childDisplayPath = joinLocalPath(session, displayPath, dirent.name);
      const childHostPath = toLocalHostPath(session, childDisplayPath);
      const stat = await fsApi.promises.stat(childHostPath);
      return {
        name: dirent.name,
        path: fromLocalHostPath(session, childHostPath),
        type: dirent.isDirectory() ? "directory" : dirent.isSymbolicLink() ? "symlink" : "file",
        size: Number(stat.size || 0),
        modifiedAt: Number(stat.mtimeMs || 0)
      };
    }));
    return sortEntries(entries);
  }

  async function readLocalText(session, filePath) {
    const hostPath = toLocalHostPath(session, filePath);
    const stat = await fsApi.promises.stat(hostPath);
    const size = Number(stat.size || 0);
    if (size > TEXT_PREVIEW_LIMIT) {
      return { kind: "too_large", size, limit: TEXT_PREVIEW_LIMIT };
    }

    const buffer = await fsApi.promises.readFile(hostPath);
    if (buffer.length > TEXT_PREVIEW_LIMIT) {
      return { kind: "too_large", size: buffer.length, limit: TEXT_PREVIEW_LIMIT };
    }
    if (isLikelyBinary(buffer)) {
      return { kind: "binary", size: buffer.length };
    }
    return {
      kind: "text",
      size: buffer.length,
      content: buffer.toString("utf-8"),
      version: getContentVersion(buffer)
    };
  }

  async function previewLocalFile(sessionId, session, filePath) {
    const mediaType = getMediaType(filePath);
    if (!mediaType) {
      return readLocalText(session, filePath);
    }

    const hostPath = toLocalHostPath(session, filePath);
    const stat = await fsApi.promises.stat(hostPath);
    if (typeof stat.isFile === "function" && !stat.isFile()) {
      return { kind: "binary", size: Number(stat.size || 0) };
    }

    const previewId = crypto.randomBytes(18).toString("base64url");
    const size = Number(stat.size || 0);
    previews.set(previewId, {
      sessionId,
      hostPath,
      size,
      kind: mediaType.kind,
      mime: mediaType.mime,
      createdAt: Date.now()
    });

    return {
      kind: mediaType.kind,
      size,
      mime: mediaType.mime,
      previewId,
      url: `${MEDIA_PROTOCOL}://preview/${encodeURIComponent(previewId)}`
    };
  }

  async function writeLocalText(session, filePath, content, expectedVersion) {
    const contentBuffer = Buffer.from(content, "utf-8");
    const hostPath = toLocalHostPath(session, filePath);
    const currentStat = await fsApi.promises.stat(hostPath);
    if (Number(currentStat.size || 0) > TEXT_PREVIEW_LIMIT) {
      return { status: "conflict" };
    }
    const currentBuffer = await fsApi.promises.readFile(hostPath);
    if (currentBuffer.length > TEXT_PREVIEW_LIMIT || getContentVersion(currentBuffer) !== expectedVersion) {
      return { status: "conflict" };
    }

    await fsApi.promises.writeFile(hostPath, contentBuffer);
    return {
      status: "saved",
      size: contentBuffer.length,
      version: getContentVersion(contentBuffer)
    };
  }

  async function getHome(sessionId) {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return getLocalHome(session);
    }
    const client = await getClient(sessionId);
    return normalizeRemotePath(await client.cwd());
  }

  async function list(sessionId, remotePath = ".") {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return listLocal(session, remotePath);
    }
    const client = await getClient(sessionId);
    const normalizedPath = normalizeRemotePath(remotePath);
    const entries = await client.list(normalizedPath);
    return sortEntries(entries
      .map((entry) => ({
        name: entry.name,
        path: joinRemotePath(normalizedPath, entry.name),
        type: entry.type === "d" ? "directory" : entry.type === "l" ? "symlink" : "file",
        size: Number(entry.size || 0),
        modifiedAt: Number(entry.modifyTime || 0),
        rights: entry.rights ? {
          user: entry.rights.user,
          group: entry.rights.group,
          other: entry.rights.other
        } : undefined
      }))
    );
  }

  async function readText(sessionId, remotePath) {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return readLocalText(session, remotePath);
    }
    const normalizedPath = normalizeRemotePath(remotePath);
    const client = await getClient(sessionId);
    const stat = await client.stat(normalizedPath);
    const size = Number(stat.size || 0);
    if (size > TEXT_PREVIEW_LIMIT) {
      return { kind: "too_large", size, limit: TEXT_PREVIEW_LIMIT };
    }

    const data = await client.get(normalizedPath);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length > TEXT_PREVIEW_LIMIT) {
      return { kind: "too_large", size: buffer.length, limit: TEXT_PREVIEW_LIMIT };
    }
    if (isLikelyBinary(buffer)) {
      return { kind: "binary", size: buffer.length };
    }
    return {
      kind: "text",
      size: buffer.length,
      content: buffer.toString("utf-8"),
      version: getContentVersion(buffer)
    };
  }

  async function previewFile(sessionId, remotePath) {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return previewLocalFile(sessionId, session, remotePath);
    }
    return readText(sessionId, remotePath);
  }

  function releasePreview(previewId) {
    if (typeof previewId !== "string" || !previewId) {
      return false;
    }
    return previews.delete(previewId);
  }

  function createPreviewStreamResponse(previewIdOrUrl, rangeHeader) {
    const previewId = String(previewIdOrUrl || "").includes("://")
      ? getPreviewTokenFromUrl(previewIdOrUrl)
      : String(previewIdOrUrl || "");
    const preview = previews.get(previewId);
    if (!preview) {
      throw new Error("Preview is not available.");
    }
    if (typeof fsApi.createReadStream !== "function") {
      throw new Error("Media streaming is not available.");
    }

    const size = Number(preview.size || 0);
    const range = parseRangeHeader(rangeHeader, size);
    if (range?.invalid) {
      return {
        statusCode: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Content-Range": `bytes */${size}`,
          "Content-Length": "0"
        },
        data: Readable.from([])
      };
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(size - 1, 0);
    const contentLength = size === 0 ? 0 : end - start + 1;
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": preview.mime,
      "Content-Length": String(contentLength)
    };
    if (range) {
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }

    return {
      statusCode: range ? 206 : 200,
      headers,
      data: size === 0
        ? Readable.from([])
        : fsApi.createReadStream(preview.hostPath, { start, end })
    };
  }

  async function writeText(sessionId, remotePath, content, expectedVersion) {
    if (typeof content !== "string" || typeof expectedVersion !== "string" || !expectedVersion) {
      throw new Error("Invalid text save request.");
    }

    const contentBuffer = Buffer.from(content, "utf-8");
    if (contentBuffer.length > TEXT_PREVIEW_LIMIT) {
      throw new Error(`Text file exceeds the ${TEXT_PREVIEW_LIMIT} byte edit limit.`);
    }

    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return writeLocalText(session, remotePath, content, expectedVersion);
    }
    const normalizedPath = normalizeRemotePath(remotePath);
    const client = await getClient(sessionId);
    const currentStat = await client.stat(normalizedPath);
    if (Number(currentStat.size || 0) > TEXT_PREVIEW_LIMIT) {
      return { status: "conflict" };
    }
    const currentData = await client.get(normalizedPath);
    const currentBuffer = Buffer.isBuffer(currentData) ? currentData : Buffer.from(currentData);
    if (currentBuffer.length > TEXT_PREVIEW_LIMIT || getContentVersion(currentBuffer) !== expectedVersion) {
      return { status: "conflict" };
    }

    await client.put(contentBuffer, normalizedPath);
    return {
      status: "saved",
      size: contentBuffer.length,
      version: getContentVersion(contentBuffer)
    };
  }

  async function writeBinaryFile(sessionId, remotePath, contentBuffer) {
    const buffer = Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer);
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      const hostPath = toLocalHostPath(session, remotePath);
      await fsApi.promises.mkdir(path.dirname(hostPath), { recursive: true });
      await fsApi.promises.writeFile(hostPath, buffer);
      return {
        remotePath: session.type === "wsl" ? normalizeWslPath(remotePath) : normalizeWindowsPath(remotePath, getLocalHome(session))
      };
    }

    const normalizedPath = normalizeRemotePath(remotePath);
    const client = await getClient(sessionId);
    if (typeof client.mkdir === "function") {
      await client.mkdir(path.posix.dirname(normalizedPath), true);
    }
    await client.put(buffer, normalizedPath);
    return { remotePath: normalizedPath };
  }

  async function validateLocalUploadPath(localPath) {
    if (typeof localPath !== "string" || !localPath.trim()) {
      throw new Error("A local file path is required.");
    }
    const stat = await fsApi.promises.stat(localPath);
    if (typeof stat.isFile === "function" && !stat.isFile()) {
      throw new Error("Only files can be uploaded. Directory upload is not supported.");
    }
  }

  async function uploadValidatedFile(sessionId, session, localPath, remoteDir) {
    if (session.type !== "ssh") {
      const fileName = path.basename(localPath);
      const targetPath = joinLocalPath(session, remoteDir, fileName);
      await fsApi.promises.copyFile(localPath, toLocalHostPath(session, targetPath));
      return { remotePath: targetPath };
    }
    const client = await getClient(sessionId);
    const fileName = path.basename(localPath);
    const remotePath = joinRemotePath(normalizeRemotePath(remoteDir), fileName);
    await client.fastPut(localPath, remotePath);
    return { remotePath };
  }

  async function uploadFile(sessionId, localPath, remoteDir) {
    const session = getSession(sessionId);
    await validateLocalUploadPath(localPath);
    return uploadValidatedFile(sessionId, session, localPath, remoteDir);
  }

  async function uploadFiles(sessionId, localPaths, remoteDir) {
    const session = getSession(sessionId);
    if (!Array.isArray(localPaths) || localPaths.length === 0) {
      throw new Error("No local files were provided.");
    }
    await Promise.all(localPaths.map((localPath) => validateLocalUploadPath(localPath)));
    const uploaded = [];
    for (const localPath of localPaths) {
      uploaded.push(await uploadValidatedFile(sessionId, session, localPath, remoteDir));
    }
    return uploaded;
  }

  async function downloadFile(sessionId, remotePath, localPath) {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      await fsApi.promises.copyFile(toLocalHostPath(session, remotePath), localPath);
      return { localPath };
    }
    const client = await getClient(sessionId);
    await client.fastGet(normalizeRemotePath(remotePath), localPath);
    return { localPath };
  }

  async function openInExplorer(sessionId, remotePath) {
    const session = getSession(sessionId);
    if (session.type === "ssh") {
      throw new Error("Open in Explorer is only available for local files.");
    }
    if (!shellApi || typeof shellApi.openPath !== "function") {
      throw new Error("Explorer integration is not available.");
    }

    const explorerPath = toLocalHostPath(session, remotePath);
    const error = await shellApi.openPath(explorerPath);
    if (error) {
      throw new Error(error);
    }
  }

  async function deleteEntry(sessionId, remotePath) {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      const hostPath = toLocalHostPath(session, remotePath);
      await fsApi.promises.rm(hostPath, { recursive: true, force: true });
      return;
    }
    const normalizedPath = normalizeRemotePath(remotePath);
    const client = await getClient(sessionId);
    try {
      await client.rmdir(normalizedPath, true);
    } catch {
      await client.delete(normalizedPath);
    }
  }

  async function disconnect(sessionId) {
    const client = clients.get(sessionId);
    clients.delete(sessionId);
    for (const [previewId, preview] of previews) {
      if (preview.sessionId === sessionId) {
        previews.delete(previewId);
      }
    }
    if (client) {
      try {
        await client.end();
      } catch {
        // Ignore close failures during session cleanup.
      }
    }
  }

  async function shutdown() {
    const ids = Array.from(clients.keys());
    await Promise.all(ids.map((id) => disconnect(id)));
    previews.clear();
  }

  return {
    getHome,
    list,
    readText,
    previewFile,
    releasePreview,
    createPreviewStreamResponse,
    writeText,
    writeBinaryFile,
    uploadFile,
    uploadFiles,
    downloadFile,
    openInExplorer,
    deleteEntry,
    disconnect,
    shutdown
  };
}

module.exports = {
  TEXT_PREVIEW_LIMIT,
  MEDIA_PROTOCOL,
  normalizeWslPath,
  toWslHostPath,
  getPreviewTokenFromUrl,
  parseRangeHeader,
  createRemoteFileService
};
