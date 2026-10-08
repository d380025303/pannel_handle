const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { clampLimit, parseCursor, normalizeCwd } = require("./history-values.cjs");

function createConversationArchiveStore({ userData, Database = DatabaseSync, now = Date.now }) {
  const db = new Database(path.join(userData, "agent-conversations.sqlite3"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS launches (
      id TEXT PRIMARY KEY, panel_id TEXT NOT NULL, provider TEXT NOT NULL,
      title TEXT NOT NULL, cwd TEXT NOT NULL, cwd_key TEXT NOT NULL, location TEXT NOT NULL,
      mode TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      ended_at INTEGER, status TEXT NOT NULL, capture_status TEXT NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      launch_id TEXT NOT NULL REFERENCES launches(id), thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL, position INTEGER NOT NULL, data_json TEXT NOT NULL,
      PRIMARY KEY(launch_id, thread_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS launches_recency ON launches(updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_order ON messages(launch_id, position);`);
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    launch_id TEXT NOT NULL REFERENCES launches(id), thread_id TEXT NOT NULL,
    PRIMARY KEY(launch_id,thread_id)
  );`);
  db.prepare("UPDATE launches SET status='interrupted', ended_at=?, updated_at=? WHERE status='running'").run(now(), now());
  function start(session) {
    const id = randomUUID();
    const at = now();
    const provider = session.agentRuntimeProvider || session.agentProvider;
    const graphical = session.runtimeMode === "app-server";
    db.prepare(`INSERT INTO launches VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'running',?,NULL)`)
      .run(id, session.id, provider, session.title || provider, session.cwd || "",
        normalizeCwd(session.cwd, session.type === "windows"),
        session.type === "ssh" ? `ssh:${session.sshConfig?.host || ""}` : session.type === "wsl" ? `wsl:${session.wslDistro || ""}` : "windows",
        graphical ? "graphical" : "terminal", at, at,
        graphical || ["codex", "codebuddy", "opencode", "gemini", "grok"].includes(provider) ? "waiting" : "unsupported");
    return id;
  }
  function captureStatus(id, status, error = null) {
    db.prepare("UPDATE launches SET capture_status=?, error=? WHERE id=?").run(status, error, id);
  }
  function associate(id, threadId) {
    if (threadId) db.prepare("INSERT OR IGNORE INTO threads VALUES(?,?)").run(id, String(threadId));
  }
  function save(id, threadId, messages) {
    db.exec("BEGIN IMMEDIATE");
    try {
      associate(id, threadId);
      const write = db.prepare(`INSERT INTO messages(launch_id,thread_id,message_id,position,data_json)
        VALUES(?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM messages WHERE launch_id=?),?)
        ON CONFLICT(launch_id,thread_id,message_id) DO UPDATE SET data_json=excluded.data_json
        WHERE messages.data_json<>excluded.data_json`);
      let changed = false;
      for (const message of messages) {
        if (!message?.id) continue;
        changed = Boolean(write.run(id, String(threadId || ""), message.id, id, JSON.stringify(message)).changes) || changed;
      }
      if (changed) db.prepare("UPDATE launches SET updated_at=?, capture_status='supported', error=NULL WHERE id=?").run(now(), id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function finish(id, status = "ended") {
    db.prepare("UPDATE launches SET status=?, ended_at=?, updated_at=? WHERE id=?").run(status, now(), now(), id);
  }
  function list(input = {}) {
    const conditions = [];
    const args = [];
    if (input.scope !== "all" && input.cwd) {
      conditions.push("cwd_key=?"); args.push(normalizeCwd(input.cwd, input.windows === true));
    }
    if (input.providers?.length) {
      conditions.push(`provider IN (${input.providers.map(() => "?").join(",")})`); args.push(...input.providers);
    }
    if (input.query?.trim()) {
      conditions.push("(instr(lower(title),?)>0 OR instr(lower(cwd),?)>0)");
      args.push(input.query.trim().toLowerCase(), input.query.trim().toLowerCase());
    }
    const limit = clampLimit(input.limit, 50);
    const offset = parseCursor(input.cursor);
    const rows = db.prepare(`SELECT * FROM launches ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => ({
      ref: `archive:${row.id}`, provider: row.provider, title: row.title, preview: "", cwd: row.cwd,
      createdAt: row.started_at, updatedAt: row.updated_at, archived: false,
      status: row.status, captureStatus: row.capture_status, captureError: row.error,
      location: row.location, mode: row.mode, endedAt: row.ended_at,
      threadIds: db.prepare("SELECT thread_id FROM threads WHERE launch_id=? ORDER BY thread_id").all(row.id).map(value => value.thread_id)
    })), nextCursor: rows.length > limit ? String(offset + limit) : null, errors: [] };
  }
  function read(input) {
    const match = /^archive:([a-f0-9-]{36})$/.exec(String(input.conversationRef || ""));
    if (!match) throw new Error("无效的本地留档标识。");
    const limit = clampLimit(input.limit, 100);
    const offset = parseCursor(input.cursor);
    const rows = db.prepare("SELECT thread_id, data_json FROM messages WHERE launch_id=? ORDER BY position DESC LIMIT ? OFFSET ?")
      .all(match[1], limit + 1, offset);
    return { conversationRef: input.conversationRef,
      messages: rows.slice(0, limit).map(row => {
        const value = JSON.parse(row.data_json);
        return { ...value, id: JSON.stringify([row.thread_id, value.id]), threadId: row.thread_id };
      }), nextCursor: rows.length > limit ? String(offset + limit) : null };
  }
  return { start, save, finish, associate, captureStatus, list, read, close: () => db.close() };
}
module.exports = { createConversationArchiveStore };
