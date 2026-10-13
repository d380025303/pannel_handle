const SftpClient = require("ssh2-sftp-client");

function createSshFileSystem({ sshSessionRuntime, sftpFactory = () => new SftpClient() }) {
  if (!sshSessionRuntime) throw new Error("SSH runtime is unavailable.");
  const clients = new Map();
  const downloads = new Map();
  const connecting = new Map();
  let stopped = false;

  const noConnection = error => /No SFTP connection available/i.test(error?.message || "");
  const connectionError = error => noConnection(error)
    || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTCONN"].includes(error?.code)
    || /Unexpected (?:end|close) event/i.test(error?.message || "");
  const readMethods = new Set(["stat", "get", "readBuffer", "list", "cwd", "exists"]);
  const singleRequestWrites = new Set(["put", "fastPut", "rename", "chmod", "delete"]);

  async function closeClient(client) {
    try { await client.end(); } catch { /* best effort */ }
  }

  function invalidate(sessionId, entry) {
    entry.invalid = true;
    if (clients.get(sessionId) === entry) clients.delete(sessionId);
    if (!entry.closing) entry.closing = Promise.resolve().then(() => closeClient(entry.client));
  }

  async function getClient(sessionId) {
    if (stopped) throw new Error("SSH file system is shut down.");
    const cached = clients.get(sessionId);
    if (cached) {
      if (!("sftp" in cached.client) || cached.client.sftp) return cached;
      invalidate(sessionId, cached);
    }
    if (connecting.has(sessionId)) return connecting.get(sessionId).promise;
    const pending = { canceled: false };
    pending.promise = (async () => {
      const client = await sshSessionRuntime.createSftpClient(sessionId);
      if (pending.canceled || stopped) {
        await closeClient(client);
        throw new Error("SSH file connection was canceled.");
      }
      const entry = { client, invalid: false };
      // Observe the underlying transport without changing ssh2-sftp-client's event flags.
      const transport = client.client || client;
      if (typeof transport.on === "function") {
        const onInvalid = () => invalidate(sessionId, entry);
        for (const event of ["error", "end", "close"]) transport.on(event, onInvalid);
      }
      clients.set(sessionId, entry);
      return entry;
    })().finally(() => {
      if (connecting.get(sessionId) === pending) connecting.delete(sessionId);
    });
    connecting.set(sessionId, pending);
    return pending.promise;
  }

  async function readBuffer(client, remotePath, maxBytes) {
    const chunks = [];
    let size = 0;
    // end is inclusive: read one extra byte to detect growth after stat,
    // while bounding both transport traffic and retained buffers.
    const stream = client.createReadStream(remotePath, { end: maxBytes, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("Remote file exceeds the read limit.");
        error.code = "FILE_TOO_LARGE";
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  async function call(sessionId, method, ...args) {
    let entry = await getClient(sessionId);
    for (let attempt = 0; ; attempt++) {
      try {
        return await (method === "readBuffer"
          ? readBuffer(entry.client, ...args) : entry.client[method](...args));
      } catch (error) {
        if (!connectionError(error)) throw error;
        invalidate(sessionId, entry);
        // Never replay mutations after a request may have reached the server.
        if (attempt || (!readMethods.has(method) && !(singleRequestWrites.has(method) && noConnection(error)))
          || entry.canceled || stopped) throw error;
        entry = await getClient(sessionId);
      }
    }
  }

  async function exists(sessionId, remotePath) {
    const { client } = await getClient(sessionId);
    if (typeof client.exists === "function") return Boolean(await call(sessionId, "exists", remotePath));
    try { await call(sessionId, "stat", remotePath); return true; } catch (error) {
      if (error.code === 2 || error.code === "ENOENT") return false;
      throw error;
    }
  }

  async function remove(sessionId, remotePath) {
    const stat = await call(sessionId, "stat", remotePath);
    const directory = typeof stat.isDirectory === "function" ? stat.isDirectory() : stat.isDirectory;
    if (directory) await call(sessionId, "rmdir", remotePath, true);
    else await call(sessionId, "delete", remotePath);
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
    const pending = connecting.get(sessionId);
    if (pending) pending.canceled = true;
    connecting.delete(sessionId);
    const entry = clients.get(sessionId);
    clients.delete(sessionId);
    if (entry) {
      entry.canceled = true;
      invalidate(sessionId, entry);
      await entry.closing;
    }
  }

  async function shutdown() {
    stopped = true;
    await Promise.all(Array.from(downloads.keys()).map(cancelDownload));
    await Promise.all(Array.from(new Set([...clients.keys(), ...connecting.keys()])).map(disconnect));
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
    get: (sessionId, remotePath, options) => {
      if (options?.maxBytes === undefined) return call(sessionId, "get", remotePath);
      if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
        return Promise.reject(new Error("Invalid remote file read limit."));
      }
      return call(sessionId, "readBuffer", remotePath, options.maxBytes);
    },
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
