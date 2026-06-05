const fs = require("node:fs");
const path = require("node:path");
const SftpClient = require("ssh2-sftp-client");

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

function createRemoteFileService({ terminalManager, sessionStore, sftpFactory = () => new SftpClient() }) {
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
    const host = String(sshConfig.host || "").trim();
    if (!host) {
      throw new Error("SSH host is required.");
    }
    if (Array.isArray(sshConfig.extraArgs) && sshConfig.extraArgs.length > 0) {
      throw new Error("Remote file panel does not support SSH extra arguments yet.");
    }

    const config = {
      host,
      port: Number(sshConfig.port || 22),
      username: String(sshConfig.username || "").trim() || undefined,
      readyTimeout: 15000
    };
    const secret = getSecret(sshConfig);
    const identityFile = String(sshConfig.identityFile || "").trim();
    if (identityFile) {
      config.privateKey = fs.readFileSync(identityFile);
      if (secret) {
        config.passphrase = secret;
      }
    } else if (secret) {
      config.password = secret;
    }
    return config;
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
    if (isLikelyBinary(buffer)) {
      return { kind: "binary", size };
    }
    return {
      kind: "text",
      size,
      content: buffer.toString("utf-8")
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
