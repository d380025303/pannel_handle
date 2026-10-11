const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const TABLES = new Set(["projects", "roles", "runs", "findings", "approvals", "sessions"]);

function createFindingStore({ userData, databaseFile = path.join(userData, "project-inspector.sqlite3") }) {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const db = new DatabaseSync(databaseFile);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  function transaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > 1) { db.close(); throw new Error("巡检数据库版本高于当前应用，请升级应用。"); }
  if (version < 1) transaction(() => {
    for (const table of TABLES) db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value_json TEXT NOT NULL); CREATE INDEX idx_${table}_project ON ${table}(project_id);`);
    db.exec("PRAGMA user_version=1");
  });
  function assertTable(table) { if (!TABLES.has(table)) throw new Error("无效的巡检数据表。"); }
  function get(table, id) {
    assertTable(table);
    const row = db.prepare(`SELECT value_json FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(row.value_json) : null;
  }
  function list(table, projectId) {
    assertTable(table);
    const rows = projectId === undefined ? db.prepare(`SELECT value_json FROM ${table}`).all()
      : db.prepare(`SELECT value_json FROM ${table} WHERE project_id=?`).all(projectId);
    return rows.map(row => JSON.parse(row.value_json));
  }
  function put(table, value) {
    assertTable(table);
    db.prepare(`INSERT INTO ${table}(id, project_id, value_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,value_json=excluded.value_json`)
      .run(value.id, value.projectId || value.id, JSON.stringify(value));
    return value;
  }
  transaction(() => {
    for (const run of list("runs")) if (["queued", "running"].includes(run.status)) put("runs", {
      ...run, status: "interrupted", finishedAt: Date.now(), error: "应用在巡检完成前退出，可手动重试。"
    });
    for (const session of list("sessions")) if (session.status === "creating") put("sessions", {
      ...session, status: "interrupted", error: "会话创建中断，请检查关联会话后重试。"
    });
  });
  return { get, list, put, transaction, close: () => db.close() };
}

module.exports = { createFindingStore };
