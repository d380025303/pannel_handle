import { createRequire } from "node:module";
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
    load: vi.fn()
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
});
