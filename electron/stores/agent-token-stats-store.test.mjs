import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentTokenStatsStore } = require("./agent-token-stats-store.cjs");

function tokens(total, input = total - 10, output = 10) {
  return { inputTokens: input, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 2, totalTokens: total };
}

function capabilities(skillCount = 0, mcpCount = 0) {
  return {
    skills: { availability: "available", totalCalls: skillCount, items: skillCount ? [{ name: "diagnosing-bugs", count: skillCount }] : [] },
    mcp: {
      availability: "available",
      totalCalls: mcpCount,
      servers: mcpCount ? [{ name: "logView", count: mcpCount, tools: [{ name: "search_logs", count: mcpCount }] }] : []
    }
  };
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
    expect(JSON.parse(readFileSync(statsFile, "utf-8")).version).toBe(2);
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

  it("subtracts capability baselines and aggregates skill and MCP rankings", () => {
    const statsFile = path.join(mkdtempSync(path.join(tmpdir(), "token-stats-")), "stats.json");
    const store = createAgentTokenStatsStore({ statsFile });
    store.load();
    store.setBaseline("codex", "resumed", tokens(50), capabilities(1, 2));
    store.update({
      provider: "codex", agentSessionId: "resumed", panelSessionId: "panel", title: "Resume", location: "windows",
      tokens: tokens(100), capabilities: capabilities(3, 5)
    });

    const dashboard = store.getDashboard({ range: "all" });
    expect(dashboard.summary).toMatchObject({ skillCalls: 2, mcpCalls: 3 });
    expect(dashboard.topSkills).toEqual([{ name: "diagnosing-bugs", count: 2 }]);
    expect(dashboard.topMcpServers[0]).toMatchObject({ name: "logView", count: 3, tools: [{ name: "search_logs", count: 3 }] });
    expect(dashboard.sessions[0].capabilities.mcp.totalCalls).toBe(3);
  });

  it("migrates version 1 records without treating unknown capabilities as zero", () => {
    const statsFile = path.join(mkdtempSync(path.join(tmpdir(), "token-stats-")), "stats.json");
    writeFileSync(statsFile, JSON.stringify({
      version: 1,
      records: {
        "codex:old": {
          id: "codex:old", provider: "codex", agentSessionId: "old", panelSessionId: "panel", title: "Old", cwd: "", location: "windows",
          models: [], startedAt: 1, updatedAt: 1, endedAt: 1, status: "ended", tokens: tokens(20), rawTokens: tokens(20), baselineTokens: tokens(0)
        }
      },
      daily: {}, baselines: {}
    }));
    const store = createAgentTokenStatsStore({ statsFile, now: () => 2 });
    store.load();

    const record = store.getDashboard({ range: "all" }).sessions[0];
    expect(record.capabilities.skills.availability).toBe("unavailable");
    expect(record.capabilities.mcp.availability).toBe("unavailable");
  });
});
