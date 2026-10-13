const path = require("node:path");
const { getText, createAgentConversationTranscriptParser } = require("./agent-conversation-transcript.cjs");
const { timestampMs, normalizeCwd } = require("./history-values.cjs");

function getCodeBuddyProjectFiles(fsApi, root) {
  if (!fsApi.existsSync(root)) return [];
  const files = [];
  for (const directory of fsApi.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const projectRoot = path.join(root, directory.name);
    for (const entry of fsApi.readdirSync(projectRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(path.join(projectRoot, entry.name));
      }
    }
  }
  return files;
}

async function getCodeBuddyProjectFilesAsync(fsApi, root) {
  let directories;
  try {
    directories = await fsApi.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const projectRoot = path.join(root, directory.name);
    for (const entry of await fsApi.promises.readdir(projectRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(path.join(projectRoot, entry.name));
      }
    }
  }
  return files;
}

async function readCodeBuddyJsonLines(text, visit, raw = false) {
  // Avoid splitting the entire transcript synchronously; bound each parsing batch.
  let offset = 0;
  let lines = 0;
  let batchBytes = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end);
    offset = end + 1;
    if (line.trim()) {
      try {
        visit(raw ? line : JSON.parse(line));
      } catch {
        // Ignore a partially written or obsolete line while the provider owns the file.
      }
    }
    batchBytes += Buffer.byteLength(line, "utf-8") + 1;
    if (++lines >= 128 || batchBytes >= 256 * 1024) {
      await new Promise(resolve => setImmediate(resolve));
      lines = 0;
      batchBytes = 0;
    }
  }
}

async function codeBuddyMetadata(fsApi, filePath) {
  const id = path.basename(filePath, ".jsonl");
  let cwd = "";
  let title = "";
  let preview = "";
  let createdAt = 0;
  let updatedAt = 0;
  await readCodeBuddyJsonLines(await fsApi.promises.readFile(filePath, "utf-8"), item => {
    const timestamp = timestampMs(item?.timestamp);
    if (timestamp) {
      if (!createdAt || timestamp < createdAt) createdAt = timestamp;
      updatedAt = Math.max(updatedAt, timestamp);
    }
    if (!cwd && typeof item?.cwd === "string") cwd = item.cwd;
    if (item?.type === "ai-title" && typeof item.aiTitle === "string" && item.aiTitle.trim()) {
      title = item.aiTitle.trim();
    }
    if (!preview && item?.type === "message" && item.role === "user") {
      preview = getText(item.content);
    }
  });
  return {
    ref: `codebuddy:${id}`,
    provider: "codebuddy",
    title: title || preview || "CodeBuddy conversation",
    preview,
    cwd,
    createdAt,
    updatedAt: updatedAt || createdAt,
    archived: false
  };
}

async function listLocalCodeBuddy({ homeDir, cwd, scope, fsApi, metadataCache }) {
  const expectedCwd = normalizeCwd(cwd, process.platform === "win32");
  const files = await getCodeBuddyProjectFilesAsync(fsApi, path.join(homeDir, ".codebuddy", "projects"));
  const items = [];
  for (const filePath of files) {
    const stat = await fsApi.promises.stat(filePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = metadataCache?.get(filePath);
    const item = cached?.signature === signature ? cached.item : await codeBuddyMetadata(fsApi, filePath);
    metadataCache?.set(filePath, { signature, item });
    if (scope === "all" || normalizeCwd(item.cwd, process.platform === "win32") === expectedCwd) items.push(item);
  }
  return items;
}

async function getLocalCodeBuddyMessages({ homeDir, id, fsApi, messageCache }) {
  const files = await getCodeBuddyProjectFilesAsync(fsApi, path.join(homeDir, ".codebuddy", "projects"));
  const filePath = files.find(candidate => path.basename(candidate, ".jsonl") === id);
  if (!filePath) throw new Error("CodeBuddy conversation is unavailable.");
  const signatureOf = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  try {
    const signature = signatureOf(await fsApi.promises.stat(filePath));
    const cached = messageCache?.get(filePath);
    if (cached?.signature === signature) return cached.messages;
    const parser = createAgentConversationTranscriptParser("codebuddy", { includeUser: true });
    const messages = [];
    await readCodeBuddyJsonLines(await fsApi.promises.readFile(filePath, "utf-8"),
      line => messages.push(...parser.pushLine(line)), true);
    messages.sort((left, right) => right.timestamp - left.timestamp);
    // A transcript may be appended or replaced while parsing yields to the event loop.
    const afterSignature = signatureOf(await fsApi.promises.stat(filePath));
    messageCache?.delete(filePath);
    if (signature === afterSignature && messageCache) {
      messageCache.set(filePath, { signature, messages });
      if (messageCache.size > 2) messageCache.delete(messageCache.keys().next().value);
    }
    return messages;
  } catch (error) {
    messageCache?.delete(filePath);
    throw error;
  }
}

module.exports = {
  getCodeBuddyProjectFiles,
  codeBuddyMetadata,
  listLocalCodeBuddy,
  getLocalCodeBuddyMessages
};
