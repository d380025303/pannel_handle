import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { SETTINGS_IPC_CHANNELS, registerSettingsIpcHandlers } = require("./settings-ipc-handlers.cjs");
const { createConfigStore } = require("../../stores/config-store.cjs");

const tempDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-settings-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    verifyAgentModels: vi.fn(value => value),
    setFavorites: vi.fn(value => value)
  };
}

function createHarness(overrides = {}) {
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
  const configStore = overrides.configStore || {
    getConfig: vi.fn(() => ({ ...config })),
    updateConfig: vi.fn(updates => { config = { ...config, ...updates }; })
  };
  const dingTalkConfigStore = { getConfig: vi.fn(() => ({ enabled: false })) };
  const dingTalkNotificationManager = {
    updateConfig: vi.fn(input => input),
    clearCredentials: vi.fn(() => ({ enabled: false })),
    testConnection: vi.fn(() => ({ ok: true }))
  };
  const qoderAutoCheckinService = { setEnabled: vi.fn() };
  const workBuddyAutoCheckinService = { setEnabled: vi.fn() };
  const openRouterService = createRouterService("openrouter");
  const naraRouterService = createRouterService("nararouter");
  const miniMaxService = createRouterService("minimax");
  const mobileRemoteService = {
    broadcastMobilePreferences: vi.fn(),
    broadcastGraphicalMenuConfig: vi.fn(),
    getState: vi.fn(() => "mobile-state"),
    updateConfig: vi.fn(input => input),
    setPassword: vi.fn(() => "password-state"),
    listAudit: vi.fn(() => "audit"),
    disconnectConnection: vi.fn(input => input),
    disconnectActiveDevice: vi.fn(() => "disconnected")
  };
  let miniMaxApiKey = overrides.miniMaxApiKey ?? "sk-cp-test";
  const miniMaxConfigStore = { getApiKey: vi.fn(() => miniMaxApiKey) };
  const miniMaxUsageOptions = {
    ...(overrides.miniMaxFetch ? { fetchImpl: overrides.miniMaxFetch } : {}),
    ...(overrides.miniMaxNow ? { now: overrides.miniMaxNow } : {}),
    ...(overrides.miniMaxCacheTtlMs !== undefined ? { cacheTtlMs: overrides.miniMaxCacheTtlMs } : {})
  };
  const unregister = registerSettingsIpcHandlers({
    ipcMain,
    configStore,
    dingTalkConfigStore,
    dingTalkNotificationManager,
    workBuddyAutoCheckinService,
    qoderAutoCheckinService,
    openRouterService,
    naraRouterService,
    miniMaxService,
    miniMaxConfigStore,
    miniMaxUsageOptions,
    getMobileRemoteService: () => mobileRemoteService,
    desktopBroadcast: overrides.desktopBroadcast,
    onDesktopMascotEnabledChange: overrides.onDesktopMascotEnabledChange,
    dialog: overrides.dialog,
    getWindowFromEvent: overrides.getWindowFromEvent,
    userDataDir: overrides.userDataDir
  });
  return {
    ipcMain,
    configStore,
    dingTalkNotificationManager,
    workBuddyAutoCheckinService,
    qoderAutoCheckinService,
    openRouterService,
    naraRouterService,
    miniMaxService,
    miniMaxConfigStore,
    setMiniMaxApiKey: value => { miniMaxApiKey = value; },
    mobileRemoteService,
    unregister
  };
}

const TOKEN_PLAN_PAYLOAD = {
  base_resp: { status_code: 0 },
  model_remains: [{
    model_name: "MiniMax-M2",
    current_interval_status: 1,
    current_interval_total_count: 100,
    current_interval_usage_count: 25,
    current_interval_remaining_percent: 75,
    end_time: 1893456000000,
    current_weekly_status: 1,
    current_weekly_total_count: 1000,
    current_weekly_usage_count: 100,
    current_weekly_remaining_percent: 90,
    weekly_end_time: 1893456000000
  }]
};

const BALANCE_PAYLOAD = {
  base_resp: { status_code: 0 },
  available_amount: 12.34,
  cash_balance: 10,
  voucher_balance: 2,
  credit_balance: 0.34,
  owed_amount: 0
};

