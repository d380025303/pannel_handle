const { parentPort } = require("node:worker_threads");
const { getLineMatches } = require("./search-matching.cjs");

parentPort.on("message", ({ content, query, limit, options }) => {
  try {
    parentPort.postMessage({ matches: getLineMatches(content, query, limit, options) });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
