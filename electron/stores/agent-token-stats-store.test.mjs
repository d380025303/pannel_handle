import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentTokenStatsStore } = require("./agent-token-stats-store.cjs");

function tokens(total, input = total - 10, output = 10) {
  return { inputTokens: input, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 2, totalTokens: total };
}

describe("agent token statistics store", () => {
  it("stores idempotent cumulative snapshots and aggregates their deltas", () => {
    const statsFile = path.join(mkdtempSync(path.join(tmpdir(), "token-stats-")), "stats.json");
    let time = Date.UTC(2026, 7, 15, 12);
    const changed = vi.fn();
    const store = createAgentTokenStatsStore({ statsFile, now: () => time, onChanged: changed });
    store.load();
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", location: "windows", tokens: tokens(100) });
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", location: "windows", tokens: tokens(100) });
    time += 86400000;
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", location: "windows", tokens: tokens(160, 140, 20) });

    const dashboard = store.getDashboard({ range: "all" });
    expect(dashboard.summary.tokens.totalTokens).toBe(160);
    expect(dashboard.summary.sessionCount).toBe(1);
    expect(dashboard.dailyTrend.map(item => item.tokens.totalTokens)).toEqual([100, 60]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("uses a baseline and keeps active-session reset checkpoints after clear", () => {
    const statsFile = path.join(mkdtempSync(path.join(tmpdir(), "token-stats-")), "stats.json");
    const store = createAgentTokenStatsStore({ statsFile });
    store.load();
    store.setBaseline("claude", "resumed", tokens(500));
    store.update({ provider: "claude", agentSessionId: "resumed", panelSessionId: "panel", title: "Resume", location: "wsl", tokens: tokens(620) });
    expect(store.getDashboard({ range: "all" }).summary.tokens.totalTokens).toBe(120);
    store.clear();
    expect(store.getDashboard({ range: "all" }).totalCount).toBe(0);
    store.update({ provider: "claude", agentSessionId: "resumed", panelSessionId: "panel", title: "Resume", location: "wsl", tokens: tokens(700) });
    expect(store.getDashboard({ range: "all" }).summary.tokens.totalTokens).toBe(80);
    expect(JSON.parse(readFileSync(statsFile, "utf-8")).version).toBe(1);
  });

  it("includes CodeBuddy sessions in totals, filtering, and provider comparison", () => {
    const statsFile = path.join(mkdtempSync(path.join(tmpdir(), "token-stats-")), "stats.json");
    const store = createAgentTokenStatsStore({ statsFile });
    store.load();
    store.update({ provider: "codebuddy", agentSessionId: "buddy", panelSessionId: "panel", title: "Buddy", location: "windows", models: ["glm-5.2"], tokens: tokens(240) });

    const dashboard = store.getDashboard({ range: "all", provider: "codebuddy" });
    expect(dashboard.summary.tokens.totalTokens).toBe(240);
    expect(dashboard.sessions[0]).toMatchObject({ provider: "codebuddy", models: ["glm-5.2"] });
    expect(dashboard.providerBreakdown).toEqual([
      expect.objectContaining({ provider: "codebuddy", sessionCount: 1 })
    ]);
  });
});
