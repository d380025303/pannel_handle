const {
  emptyCapabilityUsage,
  emptyTokens,
  normalizeCapabilityUsage,
  safeInteger
} = require("../agent-token-transcript.cjs");
const {
  cloneTokens,
  subtractCapabilities,
  subtractTokens
} = require("../token-usage-values.cjs");

function buildLiveSnapshot(tracker) {
  const tokens = subtractTokens(tracker.rawTokens, tracker.sessionBaseline || emptyTokens());
  const capabilities = subtractCapabilities(
    tracker.rawCapabilities,
    tracker.sessionCapabilityBaseline || emptyCapabilityUsage()
  );
  return {
    panelSessionId: tracker.panelSessionId,
    provider: tracker.provider,
    state: tracker.state,
    tokens,
    capabilities,
    turnOutputTokens: Math.max(0, tokens.outputTokens - safeInteger(tracker.turnBaseline?.outputTokens)),
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

function visibleTokens(tracker) {
  return subtractTokens(tracker.rawTokens, tracker.sessionBaseline || emptyTokens());
}

function updateOutputRate(tracker, now) {
  if (!tracker.turnStartedAt) return;
  const turnOutput = Math.max(0, visibleTokens(tracker).outputTokens - safeInteger(tracker.turnBaseline?.outputTokens));
  const elapsedSeconds = Math.max(0.001, (now() - tracker.turnStartedAt) / 1000);
  tracker.outputTokensPerSecond = Math.round((turnOutput / elapsedSeconds) * 10) / 10;
}

function startTurn(tracker, now) {
  tracker.turnBaseline = cloneTokens(visibleTokens(tracker));
  tracker.turnStartedAt = now();
  tracker.outputTokensPerSecond = 0;
  tracker.state = "generating";
  tracker.updatedAt = now();
}

function completeTurn(tracker, now) {
  updateOutputRate(tracker, now);
  tracker.turnStartedAt = null;
  tracker.state = "completed";
  tracker.updatedAt = now();
}

module.exports = {
  buildLiveSnapshot,
  completeTurn,
  initializeSessionBaseline,
  startTurn,
  updateOutputRate,
  visibleTokens
};
