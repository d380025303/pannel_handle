const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

let db;
try {
  db = new DatabaseSync(workerData.databaseFile, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  const rows = db.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") {
    throw new Error(rows.map(row => Object.values(row)[0]).join("; "));
  }
  db.close();
  db = null;
  parentPort.postMessage({ ok: true });
} catch (error) {
  if (db) db.close();
  parentPort.postMessage({ error: `Business database failed integrity check: ${error.message}` });
}
