const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { queryWorkItems } = require("./module-owner-work-item-store.cjs");

let database;
let message;
try {
  database = new DatabaseSync(workerData.databaseFile, { readOnly: true });
  database.exec("PRAGMA busy_timeout=5000; BEGIN");
  message = { result: queryWorkItems(database, workerData.query) };
  database.exec("COMMIT");
} catch (error) {
  message = { error: error.message };
} finally {
  database?.close();
}
// Release the read connection before resolving the caller (including Windows file locks).
parentPort.postMessage(message);
parentPort.close();
