const { spawn: defaultSpawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  emptyCapabilityUsage,
  parseTranscriptFileWithSubagents,
  parseTranscriptText
} = require("./agent-token-transcript.cjs");
const { subtractTokens } = require("./token-usage-values.cjs");
const { readOpenCodeExport } = require("./opencode-export.cjs");
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
const CODEBUDDY_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,299}$/;
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
  conversationSink = null,
  homeDir = os.homedir(),
  readOpenCodeExportFn = readOpenCodeExport
}) {
  void terminalManager;
  const pending = new Map();
  const baselinePending = new Map();
  const startedAtBySession = new Map();
  const conversations = new Map();
  const sessionLifetimes = new Map();
  const graphicalCodeBuddy = new Map();
  const graphicalCodeBuddyLive = new Map();
  const graphicalOpenCode = new Map();
  const codeBuddyWrites = new Map();
  let graphicalEpoch = 0;

  function queueCodeBuddyWrite(key, work) {
    const previous = codeBuddyWrites.get(key) || Promise.resolve();
    const request = previous.then(work, work);
    codeBuddyWrites.set(key, request);
    void request.finally(() => { if (codeBuddyWrites.get(key) === request) codeBuddyWrites.delete(key); });
    return request;
  }

  async function findCodeBuddyTranscript(session, agentSessionId) {
    if (!CODEBUDDY_SESSION_ID.test(agentSessionId)) throw new Error("Invalid CodeBuddy session ID.");
    if (session.type === "windows" || isLocalSshBridge(session)) {
      const root = path.join(homeDir, ".codebuddy", "projects");
      const matches = [];
      for (const directory of await fs.promises.readdir(root, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        const candidate = path.join(root, directory.name, `${agentSessionId}.jsonl`);
        try { if ((await fs.promises.stat(candidate)).isFile()) matches.push(candidate); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (matches.length !== 1) throw new Error(`CodeBuddy transcript match count: ${matches.length}.`);
      return matches[0];
    }
    const script = [
      "import glob,json,os,sys",
      "sid=sys.argv[1]",
      "root=os.path.expanduser('~/.codebuddy/projects')",
      "matches=[p for p in glob.glob(os.path.join(root,'*',sid+'.jsonl')) if os.path.isfile(p)]",
      "print(json.dumps(matches))"
    ].join("\n");
    const command = `python3 -c ${shellQuote(script)} ${shellQuote(agentSessionId)}`;
    const output = session.type === "wsl"
      ? await runProcess("wsl.exe", ["-d", session.wslDistro, "--", "bash", "-lc", command], spawn)
      : await sshAgentTransport.exec(session.id, command, { actionName: "CodeBuddy token statistics", timeoutMs: 10000 });
    const matches = JSON.parse(output);
    if (!Array.isArray(matches) || matches.length !== 1 || typeof matches[0] !== "string")
      throw new Error(`CodeBuddy transcript match count: ${Array.isArray(matches) ? matches.length : "invalid"}.`);
    return matches[0];
  }

  function recordGraphicalCodeBuddy({ threadId, session, cwd, model, resumed = false, baseline = false }) {
    if (!threadId || !session || !CODEBUDDY_SESSION_ID.test(threadId)) return Promise.resolve();
    const key = `codebuddy:${threadId}`;
    let state = graphicalCodeBuddy.get(key);
    if (!state) {
      state = { initialized: !resumed, panelSessionId: session.id, queue: Promise.resolve() };
      graphicalCodeBuddy.set(key, state);
    }
    const epoch = graphicalEpoch;
    const work = async () => {
      if (epoch !== graphicalEpoch) return;
      try {
        const transcriptPath = state.transcriptPath || await findCodeBuddyTranscript(session, threadId);
        const result = await readWithRetry(session, "codebuddy", transcriptPath);
        if (epoch !== graphicalEpoch) return;
        state.transcriptPath = transcriptPath;
        if (baseline || !state.initialized) {
          statsStore.setBaseline("codebuddy", threadId, result.tokens, result.capabilities);
          state.initialized = true;
          if (baseline || resumed) return;
        }
        const record = statsStore.update({ provider: "codebuddy", agentSessionId: threadId,
          panelSessionId: session.id, templateId: session.templateId, title: session.title,
          cwd: cwd || session.cwd, location: session.type,
          models: result.models.length ? result.models : [model].filter(Boolean),
          tokens: result.tokens, capabilities: result.capabilities });
        if (record && !graphicalCodeBuddyLive.get(session.id)?.tracker)
          liveModule.setCompletedSnapshot(session.id, record);
      } catch (error) {
        console.error("Failed to collect graphical CodeBuddy token statistics:", error);
      }
    };
    state.queue = queueCodeBuddyWrite(key, work);
    return state.queue;
  }

  function recordGraphicalOpenCode({ threadId, session, cwd, model, environment, resumed = false, baseline = false }) {
    if (!threadId || !session) return Promise.resolve();
    const key = `opencode:${threadId}`;
    let state = graphicalOpenCode.get(key);
    if (!state) {
      state = { initialized: !resumed, panelSessionId: session.id, queue: Promise.resolve() };
      graphicalOpenCode.set(key, state);
    }
    const epoch = graphicalEpoch;
    const work = async () => {
      if (epoch !== graphicalEpoch) return;
      try {
        const result = await readOpenCodeExportFn({ threadId, session, cwd, environment,
          sshAgentTransport, spawn });
        if (epoch !== graphicalEpoch) return;
        if (baseline || !state.initialized) {
          statsStore.setBaseline("opencode", threadId, result.tokens);
          state.initialized = true;
          return;
        }
        const record = statsStore.update({ provider: "opencode", agentSessionId: threadId,
          panelSessionId: session.id, templateId: session.templateId, title: session.title,
          cwd: cwd || session.cwd, location: session.type,
          models: result.models.length ? result.models : [model].filter(Boolean), tokens: result.tokens });
        if (record) liveModule.setCompletedSnapshot(session.id, record);
      } catch (error) {
        console.error("Failed to collect graphical OpenCode token statistics:", error);
      }
    };
    state.queue = state.queue.then(work, work);
    return state.queue;
  }

  function resetGraphicalCodeBuddyBaselines() {
    graphicalEpoch++;
    graphicalCodeBuddy.clear();
    for (const state of graphicalOpenCode.values()) state.initialized = false;
    codeBuddyWrites.clear();
    for (const state of graphicalCodeBuddyLive.values()) {
      state.generation++;
      liveModule.endSession(state.session.id);
      state.resumed = true;
      state.tracker = null;
      state.trackingTurn = false;
      if (state.timer) clearIntervalFn(state.timer);
      state.timer = setIntervalFn(() => { void findGraphicalCodeBuddyLive(state); }, pollIntervalMs);
      state.timer.unref?.();
      void Promise.resolve(state.pending).finally(() => { void findGraphicalCodeBuddyLive(state); });
    }
  }

  async function findGraphicalCodeBuddyLive(state) {
    if (state.pending) return state.pending;
    const generation = state.generation;
    const request = (async () => {
      if (graphicalCodeBuddyLive.get(state.session.id) !== state || state.tracker) return;
      let transcriptPath;
      try { transcriptPath = await findCodeBuddyTranscript(state.session, state.threadId); }
      catch { return; }
      if (graphicalCodeBuddyLive.get(state.session.id) !== state || state.generation !== generation) return;
      const input = { session_id: state.threadId, transcript_path: transcriptPath,
        source: state.resumed ? "resume" : "startup" };
      const result = liveModule.handleEvent({ provider: "codebuddy", eventName: "SessionStart",
        input, session: state.session });
      state.tracker = result?.tracker || null;
      if (!state.tracker) return;
      state.transcriptPath = transcriptPath;
      if (state.timer) { clearIntervalFn(state.timer); state.timer = null; }
      if (state.resumed && state.tracker.pollPromise) await state.tracker.pollPromise;
      if (graphicalCodeBuddyLive.get(state.session.id) !== state || state.generation !== generation) return;
      if (state.turnActive) {
        liveModule.handleEvent({ provider: "codebuddy", eventName: "UserPromptSubmit",
          input, session: state.session });
        state.trackingTurn = true;
      }
    })();
    state.pending = request;
    try { await request; } finally { if (state.pending === request) state.pending = null; }
  }

  async function handleGraphicalCodeBuddyLive({ phase, threadId, session, resumed = false }) {
    if (!threadId || !session || !CODEBUDDY_SESSION_ID.test(threadId)) return;
    let state = graphicalCodeBuddyLive.get(session.id);
    if (!state || state.threadId !== threadId) {
      if (state?.timer) clearIntervalFn(state.timer);
      if (state) liveModule.endSession(session.id);
      state = { threadId, session, resumed, turnActive: false, trackingTurn: false,
        tracker: null, timer: null, pending: null, generation: 0 };
      graphicalCodeBuddyLive.set(session.id, state);
    }
    if (phase === "sessionStart") state.resumed = resumed;
    if (phase === "turnStart") state.turnActive = true;
    const alreadyTracking = Boolean(state.tracker);
    await findGraphicalCodeBuddyLive(state);
    if (phase === "turnStart" && alreadyTracking && state.tracker && !state.trackingTurn) {
      liveModule.handleEvent({ provider: "codebuddy", eventName: "UserPromptSubmit",
        input: { session_id: threadId, transcript_path: state.transcriptPath }, session });
      state.trackingTurn = true;
    }
    if (phase === "turnStart" && !state.tracker && !state.timer) {
      state.timer = setIntervalFn(() => { void findGraphicalCodeBuddyLive(state); }, pollIntervalMs);
      state.timer.unref?.();
    }
    if (phase === "turnEnd") {
      state.turnActive = false;
      if (state.timer) { clearIntervalFn(state.timer); state.timer = null; }
      if (state.tracker && state.trackingTurn) {
        state.trackingTurn = false;
        const result = liveModule.handleEvent({ provider: "codebuddy", eventName: "Stop",
          input: { session_id: threadId, transcript_path: state.transcriptPath }, session });
        await result?.completion;
      }
    }
  }

  function conversationSupported(provider, session) {
    return CONVERSATION_PROVIDERS.includes(provider) && (
      session?.type === "windows" || session?.type === "wsl" || isLocalSshBridge(session)
      || (session?.type === "ssh" && (provider === "codex" || provider === "codebuddy"))
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
    if (tracker.disposed) return;
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
    const epoch = graphicalEpoch;
    const run = () => Promise.resolve(baselinePending.get(key))
      .catch(() => undefined)
      .then(() => readWithRetry(session, provider, transcriptPath))
      .then(result => {
        if (provider === "codebuddy" && session.runtimeMode === "app-server" && epoch !== graphicalEpoch) return undefined;
        const graphicalState = provider === "codebuddy" && session.runtimeMode === "app-server"
          ? graphicalCodeBuddy.get(key) : null;
        if (graphicalState && !graphicalState.initialized) {
          statsStore.setBaseline(provider, agentSessionId, result.tokens, result.capabilities);
          graphicalState.initialized = true;
          return undefined;
        }
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
      .catch(error => console.error(`Failed to collect ${provider} token statistics:`, error));
    const request = provider === "codebuddy" && session.runtimeMode === "app-server"
      ? queueCodeBuddyWrite(key, run) : run();
    pending.set(key, request);
    void request.finally(() => { if (pending.get(key) === request) pending.delete(key); });
  }

  function captureBaseline({ provider, input, session }) {
    const agentSessionId = input.session_id || input.sessionId;
    const transcriptPath = input.transcript_path || input.transcriptPath;
    if (!agentSessionId || !transcriptPath) return;
    const key = `${provider}:${agentSessionId}`;
    if (baselinePending.has(key)) return;
    const epoch = graphicalEpoch;
    const request = (session.type === "windows" || isLocalSshBridge(session)
      ? Promise.resolve().then(() => parseTranscriptFileWithSubagents(provider, transcriptPath))
      : parseRemote(session, provider, transcriptPath))
      .then(result => {
        if (provider !== "codebuddy" || session.runtimeMode !== "app-server" || epoch === graphicalEpoch)
          statsStore.setBaseline(provider, agentSessionId, result.tokens, result.capabilities);
      })
      .catch(() => {
        if (provider !== "codebuddy" || session.runtimeMode !== "app-server" || epoch === graphicalEpoch)
          statsStore.setBaseline(provider, agentSessionId, {}, emptyCapabilityUsage());
      });
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
      if (provider === "opencode" && session?.runtimeMode === "app-server") return;
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
          void liveResult.completion.then(completed => {
            if (completed && !liveResult.tracker.disposed) completeConversationTurn(session.id, finalMessage);
          });
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
      const liveState = graphicalCodeBuddyLive.get(panelSessionId);
      if (liveState?.timer) clearIntervalFn(liveState.timer);
      graphicalCodeBuddyLive.delete(panelSessionId);
      liveModule.endSession(panelSessionId);
      conversations.delete(panelSessionId);
      statsStore.markEnded(panelSessionId);
      for (const [key, state] of graphicalCodeBuddy) {
        if (state.panelSessionId !== panelSessionId) continue;
        graphicalCodeBuddy.delete(key);
        void state.queue.finally(() => statsStore.markEnded(panelSessionId));
      }
      for (const [key, state] of graphicalOpenCode) {
        if (state.panelSessionId !== panelSessionId) continue;
        graphicalOpenCode.delete(key);
        void state.queue.finally(() => statsStore.markEnded(panelSessionId));
      }
      conversationSink?.clearSession?.(panelSessionId);
    },
    recordGraphicalCodeBuddy,
    recordGraphicalOpenCode,
    handleGraphicalCodeBuddyLive,
    resetGraphicalCodeBuddyBaselines,
    shutdown() {
      sessionLifetimes.clear();
      graphicalEpoch++;
      graphicalCodeBuddy.clear();
      graphicalOpenCode.clear();
      for (const state of graphicalCodeBuddyLive.values()) if (state.timer) clearIntervalFn(state.timer);
      graphicalCodeBuddyLive.clear();
      codeBuddyWrites.clear();
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
