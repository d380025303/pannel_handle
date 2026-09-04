import { describe, expect, it } from "vitest";
import trackerModule from "./live-token-tracker.cjs";
import transcriptModule from "../agent-token-transcript.cjs";

const {
  buildLiveSnapshot,
  completeTurn,
  initializeSessionBaseline,
  startTurn,
  updateOutputRate
} = trackerModule;
const { emptyCapabilityUsage, emptyTokens } = transcriptModule;

function tokens(inputTokens = 0, outputTokens = 0) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function tracker() {
  return {
    panelSessionId: "panel-1",
    provider: "codex",
    state: "waiting",
    rawTokens: tokens(100, 20),
    rawCapabilities: emptyCapabilityUsage(),
    sessionBaseline: null,
    sessionCapabilityBaseline: null,
    sessionBaselineInitialized: false,
    turnBaseline: emptyTokens(),
    turnStartedAt: null,
    outputTokensPerSecond: 0,
    models: ["gpt-test"],
    updatedAt: 1000
  };
}

describe("live token tracker", () => {
  it("subtracts the session baseline and calculates only current-turn output", () => {
    const value = tracker();
    initializeSessionBaseline(value);
    value.rawTokens = tokens(160, 35);
    startTurn(value, () => 2000);
    value.rawTokens = tokens(180, 55);
    value.updatedAt = 3000;

    const snapshot = buildLiveSnapshot(value);
    expect(snapshot.tokens).toMatchObject({ inputTokens: 80, outputTokens: 35, totalTokens: 115 });
    expect(snapshot.turnOutputTokens).toBe(20);
  });

  it("updates the output rate while generating and freezes it on completion", () => {
    let time = 1000;
    const now = () => time;
    const value = tracker();
    initializeSessionBaseline(value, emptyTokens(), emptyCapabilityUsage());
    startTurn(value, now);
    value.rawTokens = tokens(100, 40);
    time = 3000;
    updateOutputRate(value, now);
    expect(value.outputTokensPerSecond).toBe(10);

    time = 5000;
    completeTurn(value, now);
    expect(value.state).toBe("completed");
    expect(value.outputTokensPerSecond).toBe(5);
    expect(value.turnStartedAt).toBeNull();
  });
});
