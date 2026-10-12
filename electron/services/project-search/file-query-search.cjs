const { Worker } = require("node:worker_threads");
const path = require("node:path");
const { matchesFileQuery } = require("./search-matching.cjs");
const { SEARCH_TIMEOUT_MS } = require("./search-limits.cjs");

async function runFileQuerySearch(query, options, search, timeoutMs = SEARCH_TIMEOUT_MS) {
  if (!options.regex || !query) {
    return search((name, relativePath) => !query
      || matchesFileQuery(name, query, options)
      || matchesFileQuery(relativePath, query, options));
  }

  const worker = new Worker(path.join(__dirname, "file-query-worker.cjs"), {
    workerData: { query, caseSensitive: Boolean(options.caseSensitive) }
  });
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
  worker.on("message", (message) => {
    if (message.error) {
      fail(new Error(message.error));
      return;
    }
    pending?.resolve(message.matches);
    pending = undefined;
  });
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`File search worker exited unexpectedly (${code}).`)));
  const timer = setTimeout(() => {
    const error = new Error(`File regex search timed out after ${timeoutMs}ms.`);
    error.code = "SEARCH_TIMEOUT";
    fail(error);
    void worker.terminate();
  }, timeoutMs);
  const matches = (name, relativePath) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      worker.postMessage([name, relativePath]);
    });
  };
  try {
    return await Promise.race([failed, search(matches)]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

module.exports = { runFileQuerySearch };
