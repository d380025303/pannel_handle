const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const TICKET_MS = 5 * 60 * 1000;
const FILE_MS = 24 * 60 * 60 * 1000;

function createMobileUploads({ now = () => Date.now() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-handle-mobile-"));
  const entries = new Map();
  const safeName = name => {
    const value = path.basename(String(name || "").replace(/[\\/]/g, "_")).replace(/[\x00-\x1f<>:"|?*]/g, "_").slice(0, 180);
    return value && value !== "." && value !== ".." ? value : "attachment";
  };
  const deleteDirectory = entry => {
    const directory = path.dirname(entry.path);
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch {
      const retry = setTimeout(() => {
        try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
      }, 1000);
      retry.unref?.();
    }
  };
  const remove = id => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    deleteDirectory(entry);
  };
  const sweep = () => { for (const [id, entry] of entries) if (entry.expiresAt <= now()) remove(id); };
  let timer = null;
  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(sweep, 60_000);
    timer.unref?.();
  };
  function prepare(socket, sessionId, threadId, name, size) {
    sweep();
    ensureTimer();
    fs.mkdirSync(root, { recursive: true });
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error("附件必须在 10 MB 以内。");
    const count = [...entries.values()].filter(entry => entry.socket === socket && !entry.consumed).length;
    if (count >= MAX_FILES) throw new Error("最多附加 10 个文件。");
    const id = crypto.randomUUID();
    const ticket = crypto.randomBytes(32).toString("hex");
    const directory = path.join(root, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = { id, ticket, socket, sessionId, threadId, name: safeName(name), size,
      path: path.join(directory, safeName(name)), state: "prepared", consumed: false, expiresAt: now() + TICKET_MS };
    entries.set(id, entry);
    return { fileId: id, url: `/api/v1/upload/${id}?ticket=${ticket}` };
  }
  async function receive(request, response, id, ticket) {
    const entry = entries.get(id);
    if (!entry || entry.ticket !== ticket || entry.state !== "prepared" || entry.expiresAt <= now()
      || !entry.socket.authenticated || entry.socket.graphicalSessionId !== entry.sessionId) {
      response.writeHead(403); response.end(); return;
    }
    entry.state = "uploading";
    let bytes = 0;
    try {
      await pipeline(request, new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_FILE_BYTES || bytes > entry.size ? new Error("附件超过大小限制。") : null, chunk);
      } }), fs.createWriteStream(entry.path, { flags: "wx", mode: 0o600 }));
      if (entries.get(id) !== entry) throw new Error("附件上传已取消。");
      if (bytes !== entry.size) throw new Error("附件大小与声明不符。");
      entry.state = "ready";
      entry.ticket = null;
      entry.expiresAt = now() + FILE_MS;
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ fileId: id, name: entry.name }));
    } catch (error) {
      remove(id);
      deleteDirectory(entry);
      if (!response.headersSent) { response.writeHead(400); response.end(error.message); }
      else response.destroy();
    }
  }
  function paths(socket, sessionId, threadId, ids) {
    if (!Array.isArray(ids) || ids.length > MAX_FILES || new Set(ids).size !== ids.length) throw new Error("附件列表无效。");
    return ids.map(id => {
      const entry = entries.get(id);
      if (!entry || entry.state !== "ready" || entry.consumed || entry.socket !== socket
        || entry.sessionId !== sessionId || entry.threadId !== threadId || entry.expiresAt <= now())
        throw new Error("附件已失效，请重新上传。");
      return entry.path;
    });
  }
  function consume(ids) { for (const id of ids) { const entry = entries.get(id); if (entry) entry.consumed = true; } }
  function discard(socket, ids) { for (const id of ids) if (entries.get(id)?.socket === socket && !entries.get(id).consumed) remove(id); }
  function releaseSocket(socket) { for (const [id, entry] of entries) if (entry.socket === socket && !entry.consumed) remove(id); }
  function releaseSession(sessionId) { for (const [id, entry] of entries) if (entry.sessionId === sessionId) remove(id); }
  function stop() { if (timer) clearInterval(timer); timer = null; for (const id of [...entries.keys()]) remove(id); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
  return { prepare, receive, paths, consume, discard, releaseSocket, releaseSession, stop };
}

module.exports = { createMobileUploads, MAX_FILE_BYTES, MAX_FILES };
