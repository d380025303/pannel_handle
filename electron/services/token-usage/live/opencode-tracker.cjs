const {
  TOKEN_FIELDS,
  emptyCapabilityUsage,
  emptyTokens,
  safeInteger
} = require("../agent-token-transcript.cjs");
const { cloneTokens } = require("../token-usage-values.cjs");
const {
  buildLiveSnapshot,
  completeTurn,
  startTurn
} = require("./live-token-tracker.cjs");

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

function createOpenCodeTrackerManager({ now, emitSnapshot, onUsage }) {
  const trackers = new Map();

  function ensureTracker(input, session) {
    const agentSessionId = input?.session_id || input?.sessionId;
    if (!agentSessionId) return null;
    let tracker = trackers.get(session.id);
    if (!tracker || tracker.agentSessionId !== agentSessionId) {
      tracker = {
        panelSessionId: session.id,
        agentSessionId,
        provider: "opencode",
        session,
        messages: new Map(),
        modelCounts: new Map(),
        rawTokens: emptyTokens(),
        rawCapabilities: emptyCapabilityUsage("unavailable"),
        sessionBaseline: emptyTokens(),
        sessionCapabilityBaseline: emptyCapabilityUsage("unavailable"),
        sessionBaselineInitialized: true,
        turnBaseline: emptyTokens(),
        turnStartedAt: null,
        state: "waiting",
        models: [],
        updatedAt: now(),
        outputTokensPerSecond: 0
      };
      trackers.set(session.id, tracker);
    }
    return tracker;
  }

  function updateUsage(tracker, message, previous) {
    for (const field of TOKEN_FIELDS) {
      tracker.rawTokens[field] += message.tokens[field] - (previous?.tokens[field] || 0);
    }
    if (previous?.model === message.model) return;
    if (previous?.model) {
      const count = tracker.modelCounts.get(previous.model) - 1;
      if (count > 0) tracker.modelCounts.set(previous.model, count);
      else tracker.modelCounts.delete(previous.model);
    }
    if (message.model) {
      tracker.modelCounts.set(message.model, (tracker.modelCounts.get(message.model) || 0) + 1);
    }
    tracker.models = [...tracker.modelCounts.keys()];
  }

  function emit(tracker) {
    const snapshot = buildLiveSnapshot(tracker);
    emitSnapshot(snapshot);
    return snapshot;
  }

  function handleEvent(input, session) {
    const eventName = input?.hook_event_name || input?.eventName || input?.event_name;
    const tracker = ensureTracker(input, session);
    if (!tracker) return;

    if (eventName === "session.status" && (input.status?.type || input.status) === "busy") {
      startTurn(tracker, now);
      emit(tracker);
      return;
    }
    if (eventName === "message.updated") {
      const message = normalizeOpenCodeMessage(input);
      if (!message) return;
      const previous = tracker.messages.get(message.id);
      if (message.tokens.totalTokens === 0 && previous?.tokens?.totalTokens > 0) return;
      tracker.messages.set(message.id, message);
      updateUsage(tracker, message, previous);
      if (tracker.turnStartedAt) {
        const startedAt = tracker.turnStartedAt;
        tracker.turnStartedAt = startedAt;
        const visibleOutput = Math.max(0, tracker.rawTokens.outputTokens - tracker.turnBaseline.outputTokens);
        const elapsedSeconds = Math.max(0.001, (now() - startedAt) / 1000);
        tracker.outputTokensPerSecond = Math.round((visibleOutput / elapsedSeconds) * 10) / 10;
      }
      tracker.updatedAt = now();
      emit(tracker);
      if (tracker.rawTokens.totalTokens > 0) {
        onUsage({ tracker, input, tokens: cloneTokens(tracker.rawTokens), models: [...tracker.models] });
      }
      return;
    }
    if (eventName === "session.idle") {
      completeTurn(tracker, now);
      emit(tracker);
    }
  }

  return {
    delete: panelSessionId => trackers.delete(panelSessionId),
    get: panelSessionId => trackers.get(String(panelSessionId || "")),
    handleEvent,
    clear: () => trackers.clear()
  };
}

module.exports = { createOpenCodeTrackerManager, normalizeOpenCodeMessage };
