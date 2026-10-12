const { parentPort, workerData } = require("node:worker_threads");

try {
  const matcher = new RegExp(workerData.query, workerData.caseSensitive ? "" : "i");
  parentPort.on("message", ([name, relativePath]) => {
    parentPort.postMessage({ matches: matcher.test(name) || matcher.test(relativePath) });
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
