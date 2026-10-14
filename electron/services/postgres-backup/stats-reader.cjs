const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Worker } = require("node:worker_threads");

async function* readStatsBatches(options) {
  // The parent owns cleanup even when the worker is terminated during snapshot creation.
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-stats-snapshot-"));
  let worker;
  try {
    worker = new Worker(path.join(__dirname, "stats-reader-worker.cjs"), {
      workerData: { ...options, snapshotFile: path.join(snapshotDir, "batches.bin") }
    });
  } catch (error) {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
  let failure;
  let waiter;
  worker.on("error", error => { failure = error; waiter?.reject(error); });
  worker.on("exit", code => {
    failure ||= new Error(`Statistics reader exited before completion (code ${code}).`);
    waiter?.reject(failure);
  });
  worker.on("message", message => waiter?.resolve(message));
  try {
    while (true) {
      if (failure) throw failure;
      const message = await new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        worker.postMessage("next");
      });
      waiter = null;
      if (message.done) return;
      yield message.batch;
    }
  } finally {
    waiter = null;
    try { await worker.terminate(); }
    finally { fs.rmSync(snapshotDir, { recursive: true, force: true }); }
  }
}

module.exports = { readStatsBatches };
