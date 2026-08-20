const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { getText, parseAgentConversationText } = require("./agent-conversation-transcript.cjs");

const HISTORY_PROVIDERS = ["codex", "codebuddy"];
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
  if (!Number.isFinite(number)) return 0;
  return number > 0 && number < 10_000_000_000 ? number * 1000 : number;
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
  const match = /^(codex|codebuddy):([A-Za-z0-9][A-Za-z0-9:_-]{0,199})$/.exec(String(value || ""));
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
  sshSessionRuntime,
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
      : await sshSessionRuntime.exec(
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
      : HISTORY_PROVIDERS;
    if (providers.some(provider => !HISTORY_PROVIDERS.includes(provider))) {
      throw new Error("Unsupported Agent conversation history provider.");
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
          : listLocalCodeBuddy({ homeDir, cwd: session.cwd, scope: request.scope, fsApi, metadataCache: codeBuddyMetadataCache }))
        );
      } catch (error) {
        console.error(`Failed to list ${provider} conversation history:`, error);
        errors.push({ provider, message: `${provider === "codex" ? "Codex" : "CodeBuddy"} history is unavailable.` });
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
  normalizeCwd,
  pageMessages,
  parseConversationRef,
  timestampMs
};
