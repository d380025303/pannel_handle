const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createAgentConversationTranscriptParser } = require("./agent-conversation-transcript.cjs");
const { normalizeCwd, timestampMs } = require("./history-values.cjs");

function readLocalCodexList({ homeDir, cwd, scope, includeArchived, fsApi, Database = DatabaseSync }) {
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

async function getLocalCodexMessages({ homeDir, id, fsApi, signatureOnly = false, messageCache, Database = DatabaseSync }) {
  const databaseFile = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fsApi.existsSync(databaseFile)) throw new Error("Codex history is unavailable.");
  const database = new Database(databaseFile, { readOnly: true });
  let row;
  try {
    row = database.prepare("SELECT rollout_path FROM threads WHERE id = ? AND source IN ('cli', 'vscode') AND first_user_message <> ''").get(id);
  } finally {
    database.close();
  }
  if (!row?.rollout_path) throw new Error("Codex conversation is unavailable.");
  const file = row.rollout_path;
  try {
    const stat = await fsApi.promises.stat(file);
    // ctime also catches same-size rewrites with a restored modification time.
    const signature = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (signatureOnly) return JSON.stringify([file, signature]);
    const cached = messageCache?.get(file);
    if (cached?.signature === signature) return cached.messages;
    const text = await fsApi.promises.readFile(file, "utf-8");
    const parser = createAgentConversationTranscriptParser("codex", { includeUser: true });
    const messages = [];
    let lines = 0;
    let bytes = 0;
    for (let start = 0; start < text.length;) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline + 1;
      const line = text.slice(start, end);
      if (line.trim()) messages.push(...parser.pushLine(line));
      lines += 1;
      bytes += Buffer.byteLength(line, "utf8");
      start = end;
      // Bound each parsing batch so timers and other IPC can keep running.
      if (lines >= 128 || bytes >= 256 * 1024) {
        await new Promise(resolve => setImmediate(resolve));
        lines = 0;
        bytes = 0;
      }
    }
    // Do not cache a snapshot if the file changed while it was being read.
    const after = await fsApi.promises.stat(file);
    const afterSignature = JSON.stringify([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs]);
    messageCache?.delete(file);
    if (signature === afterSignature && messageCache) {
      messageCache.set(file, { signature, messages });
      if (messageCache.size > 2) messageCache.delete(messageCache.keys().next().value);
    }
    return messages;
  } catch (error) {
    messageCache?.delete(file);
    throw error;
  }
}

module.exports = {
  readLocalCodexList,
  getLocalCodexMessages
};
