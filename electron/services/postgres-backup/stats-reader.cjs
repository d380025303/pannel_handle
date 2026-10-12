const path = require("node:path");
const { Worker } = require("node:worker_threads");

async function* readStatsBatches(options) {
  const worker = new Worker(path.join(__dirname, "stats-reader-worker.cjs"), { workerData: options });
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
    await worker.terminate();
  }
}

module.exports = { readStatsBatches };
