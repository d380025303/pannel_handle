const path = require("node:path");
const { getGrokChunkText } = require("./grok-chunk-text.cjs");
const { readJsonLines, timestampMs, normalizeCwd } = require("./history-values.cjs");

function getGrokSessionDirectories(fsApi, homeDir) {
  const sessionsRoot = path.join(process.env.GROK_HOME || path.join(homeDir, ".grok"), "sessions");
  if (!fsApi.existsSync(sessionsRoot)) return [];
  const directories = [];
  for (const workspace of fsApi.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceRoot = path.join(sessionsRoot, workspace.name);
    for (const session of fsApi.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (session.isDirectory() && /^[0-9a-f-]{36}$/i.test(session.name)) directories.push(path.join(workspaceRoot, session.name));
    }
  }
  return directories;
}

function parseGrokMessages(text) {
  const messages = new Map();
  const seenEventIds = new Set();
  readJsonLines(text, item => {
    const params = item?.params || {};
    const update = params.update || {};
    const isUser = update.sessionUpdate === "user_message_chunk";
    if (!isUser && update.sessionUpdate !== "agent_message_chunk") return;
    const text = getGrokChunkText(update.content);
    if (!text) return;
    const eventId = params._meta?.eventId;
    if (eventId) {
      const id = String(eventId);
      if (seenEventIds.has(id)) return;
      seenEventIds.add(id);
    }
    const role = isUser ? "user" : "reply";
    const promptId = String(params._meta?.promptId || update.prompt_id || params._meta?.eventId || item.timestamp || messages.size);
    const key = `${promptId}:${role}`;
    const existing = messages.get(key);
    if (existing) {
      existing.text += text;
      existing.timestamp = Math.min(existing.timestamp, timestampMs(item.timestamp));
    } else {
      messages.set(key, { id: key, provider: "grok", kind: role, text, timestamp: timestampMs(item.timestamp) });
    }
  });
  return [...messages.values()].filter(message => message.text.trim()).map(message => ({ ...message, text: message.text.trim() }));
}

async function readGrokMessages(fsApi, sessionDirectory) {
  const { readGrokTranscript } = require("./grok-history-worker-client.cjs");
  const transcriptPath = path.join(sessionDirectory, "updates.jsonl");
  if (fsApi === require("node:fs")) return readGrokTranscript({ transcriptPath });
  // Injected filesystems cannot cross the Worker boundary.
  if (!fsApi.existsSync(transcriptPath)) return [];
  const text = fsApi.promises?.readFile
    ? await fsApi.promises.readFile(transcriptPath, "utf-8")
    : fsApi.readFileSync(transcriptPath, "utf-8");
  return readGrokTranscript({ text });
}

function listLocalGrok({ homeDir, cwd, scope, fsApi }) {
  const items = [];
  for (const sessionDirectory of getGrokSessionDirectories(fsApi, homeDir)) {
    const summaryPath = path.join(sessionDirectory, "summary.json");
    if (!fsApi.existsSync(summaryPath)) continue;
    let summary;
    try { summary = JSON.parse(fsApi.readFileSync(summaryPath, "utf-8")); } catch { continue; }
    const sessionCwd = String(summary?.info?.cwd || "");
    if (scope !== "all" && normalizeCwd(sessionCwd, process.platform === "win32") !== normalizeCwd(cwd, process.platform === "win32")) continue;
    const id = path.basename(sessionDirectory);
    const preview = String(summary?.session_summary || "").trim();
    items.push({
      ref: `grok:${id}`,
      provider: "grok",
      title: String(summary?.generated_title || preview || "Grok conversation").trim(),
      preview,
      cwd: sessionCwd,
      createdAt: timestampMs(summary?.created_at),
      updatedAt: timestampMs(summary?.last_active_at || summary?.updated_at) || fsApi.statSync(summaryPath).mtimeMs,
      archived: false
    });
  }
  return items;
}

function getLocalGrokMessages({ homeDir, id, fsApi }) {
  const directory = getGrokSessionDirectories(fsApi, homeDir).find(candidate => path.basename(candidate) === id);
  if (!directory) throw new Error("Grok conversation is unavailable.");
  return readGrokMessages(fsApi, directory);
}

module.exports = {
  getGrokSessionDirectories,
  readGrokMessages,
  parseGrokMessages,
  listLocalGrok,
  getLocalGrokMessages
};
