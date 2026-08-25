const fs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const {
  TOKEN_FIELDS,
  cloneTokens,
  createIncrementalTranscriptParser,
  emptyCapabilityUsage,
  emptyTokens,
  getCodeBuddySubagentsDir,
  normalizeCapabilityUsage,
  parseTranscriptFileWithSubagents,
  parseTranscriptText,
  safeInteger
} = require("./agent-token-transcript.cjs");
const { subtractCapabilities } = require("../../stores/agent-token-stats-store.cjs");
const { toWslHostPath } = require("../remote-files/index.cjs");
const { createAgentConversationTranscriptParser } = require("../agent-conversation-transcript.cjs");
const { createCopilotOtelParser, getCopilotOtelPath } = require("./copilot-otel.cjs");

const RETRY_DELAYS_MS = [150, 500, 1200];
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const LIVE_POLL_INTERVAL_MS = 1000;
const TOKEN_STATS_PROVIDERS = ["codex", "claude", "codebuddy", "opencode", "qoder", "copilot", "gemini", "grok"];
const LIVE_TOKEN_PROVIDERS = ["codex", "claude", "codebuddy", "qoder", "copilot", "gemini", "grok"];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function remoteParserCommand(provider, transcriptPath) {
  // 对 CodeBuddy 额外读取主 transcript 同级的 `<sessionId>/subagents/*.jsonl`，
  // 子 agent 的 token 用量只记录在这些文件中。
  const script = [
    "import json,sys,os,glob",
    "p=sys.argv[1]; f=sys.argv[2]",
    "lines=open(f,'r',encoding='utf-8').read().splitlines()",
    "if p=='codebuddy':",
    " d=os.path.join(os.path.dirname(f),os.path.splitext(os.path.basename(f))[0],'subagents')",
    " for s in sorted(glob.glob(os.path.join(d,'*.jsonl'))):",
    "  try: lines+=open(s,'r',encoding='utf-8').read().splitlines()",
    "  except Exception: pass",
    "print(json.dumps(lines))"
  ].join("\n");
  return `python3 -c ${shellQuote(script)} ${shellQuote(provider)} ${shellQuote(transcriptPath)}`;
}

function runProcess(command, args, spawn = defaultSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf-8");
      if (Buffer.byteLength(stdout, "utf-8") > MAX_TRANSCRIPT_BYTES) child.kill();
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf-8"); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `Transcript reader exited with code ${code}.`)));
  });
}

function runSsh(sessionId, command, sshSessionRuntime) {
  return sshSessionRuntime.connectClient(sessionId, { actionName: "Agent token statistics", timeoutMs: 10000 })
    .then(client => new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) { client.end(); reject(error); return; }
        let stdout = "";
        let stderr = "";
        stream.on("data", chunk => { stdout += chunk.toString("utf-8"); });
        stream.stderr?.on("data", chunk => { stderr += chunk.toString("utf-8"); });
        stream.on("close", code => {
          client.end();
          if (code === 0) resolve(stdout); else reject(new Error(stderr.trim() || `Remote transcript reader exited with code ${code}.`));
        });
      });
    }));
}

function subtractTokens(current, baseline) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, Math.max(0, safeInteger(current?.[field]) - safeInteger(baseline?.[field]))]));
}

function isLocalSshBridge(session) {
  return session?.type === "ssh" && session.agentLocation === "local";
}

function hasHostReadableTranscript(session) {
  return session?.type === "windows" || session?.type === "wsl" || isLocalSshBridge(session);
}

function getHookEventName(input) {
  const value = input?.hook_event_name || input?.hookEventName || input?.eventName || input?.event_name;
  return ({
    session_start: "SessionStart",
    user_prompt_submit: "UserPromptSubmit",
    pre_tool_use: "PreToolUse",
    post_tool_use: "PostToolUse",
    post_tool_use_failure: "PostToolUseFailure",
    stop: "Stop",
    stop_failure: "StopFailure",
    session_end: "SessionEnd"
  })[value] || value;
}

