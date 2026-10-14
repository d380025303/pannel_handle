const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const archiver = require("archiver");

const TICKET_MS = 60_000;
const LIST_CONCURRENCY = 8;
const ROOT_CONCURRENCY = 4;
const ARCHIVE_PENDING_LIMIT = 32;

function createMobileFiles({ fsApi = fs, pathApi = path.win32, now = () => Date.now(), getRoots } = {}) {
  const tickets = new Map();
  const active = new Map();
  const roots = getRoots || (async () => {
    const found = new Array(26);
    let nextIndex = 0;
    async function checkDrives() {
      while (nextIndex < found.length) {
        const index = nextIndex++;
        const drive = `${String.fromCharCode(65 + index)}:\\`;
        try {
          if ((await fsApi.promises.stat(drive)).isDirectory()) found[index] = drive;
        } catch { /* Drive unavailable. */ }
      }
    }
    await Promise.all(Array.from({ length: ROOT_CONCURRENCY }, checkDrives));
    return found.filter(Boolean);
  });
  const key = value => process.platform === "win32" ? value.toLowerCase() : value;

  async function safePath(value, allowedRoots, validatedParent, isCancelled = () => false) {
    const checkCancelled = () => { if (isCancelled()) throw new Error("目录读取已取消。"); };
    checkCancelled();
    if (typeof value !== "string" || !value || value.includes("\0") || !pathApi.isAbsolute(value)
      || value.startsWith("\\\\") || value.startsWith("//")) throw new Error("文件路径无效。");
    const target = pathApi.resolve(value);
    const allowed = allowedRoots || (await roots()).map(root => pathApi.resolve(root));
    const root = allowed.find(item => key(target) === key(item) || key(target).startsWith(key(item.endsWith(pathApi.sep) ? item : `${item}${pathApi.sep}`)));
    if (!root) throw new Error("此位置不属于可访问的本地磁盘。");
    // Listing and archive traversal supply a parent validated within the same request.
    if (validatedParent && key(pathApi.dirname(target)) !== key(validatedParent)) {
      throw new Error("文件路径无效。");
    }
    const relative = pathApi.relative(validatedParent || root, target);
    let current = validatedParent || root;
    for (const part of relative ? relative.split(pathApi.sep) : []) {
      current = pathApi.join(current, part);
      const info = await fsApi.promises.lstat(current);
      checkCancelled();
      if (info.isSymbolicLink()) throw new Error("不能访问符号链接或目录联接。");
    }
    const actual = await fsApi.promises.realpath(target);
    checkCancelled();
    if (key(pathApi.resolve(actual)) !== key(target)) throw new Error("不能访问重定向的文件路径。");
    const info = await fsApi.promises.stat(target);
    checkCancelled();
    return { target, info };
  }

  async function list(directory, socket) {
    let cancelled = false;
    const operation = { cancel() { cancelled = true; } };
    let operations;
    if (socket) {
      operations = active.get(socket);
      if (!operations) { operations = new Set(); active.set(socket, operations); }
      operations.add(operation);
    }
    const isCancelled = () => cancelled || (socket && !socket.authenticated);
    try {
      if (isCancelled()) return;
      return await scanDirectory(directory, isCancelled);
    } catch (error) {
      if (!isCancelled()) throw error;
    } finally {
      operations?.delete(operation);
      if (operations && !operations.size && active.get(socket) === operations) active.delete(socket);
    }
  }

  async function scanDirectory(directory, isCancelled) {
    const availableRoots = await roots();
    if (isCancelled()) return;
    if (directory == null) return { path: null, entries: availableRoots.map(root => ({ name: root, path: root, type: "drive", size: null })) };
    const allowed = availableRoots.map(root => pathApi.resolve(root));
    const { target, info } = await safePath(directory, allowed, undefined, isCancelled);
    if (isCancelled()) return;
    if (!info.isDirectory()) throw new Error("此路径不是文件夹。");
    const names = await fsApi.promises.readdir(target);
    if (isCancelled()) return;
    const entries = [];
    let nextIndex = 0;
    async function validateEntries() {
      while (!isCancelled() && nextIndex < names.length) {
        const name = names[nextIndex++];
        const child = pathApi.join(target, name);
        try {
          const item = await safePath(child, allowed, target, isCancelled);
          if (isCancelled()) return;
          if (item.info.isDirectory() || item.info.isFile()) entries.push({ name, path: child,
            type: item.info.isDirectory() ? "directory" : "file", size: item.info.isFile() ? item.info.size : null });
        } catch { /* Unreadable entries and links are omitted. */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, names.length) }, validateEntries));
    if (isCancelled()) return;
    entries.sort((a, b) => (a.type === "directory" ? 0 : 1) - (b.type === "directory" ? 0 : 1) || a.name.localeCompare(b.name));
    return { path: target, entries };
  }

  async function prepare(socket, filePath) {
    if (!socket.authenticated) throw new Error("请先连接电脑。");
    const { target, info } = await safePath(filePath);
    if (!info.isFile() && !info.isDirectory()) throw new Error("只能下载文件或文件夹。");
    for (const [id, entry] of tickets) if (entry.socket === socket) tickets.delete(id);
    const id = crypto.randomUUID();
    const ticket = crypto.randomBytes(32).toString("hex");
    tickets.set(id, { socket, path: target, ticket, expiresAt: now() + TICKET_MS });
    return { url: `/api/v1/download/${id}?ticket=${ticket}` };
  }

  async function addDirectory(archive, directory, prefix, isCancelled, allowedRoots, enqueue) {
    if (isCancelled()) return;
    const names = await fsApi.promises.readdir(directory);
    if (isCancelled()) return;
    if (!names.length) await enqueue(() => archive.append(Buffer.alloc(0), { name: `${prefix}/` }));
    for (const name of names) {
      if (isCancelled()) return;
      const child = pathApi.join(directory, name);
      let info;
      try { ({ info } = await safePath(child, allowedRoots, directory)); }
      catch (error) {
        if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT"
          || /符号链接|重定向/.test(error.message)) continue;
        throw error;
      }
      if (isCancelled()) return;
      const archiveName = `${prefix}/${name}`.replace(/\\/g, "/");
      if (info.isDirectory()) await addDirectory(archive, child, archiveName, isCancelled, allowedRoots, enqueue);
      else if (info.isFile()) await enqueue(() => archive.file(child, { name: archiveName }));
    }
  }

  async function download(request, response, id, ticket) {
    const entry = tickets.get(id);
    if (!entry || entry.ticket !== ticket || entry.expiresAt <= now() || !entry.socket.authenticated
      || request.socket?.remoteAddress !== entry.socket.remoteAddress) {
      response.writeHead(403, { "Cache-Control": "no-store" }); response.end(); return;
    }
    tickets.delete(id);
    let stream;
    let cancelled = false;
    let wakeArchive;
    let responses = active.get(entry.socket);
    if (!responses) { responses = new Set(); active.set(entry.socket, responses); }
    const transfer = { cancel() { cancelled = true; wakeArchive?.(); stream?.abort?.(); stream?.destroy?.(); response.destroy(); } };
    responses.add(transfer);
    response.on("close", () => {
      cancelled = true;
      wakeArchive?.();
      stream?.abort?.();
      stream?.destroy?.();
      responses.delete(transfer);
      if (!responses.size && active.get(entry.socket) === responses) active.delete(entry.socket);
    });
    const isCancelled = () => cancelled || response.destroyed || !entry.socket.authenticated;
    let target;
    let info;
    let allowedRoots;
    try {
      allowedRoots = (await roots()).map(root => pathApi.resolve(root));
      ({ target, info } = await safePath(entry.path, allowedRoots));
    }
    catch (error) {
      if (isCancelled()) { transfer.cancel(); return; }
      response.writeHead(404, { "Cache-Control": "no-store" }); response.end(error.message); return;
    }
    if (isCancelled()) { transfer.cancel(); return; }
    const filename = `${pathApi.basename(target) || "drive"}${info.isDirectory() ? ".zip" : ""}`;
    const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    response.writeHead(200, {
      "Content-Type": info.isDirectory() ? "application/zip" : "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      ...(info.isFile() ? { "Content-Length": info.size } : {})
    });
    if (info.isDirectory()) {
      stream = archiver("zip", { zlib: { level: 6 }, forceZip64: true });
      // Share the entry budget across the entire recursive traversal.
      let pending = 0;
      const consumed = () => { pending--; wakeArchive?.(); };
      stream.on("entry", consumed);
      // Stat warnings skip queued files without emitting an entry event.
      stream.on("warning", consumed);
      stream.on("error", () => transfer.cancel());
      const enqueue = async submit => {
        while (pending >= ARCHIVE_PENDING_LIMIT && !isCancelled()) {
          await new Promise(resolve => { wakeArchive = resolve; });
          wakeArchive = undefined;
        }
        if (isCancelled()) return;
        pending++;
        submit();
      };
      stream.pipe(response);
      try {
        await addDirectory(stream, target, pathApi.basename(target) || "drive", isCancelled, allowedRoots, enqueue);
        if (isCancelled()) { transfer.cancel(); return; }
        await stream.finalize();
      }
      catch { transfer.cancel(); }
      finally {
        wakeArchive = undefined;
        stream.removeListener("entry", consumed);
        stream.removeListener("warning", consumed);
      }
    } else {
      stream = fsApi.createReadStream(target);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    }
  }

  function releaseSocket(socket) {
    for (const [id, entry] of tickets) if (entry.socket === socket) tickets.delete(id);
    for (const transfer of active.get(socket) || []) transfer.cancel();
    active.delete(socket);
  }
  function stop() { tickets.clear(); for (const socket of active.keys()) releaseSocket(socket); }
  return { list, prepare, download, releaseSocket, stop };
}

module.exports = { createMobileFiles };
