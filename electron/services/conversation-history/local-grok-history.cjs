const path = require("node:path");
const { getGrokChunkText } = require("./grok-chunk-text.cjs");
const { readJsonLines, timestampMs, normalizeCwd } = require("./history-values.cjs");

const FILE_CONCURRENCY = 16;

async function mapConcurrent(values, callback) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await callback(values[index]);
    }
  }));
  return results;
}

async function getGrokSessionDirectories(fsApi, homeDir) {
  const sessionsRoot = path.join(process.env.GROK_HOME || path.join(homeDir, ".grok"), "sessions");
  let workspaces;
  try {
    workspaces = await fsApi.promises.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const directories = await mapConcurrent(workspaces.filter(entry => entry.isDirectory()), async workspace => {
    const workspaceRoot = path.join(sessionsRoot, workspace.name);
    const sessions = await fsApi.promises.readdir(workspaceRoot, { withFileTypes: true });
    return sessions.filter(session => session.isDirectory() && /^[0-9a-f-]{36}$/i.test(session.name))
      .map(session => path.join(workspaceRoot, session.name));
  });
  return directories.flat();
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

async function listLocalGrok({ homeDir, cwd, scope, fsApi }) {
  const directories = await getGrokSessionDirectories(fsApi, homeDir);
  const items = await mapConcurrent(directories, async sessionDirectory => {
    const summaryPath = path.join(sessionDirectory, "summary.json");
    let summary;
    try { summary = JSON.parse(await fsApi.promises.readFile(summaryPath, "utf-8")); } catch { return null; }
    const sessionCwd = String(summary?.info?.cwd || "");
    if (scope !== "all" && normalizeCwd(sessionCwd, process.platform === "win32") !== normalizeCwd(cwd, process.platform === "win32")) return null;
    const id = path.basename(sessionDirectory);
    const preview = String(summary?.session_summary || "").trim();
    return {
      ref: `grok:${id}`,
      provider: "grok",
      title: String(summary?.generated_title || preview || "Grok conversation").trim(),
      preview,
      cwd: sessionCwd,
      createdAt: timestampMs(summary?.created_at),
      updatedAt: timestampMs(summary?.last_active_at || summary?.updated_at) || (await fsApi.promises.stat(summaryPath)).mtimeMs,
      archived: false
    };
  });
  return items.filter(Boolean);
}

async function getLocalGrokMessages({ homeDir, id, fsApi, signatureOnly = false }) {
  const directory = (await getGrokSessionDirectories(fsApi, homeDir)).find(candidate => path.basename(candidate) === id);
  if (!directory) throw new Error("Grok conversation is unavailable.");
  if (signatureOnly) return require("./history-source-signature.cjs").sourceSignature(fsApi, [path.join(directory, "updates.jsonl")]);
  return readGrokMessages(fsApi, directory);
}

module.exports = {
  getGrokSessionDirectories,
  readGrokMessages,
  parseGrokMessages,
  listLocalGrok,
  getLocalGrokMessages
};
