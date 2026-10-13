const path = require("node:path");
const { Worker } = require("node:worker_threads");

let worker;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  const current = new Worker(path.join(__dirname, "opencode-history-worker.cjs"));
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
  current.on("exit", code => fail(new Error(`OpenCode history Worker exited (${code}).`)));
  current.unref();
  return current;
}

function readOpenCodeHistory(input) {
  return new Promise((resolve, reject) => {
    const current = getWorker();
    const id = ++nextId;
    pending.set(id, { resolve, reject, messages: [] });
    current.ref();
    try {
      current.postMessage({ id, input });
    } catch (error) {
      pending.delete(id);
      if (!pending.size) current.unref();
      reject(error);
    }
  });
}

module.exports = { readOpenCodeHistory };
