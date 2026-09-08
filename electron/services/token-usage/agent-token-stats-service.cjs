const { spawn: defaultSpawn } = require("node:child_process");
const {
  emptyCapabilityUsage,
  parseTranscriptFileWithSubagents,
  parseTranscriptText
} = require("./agent-token-transcript.cjs");
const { subtractTokens } = require("./token-usage-values.cjs");
const { toWslHostPath } = require("../remote-files/index.cjs");
const { createAgentConversationTranscriptParser } = require("../conversation-history/index.cjs");
const {
  LIVE_POLL_INTERVAL_MS,
  REMOTE_DELTA_SCRIPT,
  createAgentTokenLiveModule,
  isNestedAgentTranscript,
  remoteDeltaCommand
} = require("./live/index.cjs");

const RETRY_DELAYS_MS = [150, 500, 1200];
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const TOKEN_STATS_PROVIDERS = ["codex", "claude", "codebuddy", "opencode", "qoder", "copilot", "gemini", "grok"];
const CONVERSATION_PROVIDERS = ["codex", "codebuddy", "gemini", "grok"];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function remoteParserCommand(provider, transcriptPath) {
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
    child.once("close", code => code === 0
      ? resolve(stdout)
      : reject(new Error(stderr.trim() || `Transcript reader exited with code ${code}.`)));
  });
}

