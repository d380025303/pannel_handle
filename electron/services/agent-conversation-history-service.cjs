const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn: defaultSpawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { getText, parseAgentConversationText } = require("./agent-conversation-transcript.cjs");

const HISTORY_PROVIDERS = ["codex", "codebuddy", "gemini", "grok"];
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_REMOTE_OUTPUT_BYTES = 16 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 20000;

function clampLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

function parseCursor(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid Agent conversation history cursor.");
  return Number(value);
}

function normalizeCwd(value, windows = false) {
  let normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  if (windows) normalized = normalized.toLowerCase();
  return normalized;
}

function timestampMs(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 10_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readJsonLines(text, visit) {
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // Ignore a partially written or obsolete line while the provider owns the file.
    }
  }
}

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
  const text = fsApi.readFileSync(filePath, "utf-8");
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
  const metadata = records.find(item => item?.sessionId || item?.projectHash) || {};
  const messages = materializeGeminiMessages(records);
  const firstUser = messages.find(item => item.type === "user");
  const id = path.basename(candidate.filePath).replace(/\.jsonl?$/i, "");
  const createdAt = timestampMs(metadata.startTime || messages[0]?.timestamp);
  const updatedAt = timestampMs(metadata.lastUpdated || messages.at(-1)?.timestamp) || fsApi.statSync(candidate.filePath).mtimeMs;
  const preview = typeof firstUser?.content === "string" ? firstUser.content.trim() : "";
  return {
    ref: `gemini:${candidate.projectHash}:${id}`,
    provider: "gemini",
    title: preview || "Gemini conversation",
    preview,
    cwd: cwd || "",
    createdAt,
    updatedAt,
    archived: false
  };
}

function listLocalGemini({ homeDir, cwd, scope, fsApi }) {
  return getGeminiChatFiles(fsApi, homeDir, cwd, scope).map(candidate => geminiMetadata(fsApi, candidate, scope === "cwd" ? cwd : ""));
}

function getLocalGeminiMessages({ homeDir, cwd, id, fsApi }) {
  const separator = id.indexOf(":");
  const projectHash = separator >= 0 ? id.slice(0, separator) : geminiProjectHash(cwd);
  const sessionId = separator >= 0 ? id.slice(separator + 1) : id;
  const candidate = getGeminiChatFiles(fsApi, homeDir, cwd, "all").find(entry => entry.projectHash === projectHash && path.basename(entry.filePath).replace(/\.jsonl?$/i, "") === sessionId);
  if (!candidate) throw new Error("Gemini conversation is unavailable.");
  return materializeGeminiMessages(readGeminiRecords(fsApi, candidate.filePath)).flatMap(item => {
    const text = typeof item.content === "string" ? item.content.trim() : "";
    if (!text) return [];
    return [{ id: String(item.id), provider: "gemini", kind: item.type === "user" ? "user" : "reply", text, timestamp: timestampMs(item.timestamp) }];
  });
}

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

