const path = require("node:path");
const crypto = require("node:crypto");
const { readJsonLines, timestampMs } = require("./history-values.cjs");

function geminiProjectHash(cwd) {
  return crypto.createHash("sha256").update(String(cwd || "")).digest("hex");
}

function getGeminiChatFiles(fsApi, homeDir, cwd, scope) {
  const tmpRoot = path.join(process.env.GEMINI_CLI_HOME || homeDir, ".gemini", "tmp");
  if (!fsApi.existsSync(tmpRoot)) return [];
  const projectDirs = scope === "all"
    ? fsApi.readdirSync(tmpRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : [geminiProjectHash(cwd)];
  const files = [];
  for (const projectHash of projectDirs) {
    const chats = path.join(tmpRoot, projectHash, "chats");
    if (!fsApi.existsSync(chats)) continue;
    for (const entry of fsApi.readdirSync(chats, { withFileTypes: true })) {
      if (entry.isFile() && /\.jsonl?$/.test(entry.name.toLowerCase())) files.push({ filePath: path.join(chats, entry.name), projectHash });
    }
  }
  return files;
}

function readGeminiRecords(fsApi, filePath) {
  return parseGeminiRecords(fsApi.readFileSync(filePath, "utf-8"), filePath);
}

function parseGeminiRecords(text, filePath) {
  if (filePath.toLowerCase().endsWith(".json")) {
    try {
      const value = JSON.parse(text);
      return Array.isArray(value) ? value : [value, ...(Array.isArray(value.messages) ? value.messages : [])];
    } catch { return []; }
  }
  const records = [];
  readJsonLines(text, item => records.push(item));
  return records;
}

function materializeGeminiMessages(records) {
  const messages = new Map();
  for (const item of records) {
    if (Array.isArray(item?.$set?.messages)) {
      messages.clear();
      for (const message of item.$set.messages) if (message?.id) messages.set(String(message.id), message);
      continue;
    }
    const rewindId = item?.$rewindTo?.id ?? item?.$rewindTo;
    if (rewindId) {
      let remove = false;
      for (const id of [...messages.keys()]) {
        if (id === String(rewindId)) remove = true;
        if (remove) messages.delete(id);
      }
      continue;
    }
    if ((item?.type === "user" || item?.type === "gemini") && item.id) messages.set(String(item.id), item);
  }
  return [...messages.values()];
}

function geminiMetadata(fsApi, candidate, cwd) {
  const records = readGeminiRecords(fsApi, candidate.filePath);
  return metadataFromRecords(records, candidate, cwd, () => fsApi.statSync(candidate.filePath).mtimeMs);
}

function metadataFromRecords(records, candidate, cwd, getMtime) {
  const metadata = records.find(item => item?.sessionId || item?.projectHash) || {};
  const messages = materializeGeminiMessages(records);
  const firstUser = messages.find(item => item.type === "user");
  const id = path.basename(candidate.filePath).replace(/\.jsonl?$/i, "");
  const createdAt = timestampMs(metadata.startTime || messages[0]?.timestamp);
  const updatedAt = timestampMs(metadata.lastUpdated || messages.at(-1)?.timestamp) || getMtime();
  const preview = typeof firstUser?.content === "string" ? firstUser.content.trim() : "";
  return {
    ref: `gemini:${candidate.projectHash}:${id}`,
    acpSessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
    provider: "gemini",
    title: preview || "Gemini conversation",
    preview,
    cwd: cwd || "",
    createdAt,
    updatedAt,
    archived: false
  };
}

async function getGeminiChatFilesAsync(fsApi, homeDir, cwd, scope) {
  const tmpRoot = path.join(process.env.GEMINI_CLI_HOME || homeDir, ".gemini", "tmp");
  async function readDirectory(directory) {
    try {
      return await fsApi.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  const projectDirs = scope === "all"
    ? (await readDirectory(tmpRoot)).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : [geminiProjectHash(cwd)];
  const files = [];
  for (const projectHash of projectDirs) {
    const chats = path.join(tmpRoot, projectHash, "chats");
    for (const entry of await readDirectory(chats)) {
      if (entry.isFile() && /\.jsonl?$/.test(entry.name.toLowerCase())) files.push({ filePath: path.join(chats, entry.name), projectHash });
    }
  }
  return files;
}

async function listLocalGemini({ homeDir, cwd, scope, fsApi, metadataCache }) {
  const candidates = await getGeminiChatFilesAsync(fsApi, homeDir, cwd, scope);
  const items = [];
  for (const candidate of candidates) {
    const stat = await fsApi.promises.stat(candidate.filePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = metadataCache?.get(candidate.filePath);
    let item = cached?.signature === signature ? cached.item : null;
    if (!item) {
      const text = await fsApi.promises.readFile(candidate.filePath, "utf-8");
      item = metadataFromRecords(parseGeminiRecords(text, candidate.filePath), candidate, "", () => stat.mtimeMs);
      metadataCache?.set(candidate.filePath, { signature, item });
    }
    // cwd belongs to the request, rather than the cached file metadata.
    items.push({ ...item, cwd: scope === "cwd" ? cwd || "" : "" });
    // Even immediately resolved reads/cache hits must allow timers and IPC to run.
    await new Promise(resolve => setImmediate(resolve));
  }
  if (metadataCache) {
    const listedPaths = new Set(candidates.map(candidate => candidate.filePath));
    const root = path.join(process.env.GEMINI_CLI_HOME || homeDir, ".gemini", "tmp");
    const scannedRoot = scope === "all" ? root : path.join(root, geminiProjectHash(cwd), "chats");
    for (const filePath of metadataCache.keys()) {
      const relative = path.relative(scannedRoot, filePath);
      if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) && !listedPaths.has(filePath)) {
        metadataCache.delete(filePath);
      }
    }
  }
  return items;
}

async function getLocalGeminiMessages({ homeDir, cwd, id, fsApi, messageCache = new Map() }) {
  const separator = id.indexOf(":");
  const projectHash = separator >= 0 ? id.slice(0, separator) : geminiProjectHash(cwd);
  const sessionId = separator >= 0 ? id.slice(separator + 1) : id;
  const candidate = (await getGeminiChatFilesAsync(fsApi, homeDir, cwd, "all")).find(entry => entry.projectHash === projectHash && path.basename(entry.filePath).replace(/\.jsonl?$/i, "") === sessionId);
  if (!candidate) throw new Error("Gemini conversation is unavailable.");
  const filePath = candidate.filePath;
  const signatureOf = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  try {
    const signature = signatureOf(await fsApi.promises.stat(filePath));
    const cached = messageCache.get(filePath);
    if (cached?.signature === signature) return await cached.result;
    const { parseGeminiTranscript } = require("./gemini-history-worker-client.cjs");
    const entry = { signature, result: null };
    entry.result = (async () => {
      const text = await fsApi.promises.readFile(filePath);
      const messages = await parseGeminiTranscript({ text, filePath });
      // Never retain a snapshot under an old signature if the provider wrote during the read.
      const afterSignature = signatureOf(await fsApi.promises.stat(filePath));
      if (signature !== afterSignature && messageCache.get(filePath) === entry) messageCache.delete(filePath);
      return messages;
    })();
    messageCache.delete(filePath);
    messageCache.set(filePath, entry);
    if (messageCache.size > 2) messageCache.delete(messageCache.keys().next().value);
    try { return await entry.result; }
    catch (error) {
      if (messageCache.get(filePath) === entry) messageCache.delete(filePath);
      throw error;
    }
  } catch (error) {
    if (error.code === "ENOENT") messageCache.delete(filePath);
    throw error;
  }
}

module.exports = {
  parseGeminiRecords,
  geminiProjectHash,
  getGeminiChatFiles,
  readGeminiRecords,
  materializeGeminiMessages,
  geminiMetadata,
  listLocalGemini,
  getLocalGeminiMessages
};