function isLocalSshBridge(session) {
  return session?.type === "ssh" && session.agentLocation === "local";
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

function createAgentTokenStatsService({
  terminalManager,
  statsStore,
  sshAgentTransport,
  broadcast = () => {},
  spawn = defaultSpawn,
  now = () => Date.now(),
  retryDelaysMs = RETRY_DELAYS_MS,
  pollIntervalMs = LIVE_POLL_INTERVAL_MS,
  fsPromises,
  toWslHostPathFn = toWslHostPath,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  conversationSink = null
}) {
  void terminalManager;
  const pending = new Map();
  const baselinePending = new Map();
  const startedAtBySession = new Map();
  const conversations = new Map();
  const sessionLifetimes = new Map();

  function conversationSupported(provider, session) {
    return CONVERSATION_PROVIDERS.includes(provider) && (
      session?.type === "windows" || session?.type === "wsl" || isLocalSshBridge(session)
    );
  }

  function ensureConversation(panelSessionId, provider, session) {
    if (!conversationSupported(provider, session)) return null;
    let state = conversations.get(panelSessionId);
    if (!state || state.provider !== provider) {
      state = { provider, parser: createAgentConversationTranscriptParser(provider) };
      conversations.set(panelSessionId, state);
    }
    return state;
  }

  function resetConversation(tracker) {
    const state = conversations.get(tracker.panelSessionId);
    if (state) state.parser = createAgentConversationTranscriptParser(state.provider);
  }

  function consumeConversationLine(tracker, line) {
    const state = ensureConversation(tracker.panelSessionId, tracker.provider, tracker.session);
    if (!state) return;
    const messages = state.parser.pushLine(line);
    if (tracker.conversationActive && messages.length) conversationSink?.appendMessages?.(tracker.panelSessionId, messages);
  }

  function persistLiveUsage({ tracker, input, tokens, models, result }) {
    if (tracker.provider === "opencode") {
      statsStore.update({
        provider: "opencode",
        agentSessionId: tracker.agentSessionId,
        panelSessionId: tracker.panelSessionId,
        templateId: tracker.session.templateId,
        title: tracker.session.title,
        cwd: input?.cwd || tracker.session.cwd,
        location: tracker.session.type,
        models,
        tokens,
        capabilities: tracker.rawCapabilities,
        startedAt: startedAtBySession.get(`opencode:${tracker.agentSessionId}`),
        timestamp: now()
      });
      return;
    }
    if (tracker.provider === "copilot" && result) {
      statsStore.update({
        provider: "copilot",
        agentSessionId: result.agentSessionId || tracker.agentSessionId,
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
  }

  const liveModule = createAgentTokenLiveModule({
    sshAgentTransport,
    emitSnapshot: snapshot => broadcast("agent-token-live:changed", snapshot),
    onUsage: persistLiveUsage,
    onMainLine: consumeConversationLine,
    onSourceReset: resetConversation,
    now,
    pollIntervalMs,
    fsPromises,
    toWslHostPath: toWslHostPathFn,
    setIntervalFn,
    clearIntervalFn
  });

  async function parseRemote(session, provider, transcriptPath) {
    const command = remoteParserCommand(provider, transcriptPath);
    const output = session.type === "wsl"
      ? await runProcess("wsl.exe", ["-d", session.wslDistro, "--", "bash", "-lc", command], spawn)
      : await sshAgentTransport.exec(session.id, command, {
        actionName: "Agent token statistics",
        timeoutMs: 10000
      });
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
    const lifetime = sessionLifetimes.get(session.id);
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
        if (session.type === "ssh" && !isLocalSshBridge(session) && record && sessionLifetimes.get(session.id) === lifetime) {
          liveModule.setCompletedSnapshot(session.id, record);
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

  function getStopFinalMessage(provider, input) {
    if (provider !== "codex" && provider !== "gemini" && provider !== "grok") return null;
    const text = input?.prompt_response ?? input?.last_assistant_message ?? input?.lastAssistantMessage;
    if (typeof text !== "string" || !text.trim()) return null;
    const messageId = input?.event_id || input?.eventId || input?.turn_id || input?.turnId;
    return { id: `stop:${messageId || now()}`, provider, text: text.trim(), timestamp: now() };
  }

  function completeConversationTurn(sessionId, finalMessage) {
    if (finalMessage) conversationSink?.completeTurn?.(sessionId, finalMessage);
    else conversationSink?.completeTurn?.(sessionId);
  }

  return {
    handleHook({ provider, input, session }) {
      if (session && !sessionLifetimes.has(session.id)) sessionLifetimes.set(session.id, {});
      const eventName = getHookEventName(input);
      const agentSessionId = input?.session_id || input?.sessionId;
      const transcriptPath = input?.transcript_path || input?.transcriptPath;
      if (isNestedAgentTranscript(provider, transcriptPath)) return;
      if (TOKEN_STATS_PROVIDERS.includes(provider) && agentSessionId) {
        const key = `${provider}:${agentSessionId}`;
        if (!startedAtBySession.has(key)) startedAtBySession.set(key, now());
        if (provider !== "copilot" && provider !== "opencode" && (
          eventName === "SessionStart" || eventName === "UserPromptSubmit" || eventName === "BeforeAgent"
        )) captureBaseline({ provider, input, session });
      }

      const liveResult = liveModule.handleEvent({ provider, eventName, input, session });
      if (CONVERSATION_PROVIDERS.includes(provider) && (eventName === "UserPromptSubmit" || eventName === "BeforeAgent")) {
        const conversation = liveResult?.tracker ? ensureConversation(session.id, provider, session) : null;
        conversationSink?.startTurn?.({
          sessionId: session.id,
          sessionTitle: session.title,
          provider,
          supported: Boolean(conversation),
          userMessage: input.prompt,
          userMessageId: input.event_id || input.eventId || input.turn_id || input.turnId,
          timestamp: now()
        });
      }

      if (CONVERSATION_PROVIDERS.includes(provider) && (eventName === "Stop" || eventName === "AfterAgent")) {
        const finalMessage = getStopFinalMessage(provider, input);
        if (liveResult?.completion) {
          void liveResult.completion.finally(() => completeConversationTurn(session.id, finalMessage));
        } else completeConversationTurn(session.id, finalMessage);
      }
      if (provider !== "copilot" && provider !== "opencode" && (
        eventName === "Stop" || eventName === "AfterAgent" || eventName === "SessionEnd"
      )) collect({ provider, input, session });
    },
    getLive(panelSessionId) {
      return liveModule.getSnapshot(panelSessionId);
    },
    markEnded(panelSessionId) {
      sessionLifetimes.delete(panelSessionId);
      liveModule.endSession(panelSessionId);
      conversations.delete(panelSessionId);
      statsStore.markEnded(panelSessionId);
      conversationSink?.clearSession?.(panelSessionId);
    },
    shutdown() {
      sessionLifetimes.clear();
      liveModule.shutdown();
      conversations.clear();
    }
  };
}

module.exports = {
  LIVE_POLL_INTERVAL_MS,
  REMOTE_DELTA_SCRIPT,
  createAgentTokenStatsService,
  isNestedAgentTranscript,
  remoteDeltaCommand,
  remoteParserCommand,
  shellQuote,
  subtractTokens
};
