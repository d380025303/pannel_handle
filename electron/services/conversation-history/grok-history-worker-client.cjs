const path = require("node:path");
const { Worker } = require("node:worker_threads");

let worker;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  const current = new Worker(path.join(__dirname, "grok-history-worker.cjs"));
  worker = current;
  const fail = error => {
    if (worker !== current) return;
    worker = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    current.unref();
  };
  current.on("message", ({ id, messages, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
    else request.resolve(messages);
    if (!pending.size) current.unref();
  });
  current.on("error", fail);
  current.on("exit", code => fail(new Error(`Grok history Worker exited (${code}).`)));
  current.unref();
  return current;
}

function readGrokTranscript(input) {
  return new Promise((resolve, reject) => {
    const current = getWorker();
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    current.ref();
    try {
      current.postMessage({ id, ...input });
    } catch (error) {
      pending.delete(id);
      if (!pending.size) current.unref();
      reject(error);
    }
  });
}

module.exports = { readGrokTranscript };
