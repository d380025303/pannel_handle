const { parentPort, workerData } = require("node:worker_threads");

try {
  const matcher = new RegExp(workerData.query, workerData.caseSensitive ? "" : "i");
  parentPort.on("message", ({ entries, limit }) => {
    const matches = [];
    for (let index = 0; index < entries.length && matches.length < limit; index += 1) {
      const [name, relativePath] = entries[index];
      if (matcher.test(name) || matcher.test(relativePath)) matches.push(index);
    }
    parentPort.postMessage({ matches });
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