describe("settings IPC handlers", () => {
  it("propagates ENOSPC and rolls back general settings before running side effects", () => {
    const configFile = path.join(createTempDir(), "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ autoRestore: true, autoWorkBuddyCheckin: true, autoQoderCheckin: false }));
    const saveError = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    const dataStore = {
      read: file => JSON.parse(fs.readFileSync(file, "utf8")),
      write: vi.fn(() => { throw saveError; })
    };
    const configStore = createConfigStore({ configFile, dataStore });
    configStore.loadConfig();
    const before = configStore.getConfig();
    const persistedBefore = fs.readFileSync(configFile, "utf8");
    const harness = createHarness({ configStore });
    const set = harness.ipcMain.handlers.get("config:set");
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => set({}, { autoRestore: false })).toThrow(saveError);
      expect(() => set({}, { autoWorkBuddyCheckin: false, autoQoderCheckin: true })).toThrow(saveError);
      expect(configStore.getConfig()).toEqual(before);
      expect(harness.ipcMain.handlers.get("config:get")()).toEqual(before);
      expect(fs.readFileSync(configFile, "utf8")).toBe(persistedBefore);
      const reloaded = createConfigStore({ configFile, dataStore });
      reloaded.loadConfig();
      expect(reloaded.getConfig()).toEqual(before);
      expect(harness.workBuddyAutoCheckinService.setEnabled).not.toHaveBeenCalled();
      expect(harness.qoderAutoCheckinService.setEnabled).not.toHaveBeenCalled();
    } finally {
      logError.mockRestore();
    }
  });

  it("returns general settings consistent with memory and disk after a successful save", () => {
    const configFile = path.join(createTempDir(), "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ autoRestore: true }));
    const configStore = createConfigStore({ configFile });
    configStore.loadConfig();
    const harness = createHarness({ configStore });
    const result = harness.ipcMain.handlers.get("config:set")({}, { autoRestore: false });
    expect(result.autoRestore).toBe(false);
    expect(configStore.getConfig()).toEqual(result);
    expect(JSON.parse(fs.readFileSync(configFile, "utf8"))).toEqual(result);
    const reloaded = createConfigStore({ configFile });
    reloaded.loadConfig();
    expect(reloaded.getConfig()).toEqual(result);
  });

  it("lists built-in tools without querying or starting runtime services", () => {
    const fixture = createHarness();
    const handler = fixture.ipcMain.handlers.get("project-tools:list");
    expect(SETTINGS_IPC_CHANNELS).toContain("project-tools:list");
    expect(handler({})).toHaveLength(14);
    expect(fixture.mobileRemoteService.getState).not.toHaveBeenCalled();
    expect(fixture.openRouterService.getConfig).not.toHaveBeenCalled();
    fixture.unregister();
    expect(fixture.ipcMain.handlers.has("project-tools:list")).toBe(false);
  });
  it("updates the Qoder scheduler only when its persisted flag changes", async () => {
    const fixture = createHarness();
    const handler = fixture.ipcMain.handlers.get("config:set");
    await handler({}, { autoQoderCheckin: true });
    expect(fixture.qoderAutoCheckinService.setEnabled).toHaveBeenCalledWith(true);
    await handler({}, { autoQoderCheckin: false });
    expect(fixture.qoderAutoCheckinService.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("normalizes title bar preferences and requires durable saving", () => {
    const harness = createHarness();
    const result = harness.ipcMain.handlers.get("config:set")({}, {
      titleBarActionOrder: ["create", "create", "overview", "unknown"],
      titleBarHiddenActions: ["terminal", "settings", "overview", "unknown", "terminal"]
    });
    expect(harness.configStore.updateConfig).toHaveBeenCalledWith({
      titleBarActionOrder: ["api", "moduleOwners", "workItems", "create", "terminal", "stats", "skills", "mcp", "idea", "settings", "screenshot", "library", "quickAgent"],
      titleBarHiddenActions: ["terminal"]
    }, { throwOnSaveError: true });
    expect(result.titleBarHiddenActions).toEqual(["terminal"]);
  });
  it("validates general configuration and synchronizes automatic check-in", () => {
    const harness = createHarness();
    const result = harness.ipcMain.handlers.get("config:set")({}, {
      autoRestore: false,
      autoWorkBuddyCheckin: true,
      autoCollapseFileChains: true,
      debugMode: true,
      screenshotEnabled: false,
      screenshotShortcut: "shift+alt+7",
      themeId: "light",
      locale: "en-US",
      sidebarWidth: 500,
      rightToolsWidth: 600,
      ignored: true
    });

    expect(harness.configStore.updateConfig).toHaveBeenCalledWith({
      autoRestore: false,
      autoWorkBuddyCheckin: true,
      autoCollapseFileChains: true,
      debugMode: true,
      screenshotEnabled: false,
      screenshotShortcut: "Alt+Shift+7",
      themeId: "light",
      locale: "en-US",
      sidebarWidth: 500,
      rightToolsWidth: 600
    }, { throwOnSaveError: true });
    expect(result).toEqual(expect.objectContaining({ autoWorkBuddyCheckin: true, themeId: "light", locale: "en-US" }));
    expect(harness.workBuddyAutoCheckinService.setEnabled).toHaveBeenCalledWith(true);

    harness.ipcMain.handlers.get("config:set")({}, { themeId: "unknown", locale: "fr-FR", rightToolsWidth: 601, sidebarWidth: 501 });
    expect(harness.configStore.updateConfig).toHaveBeenCalledTimes(1);

    harness.ipcMain.handlers.get("config:set")({}, { screenshotShortcut: "Ctrl+Shift+F" });
    expect(harness.configStore.updateConfig).toHaveBeenCalledTimes(1);
  });

  it.each(["cmd", "powershell", "pwsh"])("saves the default shell %s through config IPC", (defaultWindowsShell) => {
    const harness = createHarness();
    const result = harness.ipcMain.handlers.get("config:set")({}, { defaultWindowsShell });
    expect(harness.configStore.updateConfig).toHaveBeenCalledWith({ defaultWindowsShell }, { throwOnSaveError: true });
    expect(result.defaultWindowsShell).toBe(defaultWindowsShell);
    harness.ipcMain.handlers.get("config:set")({}, { defaultWindowsShell: "bash" });
    expect(harness.configStore.updateConfig).toHaveBeenCalledTimes(1);
  });

  it("delegates provider, CodeBuddy, DingTalk, and mobile channels", () => {
    const harness = createHarness();

    expect(harness.ipcMain.handlers.get("openrouter:save-api-key")({}, "secret")).toBe("secret");
    expect(harness.openRouterService.saveApiKey).toHaveBeenCalledWith("secret");
    expect(harness.ipcMain.handlers.get("nararouter:list-models")()).toBe("nararouter-models");
    expect(harness.ipcMain.handlers.get("openrouter:verify-agent-models")({}, { agent: "opencode", modelIds: ["vendor/model"] }))
      .toEqual({ agent: "opencode", modelIds: ["vendor/model"] });
    expect(harness.ipcMain.handlers.get("minimax:test")()).toBe("minimax-tested");
    expect(harness.ipcMain.handlers.get("dingtalk:set-config")({}, { enabled: true })).toEqual({ enabled: true });
    expect(harness.ipcMain.handlers.get("mobile-access:disconnect-connection")({}, "phone-1")).toBe("phone-1");
    expect(harness.mobileRemoteService.disconnectConnection).toHaveBeenCalledWith("phone-1");
    expect(harness.ipcMain.handlers.get("mobile-access:set-password")({}, "new-password")).toBe("password-state");
  });

  it("registers and unregisters every owned channel", () => {
    const harness = createHarness();

    expect([...harness.ipcMain.handlers.keys()].sort()).toEqual([...SETTINGS_IPC_CHANNELS].sort());
    harness.unregister();
    expect(harness.ipcMain.handlers.size).toBe(0);
  });

  it("passes terminal background fields through config:set with normalization", () => {
    const harness = createHarness();
    const result = harness.ipcMain.handlers.get("config:set")({}, {
      terminalBackgroundImage: "123-bg.png",
      terminalBackgroundOpacity: 80,
      terminalBackgroundBlur: 10,
      terminalBackgroundPositionX: -5,
      terminalBackgroundPositionY: 140
    });

    expect(harness.configStore.updateConfig).toHaveBeenCalledWith({
      terminalBackgroundImage: "123-bg.png",
      terminalBackgroundOpacity: 80,
      terminalBackgroundBlur: 10,
      terminalBackgroundPositionX: 0,
      terminalBackgroundPositionY: 100
    }, { throwOnSaveError: true });
    expect(result).toMatchObject({
      terminalBackgroundImage: "123-bg.png",
      terminalBackgroundOpacity: 80,
      terminalBackgroundBlur: 10,
      terminalBackgroundPositionX: 0,
      terminalBackgroundPositionY: 100
    });

    harness.configStore.updateConfig.mockClear();
    harness.ipcMain.handlers.get("config:set")({}, { terminalBackgroundOpacity: "80", terminalBackgroundBlur: null });
    expect(harness.configStore.updateConfig).not.toHaveBeenCalled();

    harness.ipcMain.handlers.get("config:set")({}, { terminalBackgroundImage: "../escape.png" });
    expect(harness.configStore.updateConfig).toHaveBeenCalledWith({ terminalBackgroundImage: "" }, { throwOnSaveError: true });
  });

  it("handles terminal background image choosing", async () => {
    const userDataDir = createTempDir();
    const sourceDir = createTempDir();
    const sourceFile = path.join(sourceDir, "my bg.png");
    fs.writeFileSync(sourceFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const dialog = {
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [sourceFile] }))
    };
    const harness = createHarness({ dialog, userDataDir });

    const result = await harness.ipcMain.handlers.get("terminal-background:choose-image")({});
    expect(result.canceled).toBe(false);
    expect(result.name).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(userDataDir, "terminal-background", result.name))).toBe(true);

    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const canceled = await harness.ipcMain.handlers.get("terminal-background:choose-image")({});
    expect(canceled).toEqual({ canceled: true });

    const badFile = path.join(sourceDir, "notes.txt");
    fs.writeFileSync(badFile, "text");
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [badFile] });
    const failed = await harness.ipcMain.handlers.get("terminal-background:choose-image")({});
    expect(failed.canceled).toBe(false);
    expect(failed.error).toBeTruthy();
  });

  it("reads MiniMax token plan usage and caches it within the TTL", async () => {
    let currentTime = 1000;
    const miniMaxFetch = vi.fn(async () => ({ ok: true, json: async () => TOKEN_PLAN_PAYLOAD }));
    const harness = createHarness({ miniMaxFetch, miniMaxNow: () => currentTime });

    const snapshot = await harness.ipcMain.handlers.get("minimax:get-usage")({}, {});
    expect(miniMaxFetch).toHaveBeenCalledTimes(1);
    expect(miniMaxFetch.mock.calls[0][0]).toBe("https://www.minimaxi.com/v1/token_plan/remains");
    expect(snapshot.provider).toBe("minimax");
    expect(snapshot.limits).toHaveLength(2);
    expect(snapshot.primaryLimitId).toBe("MiniMax-M2:interval");
    expect(snapshot.limits[0]).toMatchObject({ remainingPercent: 75, usedPercent: 25 });

    currentTime += 29_000;
    const cached = await harness.ipcMain.handlers.get("minimax:get-usage")({}, {});
    expect(miniMaxFetch).toHaveBeenCalledTimes(1);
    expect(cached).toBe(snapshot);

    currentTime += 2_000;
    await harness.ipcMain.handlers.get("minimax:get-usage")({}, {});
    expect(miniMaxFetch).toHaveBeenCalledTimes(2);

    await harness.ipcMain.handlers.get("minimax:get-usage")({}, { force: true });
    expect(miniMaxFetch).toHaveBeenCalledTimes(3);
  });

  it("reads MiniMax account balance for pay-as-you-go keys and invalidates cache on key change", async () => {
    const miniMaxFetch = vi.fn(async () => ({ ok: true, json: async () => BALANCE_PAYLOAD }));
    const harness = createHarness({ miniMaxFetch, miniMaxApiKey: "sk-api-test" });

    const snapshot = await harness.ipcMain.handlers.get("minimax:get-usage")({}, {});
    expect(miniMaxFetch).toHaveBeenCalledTimes(1);
    expect(miniMaxFetch.mock.calls[0][0]).toBe("https://api.minimaxi.com/account/query_balance");
    expect(snapshot.summary).toMatchObject({ kind: "currency", available: 12.34, cash: 10, voucher: 2, credit: 0.34, owed: 0 });

    const cached = await harness.ipcMain.handlers.get("minimax:get-usage")({}, {});
    expect(cached).toBe(snapshot);
    expect(miniMaxFetch).toHaveBeenCalledTimes(1);

    harness.setMiniMaxApiKey("sk-api-other");
    await harness.ipcMain.handlers.get("minimax:get-usage")({}, {});
    expect(miniMaxFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects MiniMax usage reads without a configured key", async () => {
    const miniMaxFetch = vi.fn();
    const harness = createHarness({ miniMaxFetch, miniMaxApiKey: "" });
    await expect(harness.ipcMain.handlers.get("minimax:get-usage")({}, {})).rejects.toThrow("请先在设置中配置 MiniMax API Key。");
    expect(miniMaxFetch).not.toHaveBeenCalled();
  });
});

