const path = require("node:path");
const { Worker } = require("node:worker_threads");

function checkBusinessIntegrity(databaseFile) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "business-integrity-worker.cjs"), { workerData: { databaseFile } });
    let result;
    worker.once("message", message => { result = message; });
    worker.once("error", reject);
    // Wait for exit as well so the connection and Worker are gone before startup continues.
    worker.once("exit", code => {
      if (code !== 0 || !result) reject(new Error(`Business integrity Worker exited unexpectedly (${code}).`));
      else if (result.error) reject(new Error(result.error));
      else if (result.ok === true) resolve();
      else reject(new Error("Business integrity Worker returned an invalid result."));
    });
  });
}

module.exports = { checkBusinessIntegrity };
