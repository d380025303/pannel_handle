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
    const order = table === "token_sessions" ? "id"
      : table === "token_daily" ? "date, provider"
        : table === "token_session_mcp_tools" ? "session_id, server_name, tool_name"
          : table === "token_session_models" ? "session_id, model" : "session_id, name";
    let batch = [];
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      const key = table === "token_sessions" ? row.id
        : table === "token_daily" ? JSON.stringify([row.date, row.provider])
          : table === "token_session_mcp_tools" ? JSON.stringify([row.session_id, row.server_name, row.tool_name])
            : table === "token_session_models" ? JSON.stringify([row.session_id, row.model]) : JSON.stringify([row.session_id, row.name]);
      batch.push({ table_name: table, row_key: `${workerData.epoch}:${key}`,
        data: { ...row, backup_epoch: workerData.epoch } });
      if (batch.length === workerData.batchSize) { yield batch; batch = []; }
    }
    if (batch.length) yield batch;
  }
}

parentPort.on("message", () => {
  try {
    const next = iterator.next();
    if (!next.done) parentPort.postMessage({ batch: next.value });
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
