const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { parseAgentConversationText } = require("./agent-conversation-transcript.cjs");
const { normalizeCwd, timestampMs } = require("./history-values.cjs");

function listLocalCodex({ homeDir, cwd, scope, includeArchived, fsApi, Database = DatabaseSync }) {
  const databaseFile = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fsApi.existsSync(databaseFile)) return [];
  const database = new Database(databaseFile, { readOnly: true });
  try {
    database.function("normalize_history_cwd", { deterministic: true }, value => normalizeCwd(value, true));
    const rows = database.prepare(`
      SELECT id, cwd, title, created_at, updated_at, archived,
             first_user_message, preview
      FROM threads
      WHERE source IN ('cli', 'vscode')
        AND first_user_message <> ''
        ${includeArchived ? "" : "AND archived = 0"}
        ${scope === "all" ? "" : "AND normalize_history_cwd(cwd) = ?"}
      ORDER BY recency_at_ms DESC, updated_at_ms DESC, updated_at DESC
    `).all(...(scope === "all" ? [] : [normalizeCwd(cwd, true)]));
    return rows
      .map(row => ({
        ref: `codex:${row.id}`,
        provider: "codex",
        title: String(row.title || row.first_user_message || row.preview || "Codex conversation"),
        preview: String(row.first_user_message || row.preview || ""),
        cwd: String(row.cwd || ""),
        createdAt: timestampMs(row.created_at),
        updatedAt: timestampMs(row.updated_at),
        archived: Boolean(row.archived)
      }));
  } finally {
    database.close();
  }
}

function getLocalCodexMessages({ homeDir, id, fsApi, Database = DatabaseSync }) {
  const databaseFile = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fsApi.existsSync(databaseFile)) throw new Error("Codex history is unavailable.");
  const database = new Database(databaseFile, { readOnly: true });
  let row;
  try {
    row = database.prepare("SELECT rollout_path FROM threads WHERE id = ? AND source IN ('cli', 'vscode') AND first_user_message <> ''").get(id);
  } finally {
    database.close();
  }
  if (!row?.rollout_path || !fsApi.existsSync(row.rollout_path)) throw new Error("Codex conversation is unavailable.");
  return parseAgentConversationText("codex", fsApi.readFileSync(row.rollout_path, "utf-8"), { includeUser: true });
}

module.exports = {
  listLocalCodex,
  getLocalCodexMessages
};
