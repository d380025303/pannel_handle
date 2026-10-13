const path = require("node:path");
const { Worker } = require("node:worker_threads");

function createWorkItemSearchReader(databaseFile) {
  const active = new Map();
  function search(query) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "work-item-search-worker.cjs"), { workerData: { databaseFile, query } });
      active.set(worker, reject);
      const finish = (error, value) => {
        if (!active.delete(worker)) return;
        if (error) reject(error); else resolve(value);
      };
      worker.once("message", message => finish(message.error ? new Error(message.error) : null, message.result));
      worker.once("error", error => finish(error));
      worker.once("exit", code => finish(new Error(`任务搜索 Worker 意外退出 (${code})。`)));
    });
  }
  function close() {
    const stopped = [];
    for (const [worker, reject] of active) {
      reject(new Error("SQLite 任务存储已关闭。"));
      stopped.push(worker.terminate());
    }
    active.clear();
    return Promise.all(stopped);
  }
  return { search, close };
}
module.exports = { createWorkItemSearchReader };
