import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createTokenUsageModule } = require("./token-usage-module.cjs");

function createIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    on: vi.fn((channel, listener) => listeners.set(channel, listener)),
    removeHandler: vi.fn(channel => handlers.delete(channel)),
    removeListener: vi.fn((channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    })
  };
}

function createHarness() {
  const ipcMain = createIpcMain();
  const statsStore = {
    clear: vi.fn(),
    close: vi.fn(),
    getDashboard: vi.fn(options => ({ options })),
    load: vi.fn(),
    setBaseline: vi.fn(),
    update: vi.fn()
  };
  const usageService = {
    consumeResetCredit: vi.fn(request => request),
    disconnect: vi.fn(),
    getUsage: vi.fn((sessionId, options) => ({ sessionId, options })),
    shutdown: vi.fn()
  };
  const statsService = {
    getLive: vi.fn(sessionId => ({ sessionId })),
    handleHook: vi.fn(input => input),
    markEnded: vi.fn(),
    shutdown: vi.fn()
  };
  const createStatsStore = vi.fn(() => statsStore);
  const createUsageService = vi.fn(() => usageService);
  const createStatsService = vi.fn(() => statsService);
  const module = createTokenUsageModule({
    ipcMain,
    terminalManager: { name: "terminal-manager" },
    sshAgentTransport: { name: "ssh-agent-transport" },
    miniMaxConfigStore: { name: "minimax-config-store" },
    databaseFile: "stats.sqlite3",
    legacyStatsFile: "stats.json",
    broadcast: vi.fn(),
    conversationSink: { name: "conversation-sink" },
    createStatsStore,
    createUsageService,
    createStatsService
  });
  return {
    module,
    ipcMain,
    statsStore,
    usageService,
    statsService,
    createStatsStore,
    createUsageService,
    createStatsService
  };
}

describe("token usage module", () => {
  it("owns statistics initialization, IPC, hooks, and session lifecycle", async () => {
    const harness = createHarness();

    expect(harness.createStatsStore).toHaveBeenCalledWith(expect.objectContaining({
      databaseFile: "stats.sqlite3",
      legacyStatsFile: "stats.json",
      onChanged: expect.any(Function)
    }));
    expect(harness.statsStore.load).toHaveBeenCalledTimes(1);
    expect([...harness.ipcMain.handlers.keys()]).toContain("agent-usage:get");
    expect([...harness.ipcMain.handlers.keys()]).toContain("agent-token-stats:get");
    expect([...harness.ipcMain.listeners.keys()]).toContain("agent-usage:cancel");

    expect(harness.ipcMain.handlers.get("agent-usage:get")({}, {
      sessionId: "panel-1",
      force: 1
    })).toEqual({ sessionId: "panel-1", options: { force: true } });
    expect(harness.ipcMain.handlers.get("agent-token-stats:clear")()).toBe(true);
    expect(harness.statsStore.clear).toHaveBeenCalledTimes(1);

    harness.module.handleHook({ provider: "codex" });
    harness.module.disconnect("panel-1");
    expect(harness.statsService.handleHook).toHaveBeenCalledWith({ provider: "codex" });
    expect(harness.usageService.disconnect).toHaveBeenCalledWith("panel-1");
    expect(harness.statsService.markEnded).toHaveBeenCalledWith("panel-1");
  });

  it("unregisters IPC and shuts down owned resources only once", () => {
    const harness = createHarness();

    harness.module.shutdown();
    harness.module.shutdown();

    expect(harness.ipcMain.handlers.size).toBe(0);
    expect(harness.ipcMain.listeners.size).toBe(0);
    expect(harness.usageService.shutdown).toHaveBeenCalledTimes(1);
    expect(harness.statsService.shutdown).toHaveBeenCalledTimes(1);
    expect(harness.statsStore.close).toHaveBeenCalledTimes(1);
  });

  it("records App Server snapshots as isolated Codex thread statistics", () => {
    const harness = createHarness();
    const session = { id: "panel-1", title: "Work", cwd: "C:\\project", type: "windows", templateId: "saved-1" };
    const tokens = { inputTokens: 80, outputTokens: 20, totalTokens: 100 };
    harness.module.recordAppServerUsage({ threadId: "thread-1", session, cwd: "C:\\workspace", model: "gpt-5", tokens,
      baseline: true });
    expect(harness.statsStore.setBaseline).toHaveBeenCalledWith("codex", "app-server:thread-1", tokens);
    expect(harness.statsStore.update).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex",
      agentSessionId: "app-server:thread-1", panelSessionId: "panel-1", templateId: "saved-1",
      cwd: "C:\\workspace", location: "windows", models: ["gpt-5"], tokens }));
    harness.module.disconnect("panel-1");
    expect(harness.statsService.markEnded).toHaveBeenCalledWith("panel-1");
  });

  it("persists App Server totals and history baselines in the dashboard", () => {
    const root = mkdtempSync(path.join(tmpdir(), "app-server-usage-"));
    const ipcMain = createIpcMain();
    const module = createTokenUsageModule({ ipcMain, databaseFile: path.join(root, "stats.sqlite3"),
      terminalManager: {}, broadcast: vi.fn(), createUsageService: () => ({ disconnect: vi.fn(), shutdown: vi.fn() }),
      createStatsService: () => ({ getLive: vi.fn(), handleHook: vi.fn(), markEnded: vi.fn(), shutdown: vi.fn() }) });
    const session = { id: "panel-1", title: "Work", cwd: "C:\\project", type: "windows" };
    const record = (threadId, totalTokens, baseline = false) => module.recordAppServerUsage({ threadId, session,
      tokens: { inputTokens: totalTokens, outputTokens: 0, totalTokens }, baseline });
    try {
      record("new", 100);
      record("new", 100);
      record("new", 130);
      record("history", 500, true);
      record("history", 530);
      expect(module.getDashboard({ range: "all", provider: "codex" }).summary.tokens.totalTokens).toBe(160);
      ipcMain.handlers.get("agent-token-stats:clear")();
      record("new", 150);
      record("history", 550);
      expect(module.getDashboard({ range: "all", provider: "codex" }).summary.tokens.totalTokens).toBe(40);
    } finally { module.shutdown(); rmSync(root, { recursive: true, force: true }); }
  });
});
