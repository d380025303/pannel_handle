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

function createRemoteFileService({ terminalManager, sessionStore, knownHostStore, sftpFactory = () => new SftpClient() }) {
  const clients = new Map();

  function getSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }
    if (session.type !== "ssh") {
      throw new Error("Remote files are only available for SSH sessions.");
    }
    return session;
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

  async function getHome(sessionId) {
    const client = await getClient(sessionId);
    return normalizeRemotePath(await client.cwd());
  }

  async function list(sessionId, remotePath = ".") {
    const client = await getClient(sessionId);
    const normalizedPath = normalizeRemotePath(remotePath);
    const entries = await client.list(normalizedPath);
    return entries
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
      .sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });
  }

  async function readText(sessionId, remotePath) {
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
      throw new Error("Invalid remote text save request.");
    }

    const contentBuffer = Buffer.from(content, "utf-8");
    if (contentBuffer.length > TEXT_PREVIEW_LIMIT) {
      throw new Error(`Text file exceeds the ${TEXT_PREVIEW_LIMIT} byte edit limit.`);
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
    const client = await getClient(sessionId);
    const fileName = path.basename(localPath);
    const remotePath = joinRemotePath(normalizeRemotePath(remoteDir), fileName);
    await client.fastPut(localPath, remotePath);
    return { remotePath };
  }

  async function downloadFile(sessionId, remotePath, localPath) {
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
  createRemoteFileService
};
