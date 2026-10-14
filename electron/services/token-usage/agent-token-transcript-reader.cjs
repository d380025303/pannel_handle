const { Worker } = require("node:worker_threads");
const path = require("node:path");

// Only the small aggregate returns from the worker. Each read exits after
// replying, including failed reads.
function parseInWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "agent-token-transcript-worker.cjs"), {
      workerData
    });
    let replied = false;
    worker.once("message", message => {
      replied = true;
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        if (message.error.code) error.code = message.error.code;
        reject(error);
      } else resolve(message.result);
    });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (!replied) reject(new Error(`Transcript worker exited before replying (code ${code}).`));
    });
  });
}

function parseTranscriptFileAsync(provider, transcriptPath) {
  return parseInWorker({ provider, transcriptPath });
}

function parseRemoteTranscriptAsync(provider, remoteResponse) {
  return parseInWorker({ provider, remoteResponse });
}

module.exports = { parseTranscriptFileAsync, parseRemoteTranscriptAsync };
