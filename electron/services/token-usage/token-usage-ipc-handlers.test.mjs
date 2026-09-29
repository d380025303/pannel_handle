import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { registerTokenUsageIpcHandlers } = require("./token-usage-ipc-handlers.cjs");

describe("token-usage-ipc-handlers", () => {
  it("registers and removes the settings CodeBuddy quota channels", async () => {
    const handlers = new Map();
    const listeners = new Map();
    const ipcMain = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
      on: vi.fn((channel, listener) => listeners.set(channel, listener)),
      removeHandler: vi.fn(channel => handlers.delete(channel)),
      removeListener: vi.fn((channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      })
    };
    const agentUsageService = {
      getUsage: vi.fn(),
      getCodeBuddyUsage: vi.fn(async options => options),
      getCodexUsage: vi.fn(async options => options),
      consumeResetCredit: vi.fn(),
      disconnect: vi.fn(),
      cancelCodeBuddyUsage: vi.fn(),
      cancelCodexUsage: vi.fn()
    };
    const dispose = registerTokenUsageIpcHandlers({
      ipcMain,
      agentUsageService,
      agentTokenStatsStore: { getDashboard: vi.fn(), clear: vi.fn() },
      agentTokenStatsService: { getLive: vi.fn() }
    });

    await expect(handlers.get("agent-usage:get-codebuddy")({}, { force: true })).resolves.toEqual({ force: true });
    listeners.get("agent-usage:cancel-codebuddy")();
    expect(agentUsageService.getCodeBuddyUsage).toHaveBeenCalledWith({ force: true });
    expect(agentUsageService.cancelCodeBuddyUsage).toHaveBeenCalledTimes(1);
    await expect(handlers.get("agent-usage:get-codex")({}, { force: true })).resolves.toEqual({ force: true });
    listeners.get("agent-usage:cancel-codex")();
    expect(agentUsageService.getCodexUsage).toHaveBeenCalledWith({ force: true });
    expect(agentUsageService.cancelCodexUsage).toHaveBeenCalledTimes(1);

    agentUsageService.getUsage.mockRejectedValueOnce(Object.assign(new Error("canceled"), { code: "USAGE_CANCELED" }));
    await expect(handlers.get("agent-usage:get")({}, { sessionId: "run-1" })).resolves.toBeNull();
    agentUsageService.getUsage.mockRejectedValueOnce(new Error("CLI exited"));
    await expect(handlers.get("agent-usage:get")({}, { sessionId: "run-1" })).rejects.toThrow("CLI exited");

    dispose();
    expect(handlers.has("agent-usage:get-codebuddy")).toBe(false);
    expect(handlers.has("agent-usage:get-codex")).toBe(false);
    expect(listeners.has("agent-usage:cancel-codebuddy")).toBe(false);
    expect(listeners.has("agent-usage:cancel-codex")).toBe(false);
  });
});
