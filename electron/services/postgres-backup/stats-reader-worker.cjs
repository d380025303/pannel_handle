const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const fs = require("node:fs");

let db;
let snapshot;
try {
  db = new DatabaseSync(workerData.statsFile, { readOnly: true });
  // Materialize one snapshot across all tables before waiting for remote uploads.
  db.exec("BEGIN");
  snapshot = fs.openSync(workerData.snapshotFile, "wx+", 0o600);
  for (const batch of rows()) {
    const data = Buffer.from(JSON.stringify(batch));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    fs.writeFileSync(snapshot, header);
    fs.writeFileSync(snapshot, data);
  }
  db.close();
  db = null;
} catch (error) {
  db?.close();
  if (snapshot !== undefined) fs.closeSync(snapshot);
  throw error;
}

function* rows() {
  for (const table of workerData.tables) {
    // Older databases have not created the Beijing calendar yet.
    if (["token_daily_beijing", "token_calendar"].includes(table)
      && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const order = table === "token_sessions" ? "id"
      : table === "token_calendar" ? "id"
      : ["token_daily", "token_daily_beijing"].includes(table) ? "date, provider"
        : table === "token_session_mcp_tools" ? "session_id, server_name, tool_name"
          : table === "token_session_models" ? "session_id, model" : "session_id, name";
    let batch = [];
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
      const key = table === "token_sessions" ? row.id
        : table === "token_calendar" ? row.id
        : ["token_daily", "token_daily_beijing"].includes(table) ? JSON.stringify([row.date, row.provider])
          : table === "token_session_mcp_tools" ? JSON.stringify([row.session_id, row.server_name, row.tool_name])
            : table === "token_session_models" ? JSON.stringify([row.session_id, row.model]) : JSON.stringify([row.session_id, row.name]);
      batch.push({ table_name: table, row_key: `${workerData.epoch}:${key}`,
        data: { ...row, backup_epoch: workerData.epoch } });
      if (batch.length === workerData.batchSize) { yield batch; batch = []; }
    }
    if (batch.length) yield batch;
  }
}

let position = 0;
function readExact(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(snapshot, buffer, offset, buffer.length - offset, position);
    if (!count) throw new Error("Incomplete statistics snapshot.");
    offset += count;
    position += count;
  }
}

parentPort.on("message", () => {
  try {
    if (position === fs.fstatSync(snapshot).size) {
      fs.closeSync(snapshot);
      parentPort.postMessage({ done: true });
      parentPort.close();
      return;
    }
    const header = Buffer.alloc(4);
    readExact(header);
    const data = Buffer.alloc(header.readUInt32LE());
    readExact(data);
    parentPort.postMessage({ batch: JSON.parse(data.toString("utf8")) });
  } catch (error) {
    fs.closeSync(snapshot);
    throw error;
  }
});