function isNestedAgentTranscript(provider, transcriptPath) {
  return provider === "codebuddy" && /(?:^|[\\/])subagents(?:[\\/]|$)/i.test(String(transcriptPath || ""));
}

function createAgentTokenStatsService({
  terminalManager,
  statsStore,
  sshSessionRuntime,
  broadcast = () => {},
  spawn = defaultSpawn,
  now = () => Date.now(),
  retryDelaysMs = RETRY_DELAYS_MS,
  pollIntervalMs = LIVE_POLL_INTERVAL_MS,
  fsPromises = fs.promises,
  toWslHostPathFn = toWslHostPath,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  conversationSink = null
}) {
  const pending = new Map();
  const baselinePending = new Map();
  const startedAtBySession = new Map();
  const liveTrackers = new Map();
  const openCodeTrackers = new Map();
  const remoteSnapshots = new Map();

  function normalizeOpenCodeMessage(input) {
    const info = input?.info;
    if (info?.role !== "assistant" || !info.id || !info.tokens || typeof info.tokens !== "object") return null;
    const freshInputTokens = safeInteger(info.tokens.input);
    const cachedInputTokens = safeInteger(info.tokens.cache?.read);
    const cacheWriteInputTokens = safeInteger(info.tokens.cache?.write);
    const outputTokens = safeInteger(info.tokens.output);
    const reasoningOutputTokens = safeInteger(info.tokens.reasoning);
    const inputTokens = freshInputTokens + cachedInputTokens + cacheWriteInputTokens;
    return {
      id: String(info.id),
      model: String(info.modelID || "").trim(),
      tokens: {
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens: inputTokens + outputTokens + reasoningOutputTokens
      }
    };
  }

  function ensureOpenCodeTracker(input, session) {
    const agentSessionId = input?.session_id || input?.sessionId;
    if (!agentSessionId) return null;
    let tracker = openCodeTrackers.get(session.id);
    if (!tracker || tracker.agentSessionId !== agentSessionId) {
      tracker = {
        panelSessionId: session.id,
        agentSessionId,
        provider: "opencode",
        session,
        messages: new Map(),
        rawTokens: emptyTokens(),
        rawCapabilities: emptyCapabilityUsage("unavailable"),
        sessionBaseline: emptyTokens(),
        sessionCapabilityBaseline: emptyCapabilityUsage("unavailable"),
        turnBaseline: emptyTokens(),
        turnStartedAt: null,
        state: "waiting",
        models: [],
        updatedAt: now(),
        outputTokensPerSecond: 0
      };
      openCodeTrackers.set(session.id, tracker);
    }
    return tracker;
  }

  function recomputeOpenCodeTokens(tracker) {
    const tokens = emptyTokens();
    for (const message of tracker.messages.values()) {
      for (const field of TOKEN_FIELDS) tokens[field] += safeInteger(message.tokens?.[field]);
    }
    tracker.rawTokens = tokens;
    tracker.models = [...new Set([...tracker.messages.values()].map(message => message.model).filter(Boolean))];
  }

  function updateOpenCodeRate(tracker) {
    if (!tracker.turnStartedAt) return;
    const turnOutput = Math.max(0, tracker.rawTokens.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
    const elapsedSeconds = Math.max(0.001, (now() - tracker.turnStartedAt) / 1000);
    tracker.outputTokensPerSecond = Math.round((turnOutput / elapsedSeconds) * 10) / 10;
  }

  function persistOpenCodeTracker(tracker, input) {
    if (tracker.rawTokens.totalTokens === 0) return;
    statsStore.update({
      provider: "opencode",
      agentSessionId: tracker.agentSessionId,
      panelSessionId: tracker.panelSessionId,
      templateId: tracker.session.templateId,
      title: tracker.session.title,
      cwd: input?.cwd || tracker.session.cwd,
      location: tracker.session.type,
      models: tracker.models,
      tokens: tracker.rawTokens,
      capabilities: tracker.rawCapabilities,
      startedAt: startedAtBySession.get(`opencode:${tracker.agentSessionId}`),
      timestamp: now()
    });
  }

  function handleOpenCodeHook(input, session) {
    const eventName = input?.hook_event_name || input?.eventName || input?.event_name;
    const tracker = ensureOpenCodeTracker(input, session);
    if (!tracker) return;
    const key = `opencode:${tracker.agentSessionId}`;
    if (!startedAtBySession.has(key)) startedAtBySession.set(key, now());

    if (eventName === "session.status" && (input.status?.type || input.status) === "busy") {
      tracker.turnBaseline = cloneTokens(tracker.rawTokens);
      tracker.turnStartedAt = now();
      tracker.outputTokensPerSecond = 0;
      tracker.state = "generating";
      tracker.updatedAt = now();
      emitLive(tracker);
      return;
    }

    if (eventName === "message.updated") {
      const message = normalizeOpenCodeMessage(input);
      if (!message) return;
      const previous = tracker.messages.get(message.id);
      if (message.tokens.totalTokens === 0 && previous?.tokens?.totalTokens > 0) return;
      tracker.messages.set(message.id, message);
      recomputeOpenCodeTokens(tracker);
      updateOpenCodeRate(tracker);
      tracker.updatedAt = now();
      emitLive(tracker);
      persistOpenCodeTracker(tracker, input);
      return;
    }

    if (eventName === "session.idle") {
      updateOpenCodeRate(tracker);
      tracker.turnStartedAt = null;
      tracker.state = "completed";
      tracker.updatedAt = now();
      emitLive(tracker);
    }
  }

  async function parseRemote(session, provider, transcriptPath) {
    const command = remoteParserCommand(provider, transcriptPath);
    const output = session.type === "wsl"
      ? await runProcess("wsl.exe", ["-d", session.wslDistro, "--", "bash", "-lc", command], spawn)
      : await runSsh(session.id, command, sshSessionRuntime);
    const lines = JSON.parse(output);
    return parseTranscriptText(provider, Array.isArray(lines) ? lines.join("\n") : "");
  }

  async function readWithRetry(session, provider, transcriptPath) {
    let lastError;
    for (const delay of retryDelaysMs) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        return session.type === "windows" || isLocalSshBridge(session)
          ? parseTranscriptFileWithSubagents(provider, transcriptPath)
          : await parseRemote(session, provider, transcriptPath);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function collect({ provider, input, session }) {
    if (!TOKEN_STATS_PROVIDERS.includes(provider) || !session || !input) return;
    const agentSessionId = input.session_id || input.sessionId;
    const transcriptPath = input.transcript_path || input.transcriptPath;
    if (!agentSessionId || !transcriptPath) return;
    const key = `${provider}:${agentSessionId}`;
    const request = Promise.resolve(baselinePending.get(key))
      .catch(() => undefined)
      .then(() => readWithRetry(session, provider, transcriptPath))
      .then(result => {
        const record = statsStore.update({
          provider,
          agentSessionId,
          panelSessionId: session.id,
          templateId: session.templateId,
          title: session.title,
          cwd: input.cwd || session.cwd,
          location: session.type,
          models: result.models.length ? result.models : [input.model].filter(Boolean),
          tokens: result.tokens,
          capabilities: result.capabilities,
          startedAt: startedAtBySession.get(key)
        });
        if (session.type === "ssh" && !isLocalSshBridge(session) && record) {
          const snapshot = {
            panelSessionId: session.id,
            provider,
            state: "completed",
            tokens: cloneTokens(record.tokens),
            capabilities: normalizeCapabilityUsage(record.capabilities),
            turnOutputTokens: 0,
            outputTokensPerSecond: 0,
            models: [...record.models],
            updatedAt: now()
          };
          remoteSnapshots.set(session.id, snapshot);
          broadcast("agent-token-live:changed", snapshot);
        }
        return record;
      })
      .catch(error => console.error(`Failed to collect ${provider} token statistics:`, error))
      .finally(() => { if (pending.get(key) === request) pending.delete(key); });
    pending.set(key, request);
  }

  function captureBaseline({ provider, input, session }) {
    const agentSessionId = input.session_id || input.sessionId;
    const transcriptPath = input.transcript_path || input.transcriptPath;
    if (!agentSessionId || !transcriptPath) return;
    const key = `${provider}:${agentSessionId}`;
    if (baselinePending.has(key)) return;
    const request = (session.type === "windows" || isLocalSshBridge(session)
      ? Promise.resolve().then(() => parseTranscriptFileWithSubagents(provider, transcriptPath))
      : parseRemote(session, provider, transcriptPath))
      .then(result => statsStore.setBaseline(provider, agentSessionId, result.tokens, result.capabilities))
      .catch(() => statsStore.setBaseline(provider, agentSessionId, {}, emptyCapabilityUsage()));
    baselinePending.set(key, request);
  }

  function getLiveHostPath(session, transcriptPath) {
    if (session.type === "windows" || isLocalSshBridge(session)) return transcriptPath;
    if (session.type === "wsl") return toWslHostPathFn(session.wslDistro, transcriptPath);
    return null;
  }

  function resetLiveReader(tracker) {
    tracker.offset = 0;
    tracker.pendingBytes = Buffer.alloc(0);
    tracker.parser = tracker.provider === "copilot" ? createCopilotOtelParser() : createIncrementalTranscriptParser(tracker.provider);
    tracker.conversationParser = tracker.provider === "codex" || tracker.provider === "codebuddy" || tracker.provider === "gemini" || tracker.provider === "grok"
      ? createAgentConversationTranscriptParser(tracker.provider)
      : null;
    // 主 parser 已重建，子 agent 文件需要从头重新喂入（parser 按 messageId 去重，不会重复计数）。
    for (const reader of tracker.subagentReaders?.values() || []) {
      reader.offset = 0;
      reader.pendingBytes = Buffer.alloc(0);
    }
  }

  function ensureLiveTracker({ provider, input, session }) {
    if (!LIVE_TOKEN_PROVIDERS.includes(provider) || !hasHostReadableTranscript(session)) return null;
    const agentSessionId = input?.session_id || input?.sessionId;
    const transcriptPath = provider === "copilot" ? getCopilotOtelPath(session) : input?.transcript_path || input?.transcriptPath;
    if (!agentSessionId || !transcriptPath) return null;
    if (isNestedAgentTranscript(provider, transcriptPath)) return null;
    const hostPath = getLiveHostPath(session, transcriptPath);
    let tracker = liveTrackers.get(session.id);
    if (!tracker || tracker.provider !== provider || tracker.agentSessionId !== agentSessionId || tracker.hostPath !== hostPath) {
      if (tracker?.timer) clearIntervalFn(tracker.timer);
      tracker = {
        panelSessionId: session.id,
        agentSessionId,
        provider,
        hostPath,
        fileIdentity: null,
        offset: 0,
        pendingBytes: Buffer.alloc(0),
        subagentReaders: new Map(),
        parser: provider === "copilot" ? createCopilotOtelParser() : createIncrementalTranscriptParser(provider),
        conversationParser: provider === "codex" || provider === "codebuddy" || provider === "gemini" || provider === "grok"
          ? createAgentConversationTranscriptParser(provider)
          : null,
        conversationActive: false,
        rawTokens: emptyTokens(),
        rawCapabilities: emptyCapabilityUsage(),
        sessionBaseline: provider === "copilot" ? emptyTokens() : null,
        sessionCapabilityBaseline: provider === "copilot" ? emptyCapabilityUsage("unavailable") : null,
        sessionBaselineInitialized: provider === "copilot",
        turnBaseline: emptyTokens(),
        turnStartedAt: null,
        state: "waiting",
        models: [],
        updatedAt: now(),
        outputTokensPerSecond: 0,
        timer: null,
        pollPromise: null,
        session
      };
      liveTrackers.set(session.id, tracker);
    }
    return tracker;
  }

  function buildLiveSnapshot(tracker) {
    const tokens = subtractTokens(tracker.rawTokens, tracker.sessionBaseline || emptyTokens());
    const capabilities = subtractCapabilities(tracker.rawCapabilities, tracker.sessionCapabilityBaseline || emptyCapabilityUsage());
    const turnOutputTokens = Math.max(0, tokens.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
    return {
      panelSessionId: tracker.panelSessionId,
      provider: tracker.provider,
      state: tracker.state,
      tokens,
      capabilities,
      turnOutputTokens,
      outputTokensPerSecond: tracker.outputTokensPerSecond,
      models: [...tracker.models],
      updatedAt: tracker.updatedAt
    };
  }

  function initializeSessionBaseline(tracker, tokens = tracker.rawTokens, capabilities = tracker.rawCapabilities) {
    tracker.sessionBaseline = cloneTokens(tokens);
    tracker.sessionCapabilityBaseline = normalizeCapabilityUsage(capabilities);
    tracker.sessionBaselineInitialized = true;
  }

  function initializeCodeBuddySessionStartBaseline(tracker, input) {
    if (tracker.provider !== "codebuddy") return false;
    const source = String(input?.source || "").trim().toLowerCase();
    if (source === "resume" || source === "compact") return false;
    if (source === "clear") {
      resetLiveReader(tracker);
      tracker.fileIdentity = null;
      tracker.rawTokens = emptyTokens();
      tracker.rawCapabilities = emptyCapabilityUsage();
      tracker.models = [];
      tracker.turnBaseline = emptyTokens();
      tracker.turnStartedAt = null;
      tracker.outputTokensPerSecond = 0;
      tracker.state = "waiting";
    }
    initializeSessionBaseline(tracker, emptyTokens(), emptyCapabilityUsage());
    return source === "clear";
  }

  function emitLive(tracker) {
    const snapshot = buildLiveSnapshot(tracker);
    broadcast("agent-token-live:changed", snapshot);
    return snapshot;
  }

  function persistCopilotTracker(tracker, result) {
    if (tracker.provider !== "copilot" || !result) return;
    const agentSessionId = result.agentSessionId || tracker.agentSessionId;
    statsStore.update({
      provider: "copilot",
      agentSessionId,
      panelSessionId: tracker.panelSessionId,
      templateId: tracker.session.templateId,
      title: tracker.session.title,
      cwd: tracker.session.cwd,
      location: tracker.session.type,
      models: result.models,
      tokens: result.tokens,
      capabilities: result.capabilities,
      startedAt: startedAtBySession.get(`copilot:${tracker.agentSessionId}`)
    });
  }

  async function readAppendedBytes(tracker) {
    const stat = await fsPromises.stat(tracker.hostPath);
    if (stat.size > MAX_TRANSCRIPT_BYTES) throw new Error("Agent transcript exceeds the live monitoring size limit.");
    const fileIdentity = `${stat.dev ?? ""}:${stat.ino ?? ""}:${stat.birthtimeMs ?? ""}`;
    if (tracker.fileIdentity !== null && tracker.fileIdentity !== fileIdentity) resetLiveReader(tracker);
    tracker.fileIdentity = fileIdentity;
    if (stat.size < tracker.offset) resetLiveReader(tracker);
    if (stat.size === tracker.offset) return false;
    const length = stat.size - tracker.offset;
    const handle = await fsPromises.open(tracker.hostPath, "r");
    let bytesRead = 0;
    const buffer = Buffer.alloc(length);
    try {
      while (bytesRead < length) {
        const result = await handle.read(buffer, bytesRead, length - bytesRead, tracker.offset + bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await handle.close();
    }
    tracker.offset += bytesRead;
    const combined = Buffer.concat([tracker.pendingBytes, buffer.subarray(0, bytesRead)]);
    let lineStart = 0;
    let parsedUsage = false;
    const conversationMessages = [];
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      let line = combined.subarray(lineStart, index);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length) {
        const text = line.toString("utf-8");
        parsedUsage = tracker.parser.pushLine(text) || parsedUsage;
        if (tracker.conversationActive && tracker.conversationParser) {
          conversationMessages.push(...tracker.conversationParser.pushLine(text));
        } else if (tracker.conversationParser) {
          tracker.conversationParser.pushLine(text);
        }
      }
      lineStart = index + 1;
    }
    tracker.pendingBytes = combined.subarray(lineStart);
    if (conversationMessages.length) {
      conversationSink?.appendMessages?.(tracker.panelSessionId, conversationMessages);
    }
    return parsedUsage;
  }

  // CodeBuddy 子 agent 的 usage 只写入主 transcript 同级的 `<sessionId>/subagents/agent-*.jsonl`。
  // 这里增量 tail 这些文件并把行喂入主 parser（messageId 各文件独立，按 UUID 天然不冲突），
  // 使实时 token 统计包含子 agent 的消耗。子 agent 行不进入 conversationParser，避免污染主会话视图。
  async function readSubagentAppendedBytes(tracker) {
    if (tracker.provider !== "codebuddy") return;
    const subagentsDir = getCodeBuddySubagentsDir(tracker.hostPath);
    if (!subagentsDir) return;
    let entries;
    try { entries = await fsPromises.readdir(subagentsDir); } catch { return; }
    for (const entry of [...entries].sort()) {
      if (!entry.toLowerCase().endsWith(".jsonl")) continue;
      const filePath = path.join(subagentsDir, entry);
      try {
        const stat = await fsPromises.stat(filePath);
        if (stat.size > MAX_TRANSCRIPT_BYTES) continue;
        let reader = tracker.subagentReaders.get(filePath);
        if (!reader) {
          reader = { offset: 0, pendingBytes: Buffer.alloc(0) };
          tracker.subagentReaders.set(filePath, reader);
        }
        if (stat.size < reader.offset) {
          reader.offset = 0;
          reader.pendingBytes = Buffer.alloc(0);
        }
        if (stat.size === reader.offset) continue;
        const length = stat.size - reader.offset;
        const handle = await fsPromises.open(filePath, "r");
        const buffer = Buffer.alloc(length);
        let bytesRead = 0;
        try {
          while (bytesRead < length) {
            const result = await handle.read(buffer, bytesRead, length - bytesRead, reader.offset + bytesRead);
            if (!result.bytesRead) break;
            bytesRead += result.bytesRead;
          }
        } finally {
          await handle.close();
        }
        reader.offset += bytesRead;
        const combined = Buffer.concat([reader.pendingBytes, buffer.subarray(0, bytesRead)]);
        let lineStart = 0;
        for (let index = 0; index < combined.length; index += 1) {
          if (combined[index] !== 0x0a) continue;
          let line = combined.subarray(lineStart, index);
          if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
          if (line.length) tracker.parser.pushLine(line.toString("utf-8"));
          lineStart = index + 1;
        }
        reader.pendingBytes = combined.subarray(lineStart);
      } catch { /* 跳过暂时不可读的子 agent transcript */ }
    }
  }

  async function pollLive(tracker, { emit = true } = {}) {
    if (tracker.pollPromise) return tracker.pollPromise;
    const request = readAppendedBytes(tracker)
      .then(() => readSubagentAppendedBytes(tracker))
      .then(() => {
      const result = tracker.parser.getResult();
      if (result) {
        if (tracker.state === "unavailable") {
            tracker.state = tracker.turnStartedAt ? (tracker.timer ? "generating" : "completed") : "waiting";
          }
          tracker.rawTokens = cloneTokens(result.tokens);
          tracker.rawCapabilities = normalizeCapabilityUsage(result.capabilities);
          tracker.models = result.models;
          persistCopilotTracker(tracker, result);
          if (!tracker.sessionBaselineInitialized) initializeSessionBaseline(tracker, result.tokens, result.capabilities);
          if (tracker.state === "generating" && tracker.turnStartedAt) {
            const visible = subtractTokens(tracker.rawTokens, tracker.sessionBaseline);
            const turnOutput = Math.max(0, visible.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
            const elapsedSeconds = Math.max(0.001, (now() - tracker.turnStartedAt) / 1000);
            tracker.outputTokensPerSecond = Math.round((turnOutput / elapsedSeconds) * 10) / 10;
          }
          tracker.updatedAt = now();
        }
        if (emit) emitLive(tracker);
        return result;
      })
      .catch(() => {
        tracker.state = "unavailable";
        tracker.updatedAt = now();
        if (emit) emitLive(tracker);
        return null;
      })
      .finally(() => { if (tracker.pollPromise === request) tracker.pollPromise = null; });
    tracker.pollPromise = request;
    return request;
  }

  function stopLiveTimer(tracker) {
    if (!tracker?.timer) return;
    clearIntervalFn(tracker.timer);
    tracker.timer = null;
  }

  function startLiveTimer(tracker) {
    stopLiveTimer(tracker);
    tracker.timer = setIntervalFn(() => { void pollLive(tracker); }, pollIntervalMs);
  }

  async function startLiveTurn(tracker) {
    // CodeBuddy 的 Hook 请求返回后 CLI 会立即继续生成；若首次异步读取尚未开始，
    // 先以 Hook 到达时已经解析到的值定基线，避免第一条 usage 被读取过程吞进基线。
    if (tracker.provider === "codebuddy" && !tracker.sessionBaselineInitialized && !tracker.pollPromise) {
      initializeSessionBaseline(tracker);
    }
    await pollLive(tracker, { emit: false });
    tracker.conversationActive = true;
    if (!tracker.sessionBaselineInitialized) initializeSessionBaseline(tracker);
    const visible = subtractTokens(tracker.rawTokens, tracker.sessionBaseline);
    tracker.turnBaseline = cloneTokens(visible);
    tracker.turnStartedAt = now();
    tracker.outputTokensPerSecond = 0;
    tracker.state = "generating";
    tracker.updatedAt = now();
    emitLive(tracker);
    startLiveTimer(tracker);
  }

  async function completeLiveTurn(tracker) {
    await pollLive(tracker, { emit: false });
    if (tracker.pendingBytes.length) {
      const pendingText = tracker.pendingBytes.toString("utf-8");
      if (tracker.parser.pushLine(pendingText)) {
        const result = tracker.parser.getResult();
        tracker.rawTokens = cloneTokens(result?.tokens || tracker.rawTokens);
        tracker.models = result?.models || tracker.models;
        persistCopilotTracker(tracker, result);
      }
      const messages = tracker.conversationParser?.pushLine(pendingText) || [];
      if (messages.length) conversationSink?.appendMessages?.(tracker.panelSessionId, messages);
      tracker.pendingBytes = Buffer.alloc(0);
    }
    tracker.conversationActive = false;
    if (tracker.turnStartedAt) {
      const visible = subtractTokens(tracker.rawTokens, tracker.sessionBaseline || emptyTokens());
      const turnOutput = Math.max(0, visible.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
      const elapsedSeconds = Math.max(0.001, (now() - tracker.turnStartedAt) / 1000);
      tracker.outputTokensPerSecond = Math.round((turnOutput / elapsedSeconds) * 10) / 10;
    }
    tracker.state = "completed";
    tracker.updatedAt = now();
    stopLiveTimer(tracker);
    emitLive(tracker);
  }

  function getStopFinalMessage(provider, input) {
    if (provider !== "codex" && provider !== "gemini" && provider !== "grok") return null;
    const text = input?.prompt_response ?? input?.last_assistant_message ?? input?.lastAssistantMessage;
    if (typeof text !== "string" || !text.trim()) return null;
    const messageId = input?.event_id || input?.eventId || input?.turn_id || input?.turnId;
    return {
      id: `stop:${messageId || now()}`,
      provider,
      text: text.trim(),
      timestamp: now()
    };
  }

  function completeConversationTurn(sessionId, finalMessage) {
    if (finalMessage) conversationSink?.completeTurn?.(sessionId, finalMessage);
    else conversationSink?.completeTurn?.(sessionId);
  }

  return {
    handleHook({ provider, input, session }) {
      if (provider === "opencode") {
        handleOpenCodeHook(input, session);
        return;
      }
      const eventName = getHookEventName(input);
      const agentSessionId = input?.session_id || input?.sessionId;
      const transcriptPath = input?.transcript_path || input?.transcriptPath;
      if (isNestedAgentTranscript(provider, transcriptPath)) return;
      if (TOKEN_STATS_PROVIDERS.includes(provider) && agentSessionId) {
        const key = `${provider}:${agentSessionId}`;
        if (!startedAtBySession.has(key)) startedAtBySession.set(key, now());
        if (provider !== "copilot" && (eventName === "SessionStart" || eventName === "UserPromptSubmit" || eventName === "BeforeAgent")) captureBaseline({ provider, input, session });
      }

      const tracker = ensureLiveTracker({ provider, input, session });
      if (tracker && eventName === "SessionStart") {
        const deferCodeBuddyClearRead = initializeCodeBuddySessionStartBaseline(tracker, input);
        if (!deferCodeBuddyClearRead) void pollLive(tracker);
      }
      if ((provider === "codex" || provider === "codebuddy" || provider === "gemini" || provider === "grok") && (eventName === "UserPromptSubmit" || eventName === "BeforeAgent")) {
        conversationSink?.startTurn?.({
          sessionId: session.id,
          sessionTitle: session.title,
          provider,
          supported: Boolean(tracker),
          userMessage: input.prompt,
          userMessageId: input.event_id || input.eventId || input.turn_id || input.turnId,
          timestamp: now()
        });
      }
      if (tracker && (eventName === "UserPromptSubmit" || eventName === "BeforeAgent")) void startLiveTurn(tracker);
      if (tracker && (eventName === "Stop" || eventName === "AfterAgent")) {
        const finalMessage = getStopFinalMessage(provider, input);
        void completeLiveTurn(tracker).finally(() => completeConversationTurn(session.id, finalMessage));
      } else if ((provider === "codex" || provider === "codebuddy" || provider === "gemini" || provider === "grok") && (eventName === "Stop" || eventName === "AfterAgent")) {
        completeConversationTurn(session.id, getStopFinalMessage(provider, input));
      }

      if (provider !== "copilot" && (eventName === "Stop" || eventName === "AfterAgent" || eventName === "SessionEnd")) collect({ provider, input, session });
    },
    getLive(panelSessionId) {
      const openCodeTracker = openCodeTrackers.get(String(panelSessionId || ""));
      if (openCodeTracker) return buildLiveSnapshot(openCodeTracker);
      const tracker = liveTrackers.get(String(panelSessionId || ""));
      return tracker ? buildLiveSnapshot(tracker) : remoteSnapshots.get(String(panelSessionId || "")) || null;
    },
    markEnded(panelSessionId) {
      const tracker = liveTrackers.get(panelSessionId);
      stopLiveTimer(tracker);
      liveTrackers.delete(panelSessionId);
      openCodeTrackers.delete(panelSessionId);
      remoteSnapshots.delete(panelSessionId);
      statsStore.markEnded(panelSessionId);
      conversationSink?.clearSession?.(panelSessionId);
    },
    shutdown() {
      for (const tracker of liveTrackers.values()) stopLiveTimer(tracker);
      liveTrackers.clear();
      openCodeTrackers.clear();
      remoteSnapshots.clear();
    }
  };
}

module.exports = {
  LIVE_POLL_INTERVAL_MS,
  createAgentTokenStatsService,
  isNestedAgentTranscript,
  remoteParserCommand,
  shellQuote,
  subtractTokens
};