it("accepts only boolean graphical minimal mode through config IPC", () => {
  const harness = createHarness();
  const set = harness.ipcMain.handlers.get("config:set");
  set({}, { graphicalSessionMinimalMode: true });
  expect(harness.configStore.updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({ graphicalSessionMinimalMode: true }), { throwOnSaveError: true });
  harness.configStore.updateConfig.mockClear();
  set({}, { graphicalSessionMinimalMode: "false" });
  expect(harness.configStore.updateConfig).not.toHaveBeenCalled();
});

it("propagates graphical minimal mode persistence failures", () => {
  const harness = createHarness();
  harness.configStore.updateConfig.mockImplementation(() => { throw new Error("disk failure"); });
  expect(() => harness.ipcMain.handlers.get("config:set")({}, { graphicalSessionMinimalMode: true })).toThrow("disk failure");
});


it("broadcasts graphical menu settings after saving and never broadcasts failed saves", () => {
  const desktopBroadcast = vi.fn();
  const harness = createHarness({ desktopBroadcast });
  const handler = harness.ipcMain.handlers.get("config:set");
  const config = { codex: ["plugins"], opencode: ["login"] };
  handler({}, { graphicalMenuSecondaryActions: config });
  expect(harness.configStore.updateConfig).toHaveBeenCalledWith({ graphicalMenuSecondaryActions: config }, { throwOnSaveError: true });
  expect(desktopBroadcast).toHaveBeenCalledWith("config:graphical-menu-changed", config);
  expect(harness.mobileRemoteService.broadcastGraphicalMenuConfig).toHaveBeenCalledOnce();
  harness.configStore.updateConfig.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
  expect(() => handler({}, { graphicalMenuSecondaryActions: {} })).toThrow("disk unavailable");
  expect(desktopBroadcast).toHaveBeenCalledTimes(1);
  expect(harness.mobileRemoteService.broadcastGraphicalMenuConfig).toHaveBeenCalledTimes(1);
});


