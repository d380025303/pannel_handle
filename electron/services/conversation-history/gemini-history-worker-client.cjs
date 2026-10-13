const path = require("node:path");
const { Worker } = require("node:worker_threads");

let worker;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  const current = new Worker(path.join(__dirname, "gemini-history-worker.cjs"));
  worker = current;
  const fail = error => {
    if (worker !== current) return;
    worker = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    current.unref();
  };
  current.on("message", ({ id, chunk, error }) => {
    const request = pending.get(id);
    if (!request) return;
    if (chunk) {
      request.messages.push(...chunk);
      return;
    }
    pending.delete(id);
    if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
    else request.resolve(request.messages);
    if (!pending.size) current.unref();
  });
  current.on("error", fail);
  current.on("exit", code => fail(new Error(`Gemini history Worker exited (${code}).`)));
  current.unref();
  return current;
}

function parseGeminiTranscript(input) {
  return new Promise((resolve, reject) => {
    const current = getWorker();
    const id = ++nextId;
    pending.set(id, { resolve, reject, messages: [] });
    current.ref();
    try {
      // Transfer bytes instead of cloning a whole UTF-16 transcript on the main thread.
      const bytes = typeof input.text === "string" ? Buffer.from(input.text, "utf-8") : input.text;
      const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes : Uint8Array.from(bytes);
      current.postMessage({ id, filePath: input.filePath, bytes: owned }, [owned.buffer]);
    } catch (error) {
      pending.delete(id);
      if (!pending.size) current.unref();
      reject(error);
    }
  });
}

module.exports = { parseGeminiTranscript };
