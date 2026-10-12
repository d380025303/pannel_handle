const { Worker } = require("node:worker_threads");
const path = require("node:path");
const { getLineMatches } = require("./search-matching.cjs");
const { SEARCH_TIMEOUT_MS } = require("./search-limits.cjs");
const { throwIfCancelled, createProcessError } = require("./search-task.cjs");

async function runTextQuerySearch(task, options, search, timeoutMs = SEARCH_TIMEOUT_MS) {
  throwIfCancelled(task);
  if (!options.regex) return search(getLineMatches);

  const worker = new Worker(path.join(__dirname, "text-query-worker.cjs"));
  let pending;
  let failure;
  let rejectFailure;
  const failed = new Promise((resolve, reject) => { rejectFailure = reject; });
  const fail = (error) => {
    if (failure) return;
    failure = error;
    pending?.reject(error);
    pending = undefined;
    rejectFailure(error);
  };
  task.cancelMatching = () => {
    fail(createProcessError("Project search was cancelled.", "SEARCH_CANCELLED"));
    void worker.terminate();
  };
  worker.on("message", (message) => {
    if (message.error) return fail(new Error(message.error));
    pending?.resolve(message.matches);
    pending = undefined;
  });
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`Text search worker exited unexpectedly (${code}).`)));
  const timer = setTimeout(() => {
    task.timedOut = true;
    fail(createProcessError(`Text regex search timed out after ${timeoutMs}ms.`, "SEARCH_TIMEOUT"));
    task.child?.kill();
    void worker.terminate();
  }, timeoutMs);
  const matches = (content, query, limit, matchOptions) => {
    throwIfCancelled(task);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      worker.postMessage({ content, query, limit, options: matchOptions });
    });
  };
  try {
    return await Promise.race([failed, search(matches)]);
  } finally {
    clearTimeout(timer);
    task.cancelMatching = null;
    await worker.terminate();
  }
}

module.exports = { runTextQuerySearch };
