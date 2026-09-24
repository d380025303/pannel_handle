const SftpClient = require("ssh2-sftp-client");

function createSshFileSystem({ sshSessionRuntime, sftpFactory = () => new SftpClient() }) {
  if (!sshSessionRuntime) throw new Error("SSH runtime is unavailable.");
  const clients = new Map();
  const downloads = new Map();

  async function getClient(sessionId) {
    if (clients.has(sessionId)) return clients.get(sessionId);
    const client = await sshSessionRuntime.createSftpClient(sessionId);
    clients.set(sessionId, client);
    return client;
  }

  async function call(sessionId, method, ...args) {
    const client = await getClient(sessionId);
    return client[method](...args);
  }

  async function exists(sessionId, remotePath) {
    const client = await getClient(sessionId);
    if (typeof client.exists === "function") return Boolean(await client.exists(remotePath));
    try { await client.stat(remotePath); return true; } catch { return false; }
  }

  async function remove(sessionId, remotePath) {
    const client = await getClient(sessionId);
    try { await client.rmdir(remotePath, true); } catch { await client.delete(remotePath); }
  }

  async function downloadFile(transferId, sessionId, remotePath, localPath, options = {}) {
    const client = sftpFactory();
    const task = { client, canceled: false };
    downloads.set(transferId, task);
    try {
      await sshSessionRuntime.createSftpClient(sessionId, { sftp: client });
      if (task.canceled) throw new Error("Download canceled.");
      const stat = Number.isFinite(options.totalBytes) ? null : await client.stat(remotePath);
      const totalBytes = Number.isFinite(options.totalBytes) ? options.totalBytes : Number(stat?.size) || 0;
      options.onProgress?.(0, totalBytes);
      const fastGetOptions = options.onProgress ? {
        step: (transferredBytes, _chunk, reportedTotalBytes) => {
          if (task.canceled) return;
          options.onProgress(transferredBytes, Number(reportedTotalBytes) || totalBytes);
        }
      } : undefined;
      if (typeof client.fastGet === "function") {
        if (fastGetOptions) await client.fastGet(remotePath, localPath, fastGetOptions);
        else await client.fastGet(remotePath, localPath);
      } else {
        await client.get(remotePath, localPath);
      }
      if (task.canceled) throw new Error("Download canceled.");
      options.onProgress?.(totalBytes, totalBytes);
    } finally {
      downloads.delete(transferId);
      try { await client.end(); } catch { /* best effort */ }
    }
  }

  async function cancelDownload(transferId) {
    const task = downloads.get(transferId);
    if (!task) return false;
    task.canceled = true;
    try { await task.client.end(); } catch { /* best effort */ }
    return true;
  }

  async function disconnect(sessionId) {
    const client = clients.get(sessionId);
    clients.delete(sessionId);
    if (client) {
      try { await client.end(); } catch { /* best effort */ }
    }
  }

  async function shutdown() {
    await Promise.all(Array.from(downloads.keys()).map(cancelDownload));
    await Promise.all(Array.from(clients.keys()).map(disconnect));
  }

  return {
    cancelDownload,
    chmod: (sessionId, remotePath, mode) => call(sessionId, "chmod", remotePath, mode),
    cwd: sessionId => call(sessionId, "cwd"),
    disconnect,
    downloadFile,
    exists,
    fastPut: (sessionId, localPath, remotePath, options) => options
      ? call(sessionId, "fastPut", localPath, remotePath, options)
      : call(sessionId, "fastPut", localPath, remotePath),
    get: (sessionId, remotePath) => call(sessionId, "get", remotePath),
    list: (sessionId, remotePath) => call(sessionId, "list", remotePath),
    mkdir: (sessionId, remotePath, recursive) => call(sessionId, "mkdir", remotePath, recursive),
    put: (sessionId, input, remotePath) => call(sessionId, "put", input, remotePath),
    remove,
    rename: (sessionId, sourcePath, targetPath) => call(sessionId, "rename", sourcePath, targetPath),
    shutdown,
    stat: (sessionId, remotePath) => call(sessionId, "stat", remotePath)
  };
}

module.exports = { createSshFileSystem };
