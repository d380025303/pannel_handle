const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const SftpClient = require("ssh2-sftp-client");
const { buildSsh2ConnectionConfig } = require("./ssh2-connection.cjs");

const TEXT_PREVIEW_LIMIT = 1024 * 1024;

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

function createRemoteFileService({ terminalManager, sessionStore, knownHostStore, sftpFactory = () => new SftpClient(), fsApi = fs }) {
  const clients = new Map();

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

  function getSecret(sshConfig) {
    if (!sshConfig?.encryptedSecret || typeof sessionStore.decryptSecret !== "function") {
      return undefined;
    }
    return sessionStore.decryptSecret(sshConfig.encryptedSecret);
  }

  function buildConnectionConfig(session) {
    const sshConfig = session.sshConfig || {};
    const secret = getSecret(sshConfig);
    return buildSsh2ConnectionConfig({ sshConfig, secret, knownHostStore });
  }

  async function getClient(sessionId) {
    getSession(sessionId);
    const cached = clients.get(sessionId);
    if (cached) {
      return cached;
    }

    const session = getSession(sessionId);
    const client = sftpFactory();
    await client.connect(buildConnectionConfig(session));
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

  async function uploadFile(sessionId, localPath, remoteDir) {
    const session = getSession(sessionId);
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

  async function disconnect(sessionId) {
    const client = clients.get(sessionId);
    clients.delete(sessionId);
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
  }

  return {
    getHome,
    list,
    readText,
    writeText,
    uploadFile,
    downloadFile,
    disconnect,
    shutdown
  };
}

module.exports = {
  TEXT_PREVIEW_LIMIT,
  normalizeWslPath,
  toWslHostPath,
  createRemoteFileService
};
