const { normalizeWslPath, validateWslDistro, toWslHostPath, fromWslHostPath, joinWslPath } = require("../../core/wsl-paths.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const OFFICE_PREVIEW_LIMIT = 50 * 1024 * 1024;
const TRANSFER_PROGRESS_INTERVAL_MS = 250;
const LOCAL_STAT_CONCURRENCY = 16;
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
const OFFICE_TYPE_BY_EXTENSION = new Map([
  [".docx", { format: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
  [".xlsx", { format: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  [".pptx", { format: "presentation", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }]
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

function createTransferProgressReporter(onProgress, initialTotalBytes) {
  if (typeof onProgress !== "function") return null;
  let lastPercent;
  let lastReportedAt = 0;
  return (transferredBytes, reportedTotalBytes = initialTotalBytes, force = false) => {
    const totalBytes = Math.max(0, Number(reportedTotalBytes) || Number(initialTotalBytes) || 0);
    const normalizedTransferredBytes = Math.max(0, Number(transferredBytes) || 0);
    const percent = totalBytes > 0
      ? Math.min(100, Math.round((normalizedTransferredBytes / totalBytes) * 100))
      : null;
    const now = Date.now();
    if (!force && percent === lastPercent && now - lastReportedAt < TRANSFER_PROGRESS_INTERVAL_MS) return;
    lastPercent = percent;
    lastReportedAt = now;
    onProgress({ transferredBytes: normalizedTransferredBytes, totalBytes, percent });
  };
}

function decodeTextBuffer(buffer) {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const content = buffer.subarray(bom ? 3 : 0).toString("utf-8");
  const eol = content.includes("\r\n") ? "crlf" : content.includes("\r") ? "cr" : "lf";
  return { content, encoding: "utf-8", bom, eol };
}

function encodeTextContent(content, format = {}) {
  const eol = format.eol === "crlf" ? "\r\n" : format.eol === "cr" ? "\r" : "\n";
  const normalized = String(content).replace(/\r\n|\r|\n/g, eol);
  const body = Buffer.from(normalized, "utf-8");
  return format.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function validateEntryName(name) {
  const value = String(name || "").trim();
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error("A valid file name is required.");
  }
  return value;
}

function autoRename(name, attempt) {
  const extension = path.posix.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (${attempt})${extension}`;
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

function getOfficeType(filePath) {
  return OFFICE_TYPE_BY_EXTENSION.get(path.extname(String(filePath || "")).toLowerCase()) || null;
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

function createRemoteFileService({ terminalManager, sshFileSystem, fsApi = fs, shellApi, previewCacheRoot = path.join(os.tmpdir(), "pannel-handle-office-preview") }) {
  const previews = new Map();
  const previewCleanupTasks = new Set();
  const activeDownloads = new Map();
  let previewCacheReady = null;

  function schedulePreviewFileCleanup(hostPath) {
    if (!hostPath) return;
    const cleanup = fsApi.promises.rm(hostPath, { force: true })
      .catch(() => undefined)
      .finally(() => previewCleanupTasks.delete(cleanup));
    previewCleanupTasks.add(cleanup);
  }

  function ensurePreviewCache() {
    previewCacheReady ||= (async () => {
      await fsApi.promises.rm(previewCacheRoot, { recursive: true, force: true });
      await fsApi.promises.mkdir(previewCacheRoot, { recursive: true });
    })();
    return previewCacheReady;
  }

  function registerPreview(sessionId, hostPath, size, descriptor, temporary = false) {
    const previewId = crypto.randomBytes(18).toString("base64url");
    previews.set(previewId, {
      sessionId,
      hostPath,
      size,
      kind: descriptor.kind || "office",
      format: descriptor.format,
      mime: descriptor.mime,
      temporary,
      createdAt: Date.now()
    });
    return {
      kind: descriptor.kind || "office",
      format: descriptor.format,
      size,
      mime: descriptor.mime,
      previewId,
      url: `${MEDIA_PROTOCOL}://preview/${encodeURIComponent(previewId)}`
    };
  }

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

  async function listLocal(session, filePath) {
    const displayPath = session.type === "wsl"
      ? normalizeWslPath(filePath || getLocalHome(session))
      : normalizeWindowsPath(filePath, getLocalHome(session));
    const hostPath = toLocalHostPath(session, displayPath);
    const dirents = await fsApi.promises.readdir(hostPath, { withFileTypes: true });
    const entries = [];
    for (let offset = 0; offset < dirents.length; offset += LOCAL_STAT_CONCURRENCY) {
      if (offset > 0) await new Promise((resolve) => setImmediate(resolve));
      const batch = await Promise.all(dirents.slice(offset, offset + LOCAL_STAT_CONCURRENCY).map(async (dirent) => {
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
      entries.push(...batch);
    }
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
      ...decodeTextBuffer(buffer),
      version: getContentVersion(buffer)
    };
  }

  async function previewLocalFile(sessionId, session, filePath) {
    const mediaType = getMediaType(filePath);
    const officeType = getOfficeType(filePath);
    if (!mediaType && !officeType) {
      return readLocalText(session, filePath);
    }

    const hostPath = toLocalHostPath(session, filePath);
    const stat = await fsApi.promises.stat(hostPath);
    if (typeof stat.isFile === "function" && !stat.isFile()) {
      return { kind: "binary", size: Number(stat.size || 0) };
    }
    const size = Number(stat.size || 0);
    if (officeType && size > OFFICE_PREVIEW_LIMIT) {
      return { kind: "too_large", size, limit: OFFICE_PREVIEW_LIMIT };
    }
    return registerPreview(sessionId, hostPath, size, mediaType || officeType);
  }

  async function writeLocalText(session, filePath, content, expectedVersion, options = {}) {
    const contentBuffer = encodeTextContent(content, options.format);
    const hostPath = toLocalHostPath(session, filePath);
    if (!options.force) {
      const currentStat = await fsApi.promises.stat(hostPath);
      if (Number(currentStat.size || 0) > TEXT_PREVIEW_LIMIT) {
        return { status: "conflict" };
      }
      const currentBuffer = await fsApi.promises.readFile(hostPath);
      if (currentBuffer.length > TEXT_PREVIEW_LIMIT || getContentVersion(currentBuffer) !== expectedVersion) {
        return { status: "conflict" };
      }
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
    const configuredCwd = String(session.cwd || "").trim();
    if (configuredCwd && configuredCwd !== "~" && configuredCwd.startsWith("/")) {
      return normalizeRemotePath(configuredCwd);
    }
    return normalizeRemotePath(await sshFileSystem.cwd(sessionId));
  }

  async function list(sessionId, remotePath = ".") {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return listLocal(session, remotePath);
    }
    const normalizedPath = normalizeRemotePath(remotePath);
    const entries = await sshFileSystem.list(sessionId, normalizedPath);
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
    const stat = await sshFileSystem.stat(sessionId, normalizedPath);
    const size = Number(stat.size || 0);
    if (size > TEXT_PREVIEW_LIMIT) {
      return { kind: "too_large", size, limit: TEXT_PREVIEW_LIMIT };
    }

    const data = await sshFileSystem.get(sessionId, normalizedPath);
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
      ...decodeTextBuffer(buffer),
      version: getContentVersion(buffer)
    };
  }

  async function previewFile(sessionId, remotePath) {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return previewLocalFile(sessionId, session, remotePath);
    }
    const officeType = getOfficeType(remotePath);
    if (officeType) {
      const normalizedPath = normalizeRemotePath(remotePath);
      const stat = await sshFileSystem.stat(sessionId, normalizedPath);
      const size = Number(stat.size || 0);
      if (size > OFFICE_PREVIEW_LIMIT) {
        return { kind: "too_large", size, limit: OFFICE_PREVIEW_LIMIT };
      }
      await ensurePreviewCache();
      const previewId = crypto.randomBytes(18).toString("base64url");
      const hostPath = path.join(previewCacheRoot, `${previewId}${path.extname(normalizedPath).toLowerCase()}`);
      try {
        await sshFileSystem.downloadFile(`preview:${previewId}`, sessionId, normalizedPath, hostPath, { totalBytes: size });
        previews.set(previewId, {
          sessionId,
          hostPath,
          size,
          kind: "office",
          format: officeType.format,
          mime: officeType.mime,
          temporary: true,
          createdAt: Date.now()
        });
        return {
          kind: "office",
          format: officeType.format,
          size,
          mime: officeType.mime,
          previewId,
          url: `${MEDIA_PROTOCOL}://preview/${encodeURIComponent(previewId)}`
        };
      } catch (error) {
        schedulePreviewFileCleanup(hostPath);
        throw error;
      }
    }
    return readText(sessionId, remotePath);
  }

  function releasePreview(previewId) {
    if (typeof previewId !== "string" || !previewId) {
      return false;
    }
    const preview = previews.get(previewId);
    if (!preview) return false;
    previews.delete(previewId);
    if (preview.temporary) schedulePreviewFileCleanup(preview.hostPath);
    return true;
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
      "Content-Length": String(contentLength),
      "X-Content-Type-Options": "nosniff"
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

  async function writeText(sessionId, remotePath, content, expectedVersion, options = {}) {
    if (typeof content !== "string" || (!options.force && (typeof expectedVersion !== "string" || !expectedVersion))) {
      throw new Error("Invalid text save request.");
    }

    const contentBuffer = encodeTextContent(content, options.format);
    if (contentBuffer.length > TEXT_PREVIEW_LIMIT) {
      throw new Error(`Text file exceeds the ${TEXT_PREVIEW_LIMIT} byte edit limit.`);
    }

    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      return writeLocalText(session, remotePath, content, expectedVersion, options);
    }
    const normalizedPath = normalizeRemotePath(remotePath);
    if (!options.force) {
      const currentStat = await sshFileSystem.stat(sessionId, normalizedPath);
      if (Number(currentStat.size || 0) > TEXT_PREVIEW_LIMIT) {
        return { status: "conflict" };
      }
      const currentData = await sshFileSystem.get(sessionId, normalizedPath);
      const currentBuffer = Buffer.isBuffer(currentData) ? currentData : Buffer.from(currentData);
      if (currentBuffer.length > TEXT_PREVIEW_LIMIT || getContentVersion(currentBuffer) !== expectedVersion) {
        return { status: "conflict" };
      }
    }

    await sshFileSystem.put(sessionId, contentBuffer, normalizedPath);
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
    await sshFileSystem.mkdir(sessionId, path.posix.dirname(normalizedPath), true);
    await sshFileSystem.put(sessionId, buffer, normalizedPath);
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
    return stat;
  }

  async function uploadValidatedFile(sessionId, session, localPath, remoteDir, conflictPolicy = "cancel", options = {}) {
    const fileName = path.basename(localPath);
    const target = await resolveConflictPath(sessionId, session, remoteDir, fileName, conflictPolicy);
    if (target.status === "conflict" || target.status === "skipped") return { status: target.status, remotePath: target.path };
    const totalBytes = Math.max(0, Number(options.totalBytes) || 0);
    const reportProgress = createTransferProgressReporter(options.onProgress, totalBytes);
    reportProgress?.(0, totalBytes, true);
    if (session.type !== "ssh") {
      if (!reportProgress) {
        await fsApi.promises.copyFile(localPath, toLocalHostPath(session, target.path));
        return { status: "completed", remotePath: target.path };
      }
      const source = fsApi.createReadStream(localPath);
      const destination = fsApi.createWriteStream(toLocalHostPath(session, target.path));
      let transferredBytes = 0;
      source.on("data", (chunk) => {
        transferredBytes += chunk.length;
        reportProgress(transferredBytes, totalBytes);
      });
      await pipeline(source, destination);
      reportProgress(totalBytes, totalBytes, true);
      return { status: "completed", remotePath: target.path };
    }
    if (reportProgress) {
      await sshFileSystem.fastPut(sessionId, localPath, target.path, {
        step: (transferredBytes, _chunk, reportedTotalBytes) => {
          reportProgress(transferredBytes, Number(reportedTotalBytes) || totalBytes);
        }
      });
      reportProgress(totalBytes, totalBytes, true);
    } else {
      await sshFileSystem.fastPut(sessionId, localPath, target.path);
    }
    return { status: "completed", remotePath: target.path };
  }

  async function uploadFile(sessionId, localPath, remoteDir, conflictPolicy = "cancel", options = {}) {
    const session = getSession(sessionId);
    const stat = await validateLocalUploadPath(localPath);
    return uploadValidatedFile(sessionId, session, localPath, remoteDir, conflictPolicy, {
      ...options,
      totalBytes: Number(stat.size) || 0
    });
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

  async function downloadFile(sessionId, remotePath, localPath, options = {}) {
    const session = getSession(sessionId);
    const transferId = String(options.transferId || crypto.randomUUID());
    if (activeDownloads.has(transferId)) {
      throw new Error("Download transfer already exists.");
    }
    const task = {
      canceled: false,
      ssh: session.type === "ssh",
      streams: [],
      rejectCanceled: null
    };
    const canceled = new Promise((_, reject) => {
      task.rejectCanceled = () => reject(Object.assign(new Error("Download canceled."), { code: "DOWNLOAD_CANCELED" }));
    });
    activeDownloads.set(transferId, task);

    const reportProgress = (transferredBytes, totalBytes) => {
      options.onProgress?.({
        transferId,
        transferredBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : null
      });
    };

    try {
      if (session.type === "ssh") {
        const normalizedPath = normalizeRemotePath(remotePath);
        await Promise.race([
          sshFileSystem.downloadFile(transferId, sessionId, normalizedPath, localPath, { onProgress: reportProgress }),
          canceled
        ]);
      } else {
        const sourcePath = toLocalHostPath(session, remotePath);
        const stat = await Promise.race([fsApi.promises.stat(sourcePath), canceled]);
        const totalBytes = Number(stat?.size) || 0;
        const source = fsApi.createReadStream(sourcePath);
        const destination = fsApi.createWriteStream(localPath);
        task.streams = [source, destination];
        let transferredBytes = 0;
        source.on("data", (chunk) => {
          transferredBytes += chunk.length;
          reportProgress(transferredBytes, totalBytes);
        });
        reportProgress(0, totalBytes);
        await Promise.race([pipeline(source, destination), canceled]);
        reportProgress(totalBytes, totalBytes);
      }
      return { localPath, transferId };
    } catch (err) {
      await Promise.all(task.streams.map((stream) => new Promise((resolve) => {
        if (stream.closed) {
          resolve();
          return;
        }
        stream.once("close", resolve);
        if (!stream.destroyed) stream.destroy();
      })));
      try {
        await fsApi.promises.rm(localPath, { force: true });
      } catch {
        // Ignore cleanup failures; preserve the original transfer error.
      }
      throw err;
    } finally {
      activeDownloads.delete(transferId);
      for (const stream of task.streams) {
        if (!stream.destroyed) stream.destroy();
      }
    }
  }

  async function cancelDownload(transferId) {
    const task = activeDownloads.get(String(transferId || ""));
    if (!task || task.canceled) return false;
    task.canceled = true;
    task.rejectCanceled?.();
    for (const stream of task.streams) {
      stream.destroy(Object.assign(new Error("Download canceled."), { code: "DOWNLOAD_CANCELED" }));
    }
    if (task.ssh) await sshFileSystem.cancelDownload(String(transferId));
    return true;
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

  async function entryExists(sessionId, session, entryPath) {
    if (session.type !== "ssh") {
      try {
        await fsApi.promises.lstat(toLocalHostPath(session, entryPath));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    }
    return sshFileSystem.exists(sessionId, normalizeRemotePath(entryPath));
  }

  async function resolveConflictPath(sessionId, session, parentPath, requestedName, conflictPolicy = "cancel") {
    let name = validateEntryName(requestedName);
    let targetPath = session.type === "ssh"
      ? joinRemotePath(normalizeRemotePath(parentPath), name)
      : joinLocalPath(session, parentPath, name);
    if (!await entryExists(sessionId, session, targetPath)) return { status: "ready", path: targetPath, name };
    if (conflictPolicy === "skip") return { status: "skipped", path: targetPath, name };
    if (conflictPolicy === "cancel") return { status: "conflict", path: targetPath, name };
    if (conflictPolicy === "rename") {
      for (let attempt = 1; attempt < 10000; attempt += 1) {
        name = autoRename(requestedName, attempt);
        targetPath = session.type === "ssh"
          ? joinRemotePath(normalizeRemotePath(parentPath), name)
          : joinLocalPath(session, parentPath, name);
        if (!await entryExists(sessionId, session, targetPath)) return { status: "ready", path: targetPath, name };
      }
      throw new Error("Unable to find an available file name.");
    }
    return { status: "overwrite", path: targetPath, name };
  }

  async function createEntry(sessionId, parentPath, name, kind, conflictPolicy = "cancel") {
    const session = getSession(sessionId);
    if (kind !== "file" && kind !== "directory") throw new Error("Invalid entry type.");
    const target = await resolveConflictPath(sessionId, session, parentPath, name, conflictPolicy);
    if (target.status === "conflict" || target.status === "skipped") return target;
    if (target.status === "overwrite") {
      if (kind === "directory") return { status: "conflict", path: target.path, name: target.name };
      await deleteEntry(sessionId, target.path, { permanent: session.type !== "windows" });
    }
    if (session.type !== "ssh") {
      const hostPath = toLocalHostPath(session, target.path);
      if (kind === "directory") await fsApi.promises.mkdir(hostPath);
      else await fsApi.promises.writeFile(hostPath, Buffer.alloc(0), { flag: "wx" });
    } else {
      if (kind === "directory") await sshFileSystem.mkdir(sessionId, target.path, false);
      else await sshFileSystem.put(sessionId, Buffer.alloc(0), target.path);
    }
    return { status: "completed", path: target.path, name: target.name };
  }

  async function moveEntry(sessionId, sourcePath, targetDirectory, requestedName, conflictPolicy = "cancel") {
    const session = getSession(sessionId);
    const sourceName = session.type === "windows" ? path.win32.basename(sourcePath) : path.posix.basename(normalizeRemotePath(sourcePath));
    const name = validateEntryName(requestedName || sourceName);
    const targetPath = session.type === "ssh"
      ? joinRemotePath(normalizeRemotePath(targetDirectory), name)
      : joinLocalPath(session, targetDirectory, name);
    if (targetPath === sourcePath) return { status: "completed", path: sourcePath, name };
    const target = await resolveConflictPath(sessionId, session, targetDirectory, name, conflictPolicy);
    if (target.status === "conflict" || target.status === "skipped") return target;
    if (target.path === sourcePath) return { status: "completed", path: sourcePath, name: target.name };
    if (target.status === "overwrite") {
      await deleteEntry(sessionId, target.path, { permanent: session.type !== "windows" });
    }
    if (session.type !== "ssh") {
      await fsApi.promises.rename(toLocalHostPath(session, sourcePath), toLocalHostPath(session, target.path));
    } else {
      await sshFileSystem.rename(sessionId, normalizeRemotePath(sourcePath), target.path);
    }
    return { status: "completed", path: target.path, name: target.name };
  }

  async function deleteEntry(sessionId, remotePath, options = {}) {
    const session = getSession(sessionId);
    if (session.type !== "ssh") {
      const hostPath = toLocalHostPath(session, remotePath);
      if (session.type === "windows" && !options.permanent && shellApi && typeof shellApi.trashItem === "function") {
        await shellApi.trashItem(hostPath);
        return { mode: "trash" };
      }
      await fsApi.promises.rm(hostPath, { recursive: true, force: true });
      return { mode: "permanent" };
    }
    const normalizedPath = normalizeRemotePath(remotePath);
    await sshFileSystem.remove(sessionId, normalizedPath);
    return { mode: "permanent" };
  }

  async function disconnect(sessionId) {
    for (const [previewId, preview] of previews) {
      if (preview.sessionId === sessionId) {
        releasePreview(previewId);
      }
    }
    await sshFileSystem?.disconnect?.(sessionId);
  }

  async function shutdown() {
    await Promise.all(Array.from(activeDownloads.keys()).map((transferId) => cancelDownload(transferId)));
    await sshFileSystem?.shutdown?.();
    for (const previewId of Array.from(previews.keys())) releasePreview(previewId);
    await Promise.all(Array.from(previewCleanupTasks));
    if (previewCacheReady) {
      await previewCacheReady.catch(() => undefined);
      await fsApi.promises.rm(previewCacheRoot, { recursive: true, force: true }).catch(() => undefined);
    }
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
    cancelDownload,
    openInExplorer,
    createEntry,
    moveEntry,
    deleteEntry,
    initializePreviewCache: ensurePreviewCache,
    disconnect,
    shutdown
  };
}

module.exports = {
  TEXT_PREVIEW_LIMIT,
  OFFICE_PREVIEW_LIMIT,
  MEDIA_PROTOCOL,
  normalizeWslPath,
  toWslHostPath,
  getPreviewTokenFromUrl,
  parseRangeHeader,
  createRemoteFileService
};
