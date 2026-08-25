import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
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

function fixture(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "token-stats-sqlite-"));
  const databaseFile = path.join(root, "stats.sqlite3");
  const legacyStatsFile = path.join(root, "stats.json");
  const legacyBackupFile = path.join(root, "stats.migrated.json");
  const store = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, legacyBackupFile, ...options });
  store.load();
  return { root, databaseFile, legacyStatsFile, legacyBackupFile, store };
}

function downgradeProviderConstraints(databaseFile) {
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    for (const table of ["token_sessions", "token_daily", "token_baselines"]) {
      const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
      const replacement = `${table}_provider_v1`;
      database.exec(schema
        .replace(new RegExp(`^CREATE TABLE\\s+[\"']?${table}[\"']?`, "i"), `CREATE TABLE ${replacement}`)
        .replace("provider IN ('codex', 'claude', 'codebuddy', 'opencode', 'qoder', 'copilot', 'qwen', 'gemini', 'grok')", "provider IN ('codex', 'claude', 'codebuddy')"));
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(column => `"${column.name}"`).join(", ");
      database.exec(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${table}`);
      database.exec(`DROP TABLE ${table}`);
      database.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
    }
    database.exec("PRAGMA user_version = 1; COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

describe("agent token statistics SQLite store", () => {
  it("stores idempotent cumulative snapshots and aggregates their deltas", () => {
    let time = Date.UTC(2026, 7, 15, 12);
    const changed = vi.fn();
    const { store } = fixture({ now: () => time, onChanged: changed });
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", location: "windows", tokens: tokens(100) });
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", location: "windows", tokens: tokens(100) });
    time += 86400000;
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", location: "windows", tokens: tokens(160, 140, 20) });

    const dashboard = store.getDashboard({ range: "all" });
    expect(dashboard.summary.tokens.totalTokens).toBe(160);
    expect(dashboard.summary.sessionCount).toBe(1);
    expect(dashboard.dailyTrend.map(item => item.tokens.totalTokens)).toEqual([100, 60]);
    expect(changed).toHaveBeenCalledTimes(3);
    store.close();
  });

  it("uses a baseline and keeps active-session reset checkpoints after clear", () => {
    const { store } = fixture();
    store.setBaseline("claude", "resumed", tokens(500));
    store.update({ provider: "claude", agentSessionId: "resumed", panelSessionId: "panel", title: "Resume", location: "wsl", tokens: tokens(620) });
    expect(store.getDashboard({ range: "all" }).summary.tokens.totalTokens).toBe(120);
    store.clear();
    expect(store.getDashboard({ range: "all" }).totalCount).toBe(0);
    store.update({ provider: "claude", agentSessionId: "resumed", panelSessionId: "panel", title: "Resume", location: "wsl", tokens: tokens(700) });
    expect(store.getDashboard({ range: "all" }).summary.tokens.totalTokens).toBe(80);
    store.close();
  });

  it("includes CodeBuddy sessions in totals, filtering, and provider comparison", () => {
    const { store } = fixture();
    store.update({ provider: "codebuddy", agentSessionId: "buddy", panelSessionId: "panel", title: "Buddy", location: "windows", models: ["glm-5.2"], tokens: tokens(240) });

    const dashboard = store.getDashboard({ range: "all", provider: "codebuddy" });
    expect(dashboard.summary.tokens.totalTokens).toBe(240);
    expect(dashboard.sessions[0]).toMatchObject({ provider: "codebuddy", models: ["glm-5.2"] });
    expect(dashboard.providerBreakdown).toEqual([
      expect.objectContaining({ provider: "codebuddy", sessionCount: 1 })
    ]);
    store.close();
  });

  it("includes OpenCode sessions in totals, filtering, and provider comparison", () => {
    const { store } = fixture();
    store.update({ provider: "opencode", agentSessionId: "open", panelSessionId: "panel", title: "OpenCode", location: "ssh", models: ["glm-5.2"], tokens: tokens(260) });

    const dashboard = store.getDashboard({ range: "all", provider: "opencode" });
    expect(dashboard.summary.tokens.totalTokens).toBe(260);
    expect(dashboard.sessions[0]).toMatchObject({ provider: "opencode", location: "ssh", models: ["glm-5.2"] });
    expect(dashboard.providerBreakdown).toEqual([
      expect.objectContaining({ provider: "opencode", sessionCount: 1 })
    ]);
    store.close();
  });

  it("includes Qoder sessions in totals, filtering, and provider comparison", () => {
    const { store } = fixture();
    store.update({ provider: "qoder", agentSessionId: "qoder", panelSessionId: "panel", title: "Qoder", location: "wsl", models: ["qoder-model"], tokens: tokens(180) });

    const dashboard = store.getDashboard({ range: "all", provider: "qoder" });
    expect(dashboard.summary.tokens.totalTokens).toBe(180);
    expect(dashboard.sessions[0]).toMatchObject({ provider: "qoder", models: ["qoder-model"] });
    expect(dashboard.providerBreakdown).toEqual([
      expect.objectContaining({ provider: "qoder", sessionCount: 1 })
    ]);
    store.close();
  });

  it("includes Grok sessions in totals and provider filtering", () => {
    const { store } = fixture();
    store.update({ provider: "grok", agentSessionId: "grok-one", panelSessionId: "panel", title: "Grok", location: "wsl", models: ["grok-build"], tokens: tokens(190) });

    const dashboard = store.getDashboard({ range: "all", provider: "grok" });
    expect(dashboard.summary.tokens.totalTokens).toBe(190);
    expect(dashboard.sessions[0]).toMatchObject({ provider: "grok", location: "wsl", models: ["grok-build"] });
    expect(dashboard.providerBreakdown).toEqual([expect.objectContaining({ provider: "grok", sessionCount: 1 })]);
    store.close();
  });

  it("preserves legacy Qwen rows while excluding them from dashboards", () => {
    const { databaseFile, legacyStatsFile, legacyBackupFile, store } = fixture();
    store.update({ provider: "codex", agentSessionId: "legacy", panelSessionId: "panel", title: "Legacy", location: "wsl", models: ["legacy-model"], tokens: tokens(210) });
    store.close();

    const database = new DatabaseSync(databaseFile);
    database.exec("UPDATE token_sessions SET provider = 'qwen'; UPDATE token_daily SET provider = 'qwen';");
    database.close();

    const reopened = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, legacyBackupFile });
    reopened.load();
    const dashboard = reopened.getDashboard({ range: "all" });
    expect(dashboard.summary.tokens.totalTokens).toBe(0);
    expect(dashboard.sessions).toEqual([]);
    expect(dashboard.providerBreakdown.some(item => item.provider === "qwen")).toBe(false);
    reopened.close();

    const verification = new DatabaseSync(databaseFile);
    expect(verification.prepare("SELECT COUNT(*) AS count FROM token_sessions WHERE provider = 'qwen'").get().count).toBe(1);
    verification.close();
  });

  it("subtracts capability baselines and aggregates skill and MCP rankings", () => {
    const { store } = fixture();
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
    store.close();
  });

  it("aggregates all-time Skill usage by provider and clears it with statistics", () => {
    const { store } = fixture();
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "one", title: "One", location: "windows", tokens: tokens(10), capabilities: capabilities(2) });
    store.update({ provider: "codebuddy", agentSessionId: "two", panelSessionId: "two", title: "Two", location: "windows", tokens: tokens(20), capabilities: capabilities(3) });

    expect(store.getSkillUsage("codex")).toEqual([{ name: "diagnosing-bugs", count: 2 }]);
    expect(store.getSkillUsage("codebuddy")).toEqual([{ name: "diagnosing-bugs", count: 3 }]);
    store.clear();
    expect(store.getSkillUsage("codex")).toEqual([]);
    store.close();
  });

  it("persists records across database reopen", () => {
    const { databaseFile, legacyStatsFile, legacyBackupFile, store } = fixture();
    store.update({ provider: "codex", agentSessionId: "persisted", panelSessionId: "panel", title: "Persisted", location: "windows", tokens: tokens(90) });
    store.close();

    const reopened = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, legacyBackupFile });
    reopened.load();
    expect(reopened.getDashboard({ range: "all" }).sessions[0]).toMatchObject({ agentSessionId: "persisted", tokens: tokens(90) });
    reopened.close();
  });

  it("migrates provider constraints without losing existing statistics", () => {
    const { databaseFile, legacyStatsFile, legacyBackupFile, store } = fixture();
    store.update({ provider: "codex", agentSessionId: "existing", panelSessionId: "panel", title: "Existing", location: "windows", models: ["gpt-5.6"], tokens: tokens(90), capabilities: capabilities(1, 1) });
    store.close();
    downgradeProviderConstraints(databaseFile);

    const reopened = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, legacyBackupFile });
    reopened.load();
    expect(reopened.getDashboard({ range: "all" })).toMatchObject({
      totalCount: 1,
      summary: { skillCalls: 1, mcpCalls: 1, tokens: expect.objectContaining({ totalTokens: 90 }) },
      sessions: [expect.objectContaining({ models: ["gpt-5.6"], capabilities: expect.objectContaining({ skills: expect.objectContaining({ totalCalls: 1 }), mcp: expect.objectContaining({ totalCalls: 1 }) }) })]
    });
    reopened.update({ provider: "qoder", agentSessionId: "new", panelSessionId: "qoder-panel", title: "Qoder", location: "windows", tokens: tokens(40) });
    expect(reopened.getDashboard({ range: "all", provider: "qoder" })).toMatchObject({ totalCount: 1, summary: { tokens: expect.objectContaining({ totalTokens: 40 }) } });
    reopened.close();
  });

  it("creates one new record when cumulative counters reset and updates it afterward", () => {
    let time = 1000;
    const { store } = fixture({ now: () => time });
    store.update({ provider: "codex", agentSessionId: "reset", panelSessionId: "panel", title: "Reset", location: "windows", tokens: tokens(100) });
    time = 2000;
    store.update({ provider: "codex", agentSessionId: "reset", panelSessionId: "panel", title: "Reset", location: "windows", tokens: tokens(20) });
    time = 3000;
    store.update({ provider: "codex", agentSessionId: "reset", panelSessionId: "panel", title: "Reset", location: "windows", tokens: tokens(30) });

    const dashboard = store.getDashboard({ range: "all" });
    expect(dashboard.totalCount).toBe(2);
    expect(dashboard.summary.tokens.totalTokens).toBe(130);
    store.close();
  });

  it("filters and paginates records while keeping aggregate totals", () => {
    let time = Date.UTC(2026, 7, 18, 10);
    const { store } = fixture({ now: () => time });
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "one", title: "One", location: "windows", tokens: tokens(10) });
    time += 1000;
    store.update({ provider: "codex", agentSessionId: "two", panelSessionId: "two", title: "Two", location: "windows", tokens: tokens(20) });
    time += 1000;
    store.update({ provider: "claude", agentSessionId: "three", panelSessionId: "three", title: "Three", location: "wsl", tokens: tokens(30) });

    const firstPage = store.getDashboard({ range: "all", provider: "codex", limit: 1, offset: 0 });
    const secondPage = store.getDashboard({ range: "all", provider: "codex", limit: 1, offset: 1 });
    expect(firstPage.summary).toMatchObject({ sessionCount: 2, tokens: expect.objectContaining({ totalTokens: 30 }) });
    expect(firstPage.sessions.map(record => record.agentSessionId)).toEqual(["two"]);
    expect(firstPage.sessions[0]).not.toHaveProperty("status");
    expect(secondPage.sessions.map(record => record.agentSessionId)).toEqual(["one"]);
    store.close();
  });

  it("migrates version 1 JSON once and preserves unknown capability availability", () => {
    const root = mkdtempSync(path.join(tmpdir(), "token-stats-migration-"));
    const databaseFile = path.join(root, "stats.sqlite3");
    const legacyStatsFile = path.join(root, "stats.json");
    const legacyBackupFile = path.join(root, "stats.migrated.json");
    writeFileSync(legacyStatsFile, JSON.stringify({
      version: 1,
      records: {
        "codex:old": {
          id: "codex:old", provider: "codex", agentSessionId: "old", panelSessionId: "panel", title: "Old", cwd: "", location: "windows",
          models: [], startedAt: 1, updatedAt: 1, endedAt: 1, status: "ended", tokens: tokens(20), rawTokens: tokens(20), baselineTokens: tokens(0)
        }
      },
      daily: { "2026-08-01": { codex: tokens(20) } }, baselines: {}
    }));
    const store = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, legacyBackupFile, now: () => 2 });
    store.load();

    const dashboard = store.getDashboard({ range: "all" });
    expect(dashboard.sessions[0].capabilities.skills.availability).toBe("unavailable");
    expect(dashboard.dailyTrend).toEqual([{ date: "2026-08-01", tokens: tokens(20) }]);
    expect(existsSync(legacyStatsFile)).toBe(false);
    expect(JSON.parse(readFileSync(legacyBackupFile, "utf-8")).version).toBe(1);
    store.close();

    const reopened = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, legacyBackupFile, now: () => 3 });
    reopened.load();
    expect(reopened.getDashboard({ range: "all" }).totalCount).toBe(1);
    reopened.close();
  });

  it("does not duplicate a successful version 2 migration when backup rename fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "token-stats-rename-failure-"));
    const databaseFile = path.join(root, "stats.sqlite3");
    const legacyStatsFile = path.join(root, "stats.json");
    writeFileSync(legacyStatsFile, JSON.stringify({
      version: 2,
      records: {
        "claude:old": {
          id: "claude:old", provider: "claude", agentSessionId: "old", panelSessionId: "panel", title: "Old", cwd: "", location: "windows",
          models: ["claude"], startedAt: 1, updatedAt: 1, endedAt: null, status: "active", tokens: tokens(40), rawTokens: tokens(40), baselineTokens: tokens(0),
          capabilities: capabilities(1, 1), rawCapabilities: capabilities(1, 1), baselineCapabilities: capabilities()
        }
      },
      daily: { "2026-08-01": { claude: tokens(40) } }, baselines: {}
    }));
    const fsApi = {
      existsSync,
      readFileSync,
      renameSync() { throw new Error("locked"); }
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, fsApi });
    store.load();
    expect(store.getDashboard({ range: "all" })).toMatchObject({ totalCount: 1, summary: { sessionCount: 1, skillCalls: 1, mcpCalls: 1, averageTokens: 40, tokens: tokens(40) } });
    store.close();

    const reopened = createAgentTokenStatsStore({ databaseFile, legacyStatsFile, fsApi });
    reopened.load();
    expect(reopened.getDashboard({ range: "all" }).dailyTrend[0].tokens.totalTokens).toBe(40);
    expect(reopened.getDashboard({ range: "all" }).totalCount).toBe(1);
    reopened.close();
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it("rolls back an invalid legacy migration and reports statistics unavailable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "token-stats-invalid-"));
    const databaseFile = path.join(root, "stats.sqlite3");
    const legacyStatsFile = path.join(root, "stats.json");
    writeFileSync(legacyStatsFile, "{invalid json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createAgentTokenStatsStore({ databaseFile, legacyStatsFile });
    store.load();

    expect(() => store.getDashboard({ range: "all" })).toThrow(/database is unavailable/i);
    expect(existsSync(legacyStatsFile)).toBe(true);
    expect(store.update({ provider: "codex", agentSessionId: "new", panelSessionId: "panel", tokens: tokens(10) })).toBeUndefined();
    store.close();
    errorSpy.mockRestore();
  });
});
