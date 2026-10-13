const { Worker } = require("node:worker_threads");
const path = require("node:path");
const { matchesFileQuery } = require("./search-matching.cjs");
const { SEARCH_TIMEOUT_MS, MAX_FILE_RESULTS } = require("./search-limits.cjs");

async function runFileQuerySearch(query, options, search, timeoutMs = SEARCH_TIMEOUT_MS) {
  if (!options.regex || !query) {
    return search((entries, limit) => {
      const indices = [];
      for (let index = 0; index < entries.length && indices.length < limit; index += 1) {
        const { name, relativePath } = entries[index];
        if (!query || matchesFileQuery(name, query, options) || matchesFileQuery(relativePath, query, options)) {
          indices.push(index);
        }
      }
      return indices;
    });
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
  const matches = (entries, limit) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      worker.postMessage({ entries: entries.map(({ name, relativePath }) => [name, relativePath]), limit });
    });
  };
  try {
    return await Promise.race([failed, search(matches)]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

// Keep traversal streaming and preserve its order without a Worker round trip per entry.
function createFileQueryCollector(matches, results, batchSize) {
  let entries = [];
  const flush = async () => {
    if (!entries.length) return;
    const batch = entries;
    entries = [];
    const indices = await matches(batch, MAX_FILE_RESULTS - results.length);
    for (const index of indices) results.push(batch[index]);
  };
  return {
    async add(entry) {
      entries.push(entry);
      if (entries.length >= batchSize) await flush();
    },
    flush
  };
}

module.exports = { runFileQuerySearch, createFileQueryCollector };
