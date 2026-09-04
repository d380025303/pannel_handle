import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { SETTINGS_IPC_CHANNELS, registerSettingsIpcHandlers } = require("./settings-ipc-handlers.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(channel => handlers.delete(channel))
  };
}

function createRouterService(name) {
  return {
    getConfig: vi.fn(() => `${name}-config`),
    listModels: vi.fn(() => `${name}-models`),
    refreshModels: vi.fn(() => `${name}-refreshed`),
    saveApiKey: vi.fn(value => value),
    clearApiKey: vi.fn(() => `${name}-cleared`),
    testConnection: vi.fn(() => `${name}-tested`),
    verifyModels: vi.fn(value => value),
    setFavorites: vi.fn(value => value)
  };
}

function createHarness() {
  const ipcMain = createIpcMain();
  let config = {
    autoRestore: true,
    autoWorkBuddyCheckin: false,
    autoCollapseFileChains: false,
    debugMode: false,
    themeId: "dark-slate",
    locale: "zh-CN",
    rightToolsWidth: 360
  };
  const configStore = {
    getConfig: vi.fn(() => ({ ...config })),
    updateConfig: vi.fn(updates => { config = { ...config, ...updates }; })
  };
  const dingTalkConfigStore = { getConfig: vi.fn(() => ({ enabled: false })) };
  const dingTalkNotificationManager = {
    updateConfig: vi.fn(input => input),
    clearCredentials: vi.fn(() => ({ enabled: false })),
    testConnection: vi.fn(() => ({ ok: true }))
  };
  const workBuddyAutoCheckinService = { setEnabled: vi.fn() };
  const openRouterService = createRouterService("openrouter");
  const naraRouterService = createRouterService("nararouter");
  const miniMaxService = createRouterService("minimax");
  const codeBuddyCodexBridgeService = {
    getConfig: vi.fn(() => "codebuddy-config"),
    getStatus: vi.fn(() => "codebuddy-status"),
    listModels: vi.fn(() => "codebuddy-models"),
    refreshModels: vi.fn(() => "codebuddy-refreshed"),
    verifyModel: vi.fn(input => input),
    setFavorites: vi.fn(input => input),
    setExperimentalAcknowledged: vi.fn(input => input)
  };
  const mobileRemoteService = {
    getState: vi.fn(() => "mobile-state"),
    updateConfig: vi.fn(input => input),
    createPairing: vi.fn(() => "pairing"),
    listAudit: vi.fn(() => "audit"),
    revokeDevice: vi.fn(input => input),
    disconnectActiveDevice: vi.fn(() => "disconnected")
  };
  const unregister = registerSettingsIpcHandlers({
    ipcMain,
    configStore,
    dingTalkConfigStore,
    dingTalkNotificationManager,
    workBuddyAutoCheckinService,
    openRouterService,
    naraRouterService,
    miniMaxService,
    codeBuddyCodexBridgeService,
    getMobileRemoteService: () => mobileRemoteService
  });
  return {
    ipcMain,
    configStore,
    dingTalkNotificationManager,
    workBuddyAutoCheckinService,
    openRouterService,
    naraRouterService,
    miniMaxService,
    codeBuddyCodexBridgeService,
    mobileRemoteService,
    unregister
  };
}

describe("settings IPC handlers", () => {
  it("validates general configuration and synchronizes automatic check-in", () => {
    const harness = createHarness();
    const result = harness.ipcMain.handlers.get("config:set")({}, {
      autoRestore: false,
      autoWorkBuddyCheckin: true,
      autoCollapseFileChains: true,
      debugMode: true,
      themeId: "light",
      locale: "en-US",
      rightToolsWidth: 600,
      ignored: true
    });

    expect(harness.configStore.updateConfig).toHaveBeenCalledWith({
      autoRestore: false,
      autoWorkBuddyCheckin: true,
      autoCollapseFileChains: true,
      debugMode: true,
      themeId: "light",
      locale: "en-US",
      rightToolsWidth: 600
    });
    expect(result).toEqual(expect.objectContaining({ autoWorkBuddyCheckin: true, themeId: "light", locale: "en-US" }));
    expect(harness.workBuddyAutoCheckinService.setEnabled).toHaveBeenCalledWith(true);

    harness.ipcMain.handlers.get("config:set")({}, { themeId: "unknown", locale: "fr-FR", rightToolsWidth: 601 });
    expect(harness.configStore.updateConfig).toHaveBeenCalledTimes(1);
  });

  it("delegates provider, CodeBuddy, DingTalk, and mobile channels", () => {
    const harness = createHarness();

    expect(harness.ipcMain.handlers.get("openrouter:save-api-key")({}, "secret")).toBe("secret");
    expect(harness.openRouterService.saveApiKey).toHaveBeenCalledWith("secret");
    expect(harness.ipcMain.handlers.get("nararouter:list-models")()).toBe("nararouter-models");
    expect(harness.ipcMain.handlers.get("minimax:test")()).toBe("minimax-tested");
    expect(harness.ipcMain.handlers.get("codebuddy-codex:verify-model")({}, { modelId: "glm" })).toEqual({ modelId: "glm" });
    expect(harness.ipcMain.handlers.get("dingtalk:set-config")({}, { enabled: true })).toEqual({ enabled: true });
    expect(harness.ipcMain.handlers.get("mobile-access:revoke-device")({}, "phone-1")).toBe("phone-1");
    expect(harness.mobileRemoteService.revokeDevice).toHaveBeenCalledWith("phone-1");
  });

  it("registers and unregisters every owned channel", () => {
    const harness = createHarness();

    expect([...harness.ipcMain.handlers.keys()].sort()).toEqual([...SETTINGS_IPC_CHANNELS].sort());
    harness.unregister();
    expect(harness.ipcMain.handlers.size).toBe(0);
  });
});
