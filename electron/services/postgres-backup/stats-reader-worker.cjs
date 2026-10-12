const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

let db;
let iterator;
try {
  db = new DatabaseSync(workerData.statsFile, { readOnly: true });
  // One snapshot across all tables, including when local statistics change during upload.
  db.exec("BEGIN");
  iterator = rows();
} catch (error) {
  db?.close();
  throw error;
}

function* rows() {
  for (const table of workerData.tables) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
      const key = table === "token_sessions" ? row.id
        : table === "token_daily" ? JSON.stringify([row.date, row.provider])
          : table === "token_session_mcp_tools" ? JSON.stringify([row.session_id, row.server_name, row.tool_name])
            : table === "token_session_models" ? JSON.stringify([row.session_id, row.model]) : JSON.stringify([row.session_id, row.name]);
      yield { table_name: table, row_key: `${workerData.epoch}:${key}`,
        data: { ...row, backup_epoch: workerData.epoch } };
    }
  }
}

parentPort.on("message", () => {
  try {
    const batch = [];
    while (batch.length < workerData.batchSize) {
      const next = iterator.next();
      if (next.done) break;
      batch.push(next.value);
    }
    if (batch.length) parentPort.postMessage({ batch });
    else {
      db.close();
      parentPort.postMessage({ done: true });
      parentPort.close();
    }
  } catch (error) {
    db.close();
    throw error;
  }
});