function readGrokMessages(fsApi, sessionDirectory) {
  const messages = new Map();
  const transcriptPath = path.join(sessionDirectory, "updates.jsonl");
  if (!fsApi.existsSync(transcriptPath)) return [];
  readJsonLines(fsApi.readFileSync(transcriptPath, "utf-8"), item => {
    const params = item?.params || {};
    const update = params.update || {};
    const isUser = update.sessionUpdate === "user_message_chunk";
    if (!isUser && update.sessionUpdate !== "agent_message_chunk") return;
    const content = update.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? getText(content)
        : typeof content?.text === "string"
          ? content.text
          : "";
    if (!text) return;
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

function listLocalCodex({ homeDir, cwd, scope, includeArchived, fsApi, Database = DatabaseSync }) {
  const databaseFile = path.join(homeDir, ".codex", "state_5.sqlite");
  if (!fsApi.existsSync(databaseFile)) return [];
  const database = new Database(databaseFile, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT id, cwd, title, created_at, updated_at, archived,
             first_user_message, preview
      FROM threads
      WHERE source IN ('cli', 'vscode')
        AND first_user_message <> ''
        ${includeArchived ? "" : "AND archived = 0"}
      ORDER BY recency_at_ms DESC, updated_at_ms DESC, updated_at DESC
      LIMIT 5000
    `).all();
    const expectedCwd = normalizeCwd(cwd, true);
    return rows
      .filter(row => scope === "all" || normalizeCwd(row.cwd, true) === expectedCwd)
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

function filterAndPage(items, { query, cursor, limit }) {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? items.filter(item => [item.title, item.preview, item.cwd].some(value => String(value || "").toLocaleLowerCase().includes(normalizedQuery)))
    : items;
  filtered.sort((left, right) => right.updatedAt - left.updatedAt || left.ref.localeCompare(right.ref));
  const offset = parseCursor(cursor);
  const page = filtered.slice(offset, offset + limit);
  return {
    items: page,
    nextCursor: offset + page.length < filtered.length ? String(offset + page.length) : null
  };
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

function getLocalCodeBuddyMessages({ homeDir, id, fsApi }) {
  const files = getCodeBuddyProjectFiles(fsApi, path.join(homeDir, ".codebuddy", "projects"));
  const filePath = files.find(candidate => path.basename(candidate, ".jsonl") === id);
  if (!filePath) throw new Error("CodeBuddy conversation is unavailable.");
  return parseAgentConversationText("codebuddy", fsApi.readFileSync(filePath, "utf-8"), { includeUser: true });
}

function parseConversationRef(value) {
  const match = /^(codex|codebuddy|gemini|grok):([A-Za-z0-9][A-Za-z0-9:_.-]{0,299})$/.exec(String(value || ""));
  if (!match) throw new Error("Invalid Agent conversation reference.");
  return { provider: match[1], id: match[2] };
}

function pageMessages(messages, cursor, limit) {
  const newestFirst = [...messages].sort((left, right) => right.timestamp - left.timestamp);
  const offset = parseCursor(cursor);
  const page = newestFirst.slice(offset, offset + limit);
  return {
    messages: page,
    nextCursor: offset + page.length < newestFirst.length ? String(offset + page.length) : null
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runProcess(command, args, spawn = defaultSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Agent conversation history query timed out."));
    }, REMOTE_TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf-8");
      if (Buffer.byteLength(stdout, "utf-8") > MAX_REMOTE_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf-8"); });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && Buffer.byteLength(stdout, "utf-8") <= MAX_REMOTE_OUTPUT_BYTES) resolve(stdout);
      else reject(new Error(stderr.trim() || "Agent conversation history query failed."));
    });
  });
}

function createAgentConversationHistoryService({
  terminalManager,
  sshAgentTransport,
  homeDir = os.homedir(),
  fsApi = fs,
  Database = DatabaseSync,
  spawn = defaultSpawn,
  remoteScriptFile = path.join(__dirname, "agent-conversation-history-remote.py")
}) {
  const codeBuddyMetadataCache = new Map();
  function getSession(panelSessionId) {
    const session = terminalManager.getSession(String(panelSessionId || ""));
    if (!session) throw new Error("Session is not running.");
    return session;
  }

  async function runRemote(session, action, input) {
    const script = fsApi.readFileSync(remoteScriptFile);
    const expression = `import base64;exec(base64.b64decode("${Buffer.from(script).toString("base64")}"))`;
    const payload = Buffer.from(JSON.stringify(input), "utf-8").toString("base64");
    const output = session.type === "wsl"
      ? await runProcess("wsl.exe", ["-d", session.wslDistro, "--", "python3", "-c", expression, action, payload], spawn)
      : await sshAgentTransport.exec(
        session.id,
        `python3 -c ${shellQuote(expression)} ${shellQuote(action)} ${shellQuote(payload)}`,
        { actionName: "Agent conversation history", timeoutMs: REMOTE_TIMEOUT_MS }
      );
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("Agent conversation history returned an invalid response.");
    }
  }

  async function listHistory(input = {}) {
    const activeSession = getSession(input.panelSessionId);
    const session = activeSession.type === "ssh" && activeSession.agentLocation === "local"
      ? { ...activeSession, type: "windows", cwd: activeSession.runtimeCwd || activeSession.cwd }
      : activeSession;
    const providers = Array.isArray(input.providers) && input.providers.length
      ? [...new Set(input.providers.map(String))]
      : session.type === "ssh" ? ["codex", "codebuddy"] : HISTORY_PROVIDERS;
    if (providers.some(provider => !HISTORY_PROVIDERS.includes(provider))) {
      throw new Error("Unsupported Agent conversation history provider.");
    }
    if (session.type === "ssh" && providers.includes("gemini")) {
      throw new Error("Gemini conversation history is only available for Windows and WSL sessions.");
    }
    const request = {
      providers,
      cwd: session.cwd,
      scope: input.scope === "all" ? "all" : "cwd",
      includeArchived: input.includeArchived === true,
      query: String(input.query || "").slice(0, 500),
      cursor: input.cursor ?? null,
      limit: clampLimit(input.limit, DEFAULT_LIST_LIMIT)
    };
    if (session.type === "wsl" || session.type === "ssh") {
      return runRemote(session, "list", request);
    }

    const items = [];
    const errors = [];
    for (const provider of providers) {
      try {
        items.push(...(provider === "codex"
          ? listLocalCodex({ homeDir, cwd: session.cwd, scope: request.scope, includeArchived: request.includeArchived, fsApi, Database })
          : provider === "gemini"
            ? listLocalGemini({ homeDir, cwd: session.cwd, scope: request.scope, fsApi })
            : provider === "grok"
              ? listLocalGrok({ homeDir, cwd: session.cwd, scope: request.scope, fsApi })
              : listLocalCodeBuddy({ homeDir, cwd: session.cwd, scope: request.scope, fsApi, metadataCache: codeBuddyMetadataCache }))
        );
      } catch (error) {
        console.error(`Failed to list ${provider} conversation history:`, error);
        errors.push({ provider, message: `${provider === "codex" ? "Codex" : provider === "gemini" ? "Gemini" : provider === "grok" ? "Grok" : "CodeBuddy"} history is unavailable.` });
      }
    }
    return { ...filterAndPage(items, request), errors };
  }

  async function getHistoryMessages(input = {}) {
    const activeSession = getSession(input.panelSessionId);
    const session = activeSession.type === "ssh" && activeSession.agentLocation === "local"
      ? { ...activeSession, type: "windows", cwd: activeSession.runtimeCwd || activeSession.cwd }
      : activeSession;
    const reference = parseConversationRef(input.conversationRef);
    if (session.type === "ssh" && reference.provider === "gemini") {
      throw new Error("Gemini conversation history is only available for Windows and WSL sessions.");
    }
    const request = {
      conversationRef: input.conversationRef,
      cursor: input.cursor ?? null,
      limit: clampLimit(input.limit, DEFAULT_MESSAGE_LIMIT)
    };
    if (session.type === "wsl" || session.type === "ssh") {
      return runRemote(session, "messages", request);
    }
    const messages = reference.provider === "codex"
      ? getLocalCodexMessages({ homeDir, id: reference.id, fsApi, Database })
      : reference.provider === "gemini"
        ? getLocalGeminiMessages({ homeDir, cwd: session.cwd, id: reference.id, fsApi })
        : reference.provider === "grok"
          ? getLocalGrokMessages({ homeDir, id: reference.id, fsApi })
          : getLocalCodeBuddyMessages({ homeDir, id: reference.id, fsApi });
    return {
      conversationRef: input.conversationRef,
      ...pageMessages(messages, request.cursor, request.limit)
    };
  }

  return { listHistory, getHistoryMessages };
}

module.exports = {
  HISTORY_PROVIDERS,
  clampLimit,
  codeBuddyMetadata,
  createAgentConversationHistoryService,
  filterAndPage,
  getCodeBuddyProjectFiles,
  getGeminiChatFiles,
  getGrokSessionDirectories,
  readGrokMessages,
  materializeGeminiMessages,
  normalizeCwd,
  pageMessages,
  parseConversationRef,
  timestampMs
};
