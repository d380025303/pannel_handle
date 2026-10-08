const { createRemoteHistoryReader } = require("./remote-history-reader.cjs");
const { getGrokSessionDirectories, readGrokMessages, listLocalGrok, getLocalGrokMessages } = require("./local-grok-history.cjs");
const { getGeminiChatFiles, materializeGeminiMessages, listLocalGemini, getLocalGeminiMessages } = require("./local-gemini-history.cjs");
const { getCodeBuddyProjectFiles, codeBuddyMetadata, listLocalCodeBuddy, getLocalCodeBuddyMessages } = require("./local-codebuddy-history.cjs");
const { listLocalCodex, getLocalCodexMessages } = require("./local-codex-history.cjs");
const { listLocalOpenCode, getLocalOpenCodeMessages } = require("./local-opencode-history.cjs");
const { clampLimit, normalizeCwd, timestampMs, filterAndPage, parseConversationRef, pageMessages } = require("./history-values.cjs");
const { HISTORY_PROVIDERS, DEFAULT_LIST_LIMIT, DEFAULT_MESSAGE_LIMIT } = require("./history-limits.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const LIST_CACHE_TTL_MS = 30_000;
const MAX_LIST_CACHE_ENTRIES = 2;

function createAgentConversationHistoryService({
  terminalManager, conversationArchive,
  sshAgentTransport,
  homeDir = os.homedir(),
  fsApi = fs,
  Database = DatabaseSync,
  spawn = defaultSpawn,
  remoteScriptFile = path.join(__dirname, "agent-conversation-history-remote.py")
}) {
  const codeBuddyMetadataCache = new Map();
  const listCache = new Map();
  function getSession(panelSessionId) {
    const session = terminalManager.getSession(String(panelSessionId || ""));
    if (!session) throw new Error("Session is not running.");
    return session;
  }

  const runRemote = createRemoteHistoryReader({ fsApi, remoteScriptFile, spawn, sshAgentTransport });

  async function listHistory(input = {}) {
    if (input.source === "archive") return conversationArchive.list(input);
    return listHistoryForSession(getSession(input.panelSessionId), input);
  }

  async function listHistoryForSession(activeSession, input = {}) {
    const session = activeSession.type === "ssh" && activeSession.agentLocation === "local"
      ? { ...activeSession, type: "windows", cwd: activeSession.runtimeCwd || activeSession.cwd }
      : activeSession;
    const providers = Array.isArray(input.providers) && input.providers.length
      ? [...new Set(input.providers.map(String))]
      : session.type === "ssh" ? ["codex", "codebuddy", "opencode"] : HISTORY_PROVIDERS;
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

    const cacheKey = JSON.stringify([session.id, session.type, session.cwd, providers, request.scope,
      request.includeArchived, request.query]);
    const now = Date.now();
    for (const [key, entry] of listCache) {
      if (now - entry.createdAt >= LIST_CACHE_TTL_MS) listCache.delete(key);
    }
    const cached = request.cursor !== null && request.cursor !== "" ? listCache.get(cacheKey) : null;
    if (cached) return { ...filterAndPage(cached.items, request), errors: cached.errors };

    const items = [];
    const errors = [];
    for (const provider of providers) {
      try {
        items.push(...(provider === "codex"
          ? listLocalCodex({ homeDir, cwd: session.cwd, scope: request.scope, includeArchived: request.includeArchived, fsApi, Database })
          : provider === "opencode"
            ? listLocalOpenCode({ homeDir, cwd: session.cwd, scope: request.scope, includeArchived: request.includeArchived, fsApi, Database })
          : provider === "gemini"
            ? listLocalGemini({ homeDir, cwd: session.cwd, scope: request.scope, fsApi })
            : provider === "grok"
              ? listLocalGrok({ homeDir, cwd: session.cwd, scope: request.scope, fsApi })
              : listLocalCodeBuddy({ homeDir, cwd: session.cwd, scope: request.scope, fsApi, metadataCache: codeBuddyMetadataCache }))
        );
      } catch (error) {
        console.error(`Failed to list ${provider} conversation history:`, error);
        errors.push({ provider, message: `${provider === "codex" ? "Codex" : provider === "opencode" ? "OpenCode" : provider === "gemini" ? "Gemini" : provider === "grok" ? "Grok" : "CodeBuddy"} history is unavailable.` });
      }
    }
    listCache.delete(cacheKey);
    listCache.set(cacheKey, { items, errors, createdAt: now });
    if (listCache.size > MAX_LIST_CACHE_ENTRIES) listCache.delete(listCache.keys().next().value);
    return { ...filterAndPage(items, request), errors };
  }

  async function getHistoryMessages(input = {}) {
    if (String(input.conversationRef || "").startsWith("archive:")) return conversationArchive.read(input);
    return getHistoryMessagesForSession(getSession(input.panelSessionId), input);
  }

  async function getHistoryMessagesForSession(activeSession, input = {}) {
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
      : reference.provider === "opencode"
        ? getLocalOpenCodeMessages({ homeDir, id: reference.id, fsApi, Database })
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

  return { listHistory, getHistoryMessages, listHistoryForSession, getHistoryMessagesForSession };
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
