const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function createDiagnosticsStore({ userData, Database = DatabaseSync }) {
  const db = new Database(path.join(userData, "codex-app-server-diagnostics.sqlite3"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS diagnostic_events (
      id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT,
      kind TEXT NOT NULL, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS diagnostic_events_thread_order
      ON diagnostic_events(thread_id, id);
    CREATE TABLE IF NOT EXISTS turn_diffs (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, diff TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (thread_id, turn_id)
    );`);

  function addEvent(threadId, turnId, kind, payload, createdAt = Date.now()) {
    const result = db.prepare(`INSERT INTO diagnostic_events(thread_id, turn_id, kind, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?)`).run(threadId, turnId || null, kind, createdAt, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }
  function setDiff(threadId, turnId, diff, updatedAt = Date.now()) {
    db.prepare(`INSERT INTO turn_diffs(thread_id, turn_id, diff, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET diff=excluded.diff, updated_at=excluded.updated_at`)
      .run(threadId, turnId, diff, updatedAt);
  }
  function list(threadId, { includeHooks = true } = {}) {
    return {
      events: db.prepare(`SELECT id, turn_id, kind, created_at, payload_json FROM diagnostic_events
        WHERE thread_id=? ${includeHooks ? "" : "AND kind NOT LIKE 'hook/%'"} ORDER BY id`).all(threadId).map(row => ({
        id: String(row.id), turnId: row.turn_id, kind: row.kind, at: row.created_at,
        payload: JSON.parse(row.payload_json)
      })),
      diffs: db.prepare("SELECT turn_id, diff, updated_at FROM turn_diffs WHERE thread_id=? ORDER BY updated_at")
        .all(threadId).map(row => ({ turnId: row.turn_id, diff: row.diff, updatedAt: row.updated_at }))
    };
  }
  function close() { db.close(); }
  return { addEvent, setDiff, list, close };
}

module.exports = { createDiagnosticsStore };
