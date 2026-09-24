const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function createQuestionAnswerStore({ userData, Database = DatabaseSync }) {
  const db = new Database(path.join(userData, "codex-question-answers.sqlite3"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS question_answers (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, request_id TEXT NOT NULL,
      after_item_id TEXT, created_at INTEGER NOT NULL, item_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS question_answers_thread_order
      ON question_answers(thread_id, created_at);`);

  function save(threadId, turnId, requestId, afterItemId, item) {
    db.prepare(`INSERT INTO question_answers(thread_id, turn_id, request_id, after_item_id, created_at, item_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, turn_id, request_id) DO NOTHING`)
      .run(threadId, turnId, String(requestId), afterItemId, Date.now(), JSON.stringify(item));
  }
  function list(threadId) {
    return db.prepare(`SELECT turn_id, request_id, after_item_id, item_json FROM question_answers
      WHERE thread_id=? ORDER BY created_at, rowid`).all(threadId).map(row => ({
      turnId: row.turn_id, requestId: row.request_id, afterItemId: row.after_item_id, item: JSON.parse(row.item_json)
    }));
  }
  function update(threadId, turnId, requestId, item) {
    db.prepare("UPDATE question_answers SET item_json=? WHERE thread_id=? AND turn_id=? AND request_id=?")
      .run(JSON.stringify(item), threadId, turnId, String(requestId));
  }
  function remove(threadId, turnId, requestId) {
    db.prepare("DELETE FROM question_answers WHERE thread_id=? AND turn_id=? AND request_id=?")
      .run(threadId, turnId, String(requestId));
  }
  function close() { db.close(); }
  return { save, list, update, remove, close };
}

module.exports = { createQuestionAnswerStore };