describe("companion settings IPC", () => {
  it("applies the saved boolean through the lifecycle callback", () => {
    const changed = vi.fn();
    const { ipcMain, configStore } = createHarness({ onDesktopMascotEnabledChange: changed });
    const set = ipcMain.handlers.get("config:set");
    expect(set({}, { desktopMascotEnabled: false }).desktopMascotEnabled).toBe(false);
    expect(configStore.updateConfig).toHaveBeenCalledWith({ desktopMascotEnabled: false }, { throwOnSaveError: true });
    expect(changed).toHaveBeenCalledWith(false);
    changed.mockClear();
    set({}, { desktopMascotEnabled: "true" });
    expect(changed).not.toHaveBeenCalled();
    configStore.updateConfig.mockImplementationOnce(() => { throw new Error("save failed"); });
    expect(() => set({}, { desktopMascotEnabled: true })).toThrow("save failed");
    expect(changed).not.toHaveBeenCalled();
  });
});

it("saves only boolean mobile preferences and broadcasts after successful persistence", () => {
  const harness = createHarness();
  const set = harness.ipcMain.handlers.get("config:set");
  set({}, { mobileGraphicalSessionMinimalMode: true });
  expect(harness.configStore.updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({ mobileGraphicalSessionMinimalMode: true }), { throwOnSaveError: true });
  expect(harness.mobileRemoteService.broadcastMobilePreferences).toHaveBeenCalledOnce();
  harness.configStore.updateConfig.mockClear();
  set({}, { mobileGraphicalSessionMinimalMode: "false" });
  expect(harness.configStore.updateConfig).not.toHaveBeenCalled();
  harness.configStore.updateConfig.mockImplementation(() => { throw new Error("disk failure"); });
  expect(() => set({}, { mobileGraphicalSessionMinimalMode: false })).toThrow("disk failure");
  expect(harness.mobileRemoteService.broadcastMobilePreferences).toHaveBeenCalledOnce();
});
