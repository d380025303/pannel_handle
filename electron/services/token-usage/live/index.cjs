const {
  emptyCapabilityUsage,
  emptyTokens,
  normalizeCapabilityUsage
} = require("../agent-token-transcript.cjs");
const { cloneTokens } = require("../token-usage-values.cjs");
const {
  buildLiveSnapshot,
  completeTurn,
  initializeSessionBaseline,
  startTurn,
  updateOutputRate
} = require("./live-token-tracker.cjs");
const { createOpenCodeTrackerManager } = require("./opencode-tracker.cjs");
const {
  REMOTE_DELTA_SCRIPT,
  createTranscriptSource,
  remoteDeltaCommand
} = require("./transcript-source.cjs");

const LIVE_POLL_INTERVAL_MS = 1000;
const LIVE_TOKEN_PROVIDERS = ["codex", "claude", "codebuddy", "qoder", "copilot", "gemini", "grok"];

function isNestedAgentTranscript(provider, transcriptPath) {
  return provider === "codebuddy" && /(?:^|[\\/])subagents(?:[\\/]|$)/i.test(String(transcriptPath || ""));
}

function createAgentTokenLiveModule({
  sshAgentTransport,
  emitSnapshot = () => {},
  onUsage = () => {},
  onMainLine = () => {},
  onSourceReset = () => {},
  now = () => Date.now(),
  pollIntervalMs = LIVE_POLL_INTERVAL_MS,
  fsPromises,
  toWslHostPath,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  const trackers = new Map();
  const completedSnapshots = new Map();
  const source = createTranscriptSource({
    sshAgentTransport,
    fsPromises,
    toWslHostPath,
    onMainLine,
    onReset: onSourceReset
  });
  const openCode = createOpenCodeTrackerManager({ now, emitSnapshot, onUsage });

  function emit(tracker) {
    const snapshot = buildLiveSnapshot(tracker);
    if (!tracker.disposed) emitSnapshot(snapshot);
    return snapshot;
  }

  function stopTimer(tracker) {
    if (!tracker?.timer) return;
    clearIntervalFn(tracker.timer);
    tracker.timer = null;
  }

  function startTimer(tracker) {
    stopTimer(tracker);
    if (tracker.disposed) return;
    tracker.timer = setIntervalFn(() => { void poll(tracker); }, pollIntervalMs);
  }

  function ensureTracker({ provider, input, session }) {
    if (!LIVE_TOKEN_PROVIDERS.includes(provider)) return null;
    const agentSessionId = input?.session_id || input?.sessionId;
    const transcriptPath = input?.transcript_path || input?.transcriptPath;
    if (!agentSessionId || isNestedAgentTranscript(provider, transcriptPath)) return null;
    const resolved = source.resolveTrackerSource(provider, input, session);
    if (!resolved?.hostPath) return null;
    let tracker = trackers.get(session.id);
    if (!tracker || tracker.provider !== provider || tracker.agentSessionId !== agentSessionId || tracker.hostPath !== resolved.hostPath) {
      if (tracker) tracker.disposed = true;
      stopTimer(tracker);
      source.closeRemoteClient(tracker);
      tracker = {
        panelSessionId: session.id,
        agentSessionId,
        provider,
        hostPath: resolved.hostPath,
        fileIdentity: null,
        offset: 0,
        pendingBytes: Buffer.alloc(0),
        subagentReaders: new Map(),
        parser: source.createParser(provider),
        rawTokens: emptyTokens(),
        rawCapabilities: emptyCapabilityUsage(),
        sessionBaseline: provider === "copilot" ? emptyTokens() : null,
        sessionCapabilityBaseline: provider === "copilot" ? emptyCapabilityUsage("unavailable") : null,
        sessionBaselineInitialized: provider === "copilot",
        turnBaseline: emptyTokens(),
        turnStartedAt: null,
        conversationActive: false,
        state: "waiting",
        models: [],
        updatedAt: now(),
        outputTokensPerSecond: 0,
        timer: null,
        pollPromise: null,
        remote: resolved.remote,
        remoteClient: null,
        session
      };
      trackers.set(session.id, tracker);
    }
    return tracker;
  }

  function initializeCodeBuddySessionStartBaseline(tracker, input) {
    if (tracker.provider !== "codebuddy") return false;
    const eventSource = String(input?.source || "").trim().toLowerCase();
    if (eventSource === "resume" || eventSource === "compact") return false;
    if (eventSource === "clear") {
      source.reset(tracker);
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
    return eventSource === "clear";
  }

  async function poll(tracker, { emitChanged = true } = {}) {
    if (tracker.disposed) return null;
    if (tracker.pollPromise) return tracker.pollPromise;
    const request = source.readAppendedBytes(tracker)
      .then(() => {
        if (tracker.disposed) return null;
        const result = tracker.parser.getResult();
        if (result) {
          if (tracker.state === "unavailable") {
            tracker.state = tracker.turnStartedAt ? (tracker.timer ? "generating" : "completed") : "waiting";
          }
          tracker.rawTokens = cloneTokens(result.tokens);
          tracker.rawCapabilities = normalizeCapabilityUsage(result.capabilities);
          tracker.models = result.models;
          if (tracker.provider === "copilot") onUsage({ tracker, result });
          if (!tracker.sessionBaselineInitialized) initializeSessionBaseline(tracker, result.tokens, result.capabilities);
          if (tracker.state === "generating" && tracker.turnStartedAt) updateOutputRate(tracker, now);
          tracker.updatedAt = now();
        }
        if (emitChanged) emit(tracker);
        return result;
      })
      .catch(() => {
        tracker.state = "unavailable";
        tracker.updatedAt = now();
        if (emitChanged) emit(tracker);
        return null;
      })
      .finally(() => { if (tracker.pollPromise === request) tracker.pollPromise = null; });
    tracker.pollPromise = request;
    return request;
  }

  async function startLiveTurn(tracker) {
    if (tracker.provider === "codebuddy" && !tracker.sessionBaselineInitialized && !tracker.pollPromise) {
      initializeSessionBaseline(tracker);
    }
    await poll(tracker, { emitChanged: false });
    if (tracker.disposed) return;
    tracker.conversationActive = true;
    if (!tracker.sessionBaselineInitialized) initializeSessionBaseline(tracker);
    startTurn(tracker, now);
    emit(tracker);
    startTimer(tracker);
  }

  async function completeLiveTurn(tracker) {
    await poll(tracker, { emitChanged: false });
    if (tracker.disposed) return;
    if (source.consumePendingLine(tracker)) {
      const result = tracker.parser.getResult();
      tracker.rawTokens = cloneTokens(result?.tokens || tracker.rawTokens);
      tracker.models = result?.models || tracker.models;
      if (tracker.provider === "copilot") onUsage({ tracker, result });
    }
    tracker.conversationActive = false;
    completeTurn(tracker, now);
    stopTimer(tracker);
    source.closeRemoteClient(tracker);
    emit(tracker);
  }

  function handleEvent({ provider, eventName, input, session }) {
    if (provider === "opencode") {
      openCode.handleEvent(input, session);
      return null;
    }
    // A stop-only remote session has no live baseline; keep full collection fallback.
    if (session?.type === "ssh" && session.agentLocation !== "local"
      && (eventName === "Stop" || eventName === "AfterAgent" || eventName === "SessionEnd")
      && !trackers.has(session.id)) return null;
    const tracker = ensureTracker({ provider, input, session });
    if (tracker && eventName === "SessionStart") {
      const deferCodeBuddyClearRead = initializeCodeBuddySessionStartBaseline(tracker, input);
      if (!deferCodeBuddyClearRead) void poll(tracker);
    }
    if (tracker && (eventName === "UserPromptSubmit" || eventName === "BeforeAgent")) {
      void startLiveTurn(tracker);
    }
    if (tracker && (eventName === "Stop" || eventName === "AfterAgent")) {
      return { tracker, completion: completeLiveTurn(tracker) };
    }
    return tracker ? { tracker, completion: null } : null;
  }

  function setCompletedSnapshot(panelSessionId, record) {
    const tracker = trackers.get(panelSessionId);
    if (tracker) return buildLiveSnapshot(tracker);
    const snapshot = {
      panelSessionId,
      provider: record.provider,
      state: "completed",
      tokens: cloneTokens(record.tokens),
      capabilities: normalizeCapabilityUsage(record.capabilities),
      turnOutputTokens: 0,
      outputTokensPerSecond: 0,
      models: [...record.models],
      updatedAt: now()
    };
    completedSnapshots.set(panelSessionId, snapshot);
    emitSnapshot(snapshot);
    return snapshot;
  }

  function getSnapshot(panelSessionId) {
    const id = String(panelSessionId || "");
    const openCodeTracker = openCode.get(id);
    if (openCodeTracker) return buildLiveSnapshot(openCodeTracker);
    const tracker = trackers.get(id);
    return tracker ? buildLiveSnapshot(tracker) : completedSnapshots.get(id) || null;
  }

  function endSession(panelSessionId) {
    const tracker = trackers.get(panelSessionId);
    if (tracker) tracker.disposed = true;
    stopTimer(tracker);
    source.closeRemoteClient(tracker);
    trackers.delete(panelSessionId);
    openCode.delete(panelSessionId);
    completedSnapshots.delete(panelSessionId);
  }

  function shutdown() {
    for (const tracker of trackers.values()) {
      tracker.disposed = true;
      stopTimer(tracker);
      source.closeRemoteClient(tracker);
    }
    trackers.clear();
    openCode.clear();
    completedSnapshots.clear();
  }

  return {
    endSession,
    getSnapshot,
    handleEvent,
    setCompletedSnapshot,
    shutdown
  };
}

module.exports = {
  LIVE_POLL_INTERVAL_MS,
  REMOTE_DELTA_SCRIPT,
  createAgentTokenLiveModule,
  isNestedAgentTranscript,
  remoteDeltaCommand
};
