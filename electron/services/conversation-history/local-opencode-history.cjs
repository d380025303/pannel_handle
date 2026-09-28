const path = require("node:path");
const { normalizeCwd, timestampMs } = require("./history-values.cjs");

function databaseFile(homeDir, env = process.env) {
  const dataHome = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

function openDatabase({ homeDir, fsApi, Database, env }) {
  const file = databaseFile(homeDir, env);
  if (!fsApi.existsSync(file)) return null;
  const database = new Database(file, { readOnly: true });
  for (const [table, columns] of Object.entries({
    session: ["id", "directory", "title", "parent_id", "time_created", "time_updated", "time_archived"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["id", "message_id", "session_id", "time_created", "data"]
  })) {
    const found = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (columns.some(column => !found.has(column))) {
      database.close();
      throw new Error("Unsupported OpenCode history schema.");
    }
  }
  return database;
}

function listLocalOpenCode({ homeDir, cwd, scope, includeArchived, fsApi, Database, env }) {
  const database = openDatabase({ homeDir, fsApi, Database, env });
  if (!database) return [];
  try {
    const rows = database.prepare(`SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, s.time_archived,
      (SELECT json_extract(p.data, '$.text') FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.type') = 'text' AND trim(json_extract(p.data, '$.text')) <> ''
       ORDER BY m.time_created, p.time_created LIMIT 1) AS preview
      FROM session s WHERE s.parent_id IS NULL`).all();
    return rows.filter(row => (includeArchived || !row.time_archived)
      && (scope === "all" || normalizeCwd(row.directory, true) === normalizeCwd(cwd, true)))
      .map(row => ({ ref: `opencode:${row.id}`, provider: "opencode", title: row.title || row.preview || "OpenCode conversation",
        preview: row.preview || "", cwd: row.directory || "", createdAt: timestampMs(row.time_created),
        updatedAt: timestampMs(row.time_updated), archived: Boolean(row.time_archived) }));
  } finally {
    database.close();
  }
}

function getLocalOpenCodeMessages({ homeDir, id, fsApi, Database, env }) {
  const database = openDatabase({ homeDir, fsApi, Database, env });
  if (!database) throw new Error("OpenCode conversation is unavailable.");
  try {
    if (!database.prepare("SELECT 1 FROM session WHERE id = ? AND parent_id IS NULL").get(id))
      throw new Error("OpenCode conversation is unavailable.");
    const rows = database.prepare(`SELECT m.id, m.time_created, json_extract(m.data, '$.role') AS role,
      p.id AS part_id, p.data AS part_data
      FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ? ORDER BY m.time_created, m.id, p.time_created, p.id`).all(id);
    const messages = new Map();
    for (const row of rows) {
      if (row.role !== "user" && row.role !== "assistant") continue;
      let part;
      try { part = JSON.parse(row.part_data); } catch { continue; }
      if (part?.type !== "text" || typeof part.text !== "string" || !part.text.trim()) continue;
      const message = messages.get(row.id) || { id: row.id, provider: "opencode",
        kind: row.role === "user" ? "user" : "reply", text: "", timestamp: timestampMs(row.time_created) };
      message.text += `${message.text ? "\n\n" : ""}${part.text.trim()}`;
      messages.set(row.id, message);
    }
    return [...messages.values()];
  } finally {
    database.close();
  }
}

module.exports = { databaseFile, listLocalOpenCode, getLocalOpenCodeMessages };
