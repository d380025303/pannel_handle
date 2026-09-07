const path = require("node:path");
const { getText, parseAgentConversationText } = require("./agent-conversation-transcript.cjs");
const { readJsonLines, timestampMs, normalizeCwd } = require("./history-values.cjs");

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

function codeBuddyMetadata(fsApi, filePath) {
  const id = path.basename(filePath, ".jsonl");
  let cwd = "";
  let title = "";
  let preview = "";
  let createdAt = 0;
  let updatedAt = 0;
  readJsonLines(fsApi.readFileSync(filePath, "utf-8"), item => {
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

function listLocalCodeBuddy({ homeDir, cwd, scope, fsApi, metadataCache }) {
  const expectedCwd = normalizeCwd(cwd, process.platform === "win32");
  return getCodeBuddyProjectFiles(fsApi, path.join(homeDir, ".codebuddy", "projects"))
    .map(filePath => {
      const stat = fsApi.statSync(filePath);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const cached = metadataCache?.get(filePath);
      if (cached?.signature === signature) return cached.item;
      const item = codeBuddyMetadata(fsApi, filePath);
      metadataCache?.set(filePath, { signature, item });
      return item;
    })
    .filter(item => scope === "all" || normalizeCwd(item.cwd, process.platform === "win32") === expectedCwd);
}

function getLocalCodeBuddyMessages({ homeDir, id, fsApi }) {
  const files = getCodeBuddyProjectFiles(fsApi, path.join(homeDir, ".codebuddy", "projects"));
  const filePath = files.find(candidate => path.basename(candidate, ".jsonl") === id);
  if (!filePath) throw new Error("CodeBuddy conversation is unavailable.");
  return parseAgentConversationText("codebuddy", fsApi.readFileSync(filePath, "utf-8"), { includeUser: true });
}

module.exports = {
  getCodeBuddyProjectFiles,
  codeBuddyMetadata,
  listLocalCodeBuddy,
  getLocalCodeBuddyMessages
};
