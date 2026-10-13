const { VALID_LOCALES, VALID_THEME_IDS, normalizeTitleBarActionOrder, normalizeTitleBarHiddenActions } = require("../../stores/config-store.cjs");
const { normalizeScreenshotShortcut } = require("../screenshot/screenshot-shortcut.cjs");
const { copyBackgroundImage } = require("./terminal-background.cjs");
const {
  normalizeTerminalBackgroundImage,
  normalizeTerminalBackgroundOpacity,
  normalizeTerminalBackgroundBlur,
  normalizeTerminalBackgroundPosition
} = require("../../stores/config-store.cjs");
const { readMiniMaxUsage } = require("../token-usage/minimax-usage-client.cjs");

const SETTINGS_IPC_CHANNELS = [
  "project-tools:list",
  "config:get",
  "config:set",
  "terminal-background:choose-image",
  "dingtalk:get-config",
  "dingtalk:set-config",
  "dingtalk:clear-credentials",
  "dingtalk:test",
  "openrouter:get-config",
  "openrouter:list-models",
  "openrouter:refresh-models",
  "openrouter:save-api-key",
  "openrouter:clear-api-key",
  "openrouter:test",
  "openrouter:verify-models",
  "openrouter:verify-agent-models",
  "nararouter:get-config",
  "nararouter:list-models",
  "nararouter:refresh-models",
  "nararouter:save-api-key",
  "nararouter:clear-api-key",
  "nararouter:test",
  "nararouter:verify-models",
  "nararouter:verify-agent-models",
  "minimax:get-config",
  "minimax:list-models",
  "minimax:refresh-models",
  "minimax:save-api-key",
  "minimax:clear-api-key",
  "minimax:test",
  "minimax:verify-models",
  "minimax:verify-agent-models",
  "minimax:get-usage",
  "mobile-access:get-state",
  "mobile-access:update-config",
  "mobile-access:set-password",
  "mobile-access:list-audit",
  "mobile-access:disconnect-connection"
];

function registerRouterIpcHandlers(ipcMain, prefix, service) {
  ipcMain.handle(`${prefix}:get-config`, () => service.getConfig());
  ipcMain.handle(`${prefix}:list-models`, () => service.listModels());
  ipcMain.handle(`${prefix}:refresh-models`, () => service.refreshModels());
  ipcMain.handle(`${prefix}:save-api-key`, (_event, apiKey) => service.saveApiKey(apiKey));
  ipcMain.handle(`${prefix}:clear-api-key`, () => service.clearApiKey());
  ipcMain.handle(`${prefix}:test`, () => service.testConnection());
  ipcMain.handle(`${prefix}:verify-models`, (_event, input) => service.verifyModels(input));
  ipcMain.handle(`${prefix}:verify-agent-models`, (_event, input) => service.verifyAgentModels(input));
}

function registerSettingsIpcHandlers({
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
  miniMaxUsageOptions = {},
  getMobileRemoteService,
  desktopBroadcast,
  onDesktopMascotEnabledChange,
  dialog,
  getWindowFromEvent,
  userDataDir
}) {
  ipcMain.handle("project-tools:list", () => require("./project-tool-catalog.cjs").listProjectTools());
  ipcMain.handle("config:get", () => configStore.getConfig());
  ipcMain.handle("config:set", (_event, partial) => {
    const updates = {};
    if (partial && ["cmd", "powershell", "pwsh"].includes(partial.defaultWindowsShell)) {
      if (partial.defaultWindowsShell !== configStore.getConfig().defaultWindowsShell) {
        require("../../terminal/terminal-manager.cjs").clearExecutableCache();
      }
      updates.defaultWindowsShell = partial.defaultWindowsShell;
    }
    if (partial && typeof partial.autoRestore === "boolean") {
      updates.autoRestore = partial.autoRestore;
    }
    if (partial && typeof partial.autoWorkBuddyCheckin === "boolean") {
      updates.autoWorkBuddyCheckin = partial.autoWorkBuddyCheckin;
    }
    if (partial && typeof partial.autoQoderCheckin === "boolean") {
      updates.autoQoderCheckin = partial.autoQoderCheckin;
    }
    if (partial && typeof partial.autoCollapseFileChains === "boolean") {
      updates.autoCollapseFileChains = partial.autoCollapseFileChains;
    }
    if (partial && typeof partial.mobileGraphicalSessionMinimalMode === "boolean") {
      updates.mobileGraphicalSessionMinimalMode = partial.mobileGraphicalSessionMinimalMode;
    }
    if (partial && typeof partial.graphicalSessionMinimalMode === "boolean") {
      updates.graphicalSessionMinimalMode = partial.graphicalSessionMinimalMode;
    }
    if (partial && Object.hasOwn(partial, "graphicalMenuSecondaryActions")) {
      updates.graphicalMenuSecondaryActions = partial.graphicalMenuSecondaryActions;
    }
    if (partial && typeof partial.debugMode === "boolean") {
      updates.debugMode = partial.debugMode;
    }
    if (partial && typeof partial.desktopMascotEnabled === "boolean") {
      updates.desktopMascotEnabled = partial.desktopMascotEnabled;
    }
    if (partial && typeof partial.screenshotEnabled === "boolean") {
      updates.screenshotEnabled = partial.screenshotEnabled;
    }
    if (partial && typeof partial.screenshotShortcut === "string") {
      const screenshotShortcut = normalizeScreenshotShortcut(partial.screenshotShortcut);
      if (screenshotShortcut) updates.screenshotShortcut = screenshotShortcut;
    }
    if (partial && typeof partial.themeId === "string" && VALID_THEME_IDS.has(partial.themeId)) {
      updates.themeId = partial.themeId;
    }
    if (partial && typeof partial.locale === "string" && VALID_LOCALES.has(partial.locale)) {
      updates.locale = partial.locale;
    }
    if (partial && typeof partial.sidebarWidth === "number"
      && partial.sidebarWidth >= 180 && partial.sidebarWidth <= 500) {
      updates.sidebarWidth = partial.sidebarWidth;
    }
    if (partial && typeof partial.rightToolsWidth === "number"
      && partial.rightToolsWidth >= 280 && partial.rightToolsWidth <= 600) {
      updates.rightToolsWidth = partial.rightToolsWidth;
    }
    if (partial && typeof partial.terminalBackgroundImage === "string") {
      updates.terminalBackgroundImage = normalizeTerminalBackgroundImage(partial.terminalBackgroundImage);
    }
    if (partial && typeof partial.terminalBackgroundOpacity === "number") {
      updates.terminalBackgroundOpacity = normalizeTerminalBackgroundOpacity(partial.terminalBackgroundOpacity);
    }
    if (partial && typeof partial.terminalBackgroundBlur === "number") {
      updates.terminalBackgroundBlur = normalizeTerminalBackgroundBlur(partial.terminalBackgroundBlur);
    }
    if (partial && Array.isArray(partial.titleBarActionOrder)) {
      updates.titleBarActionOrder = normalizeTitleBarActionOrder(partial.titleBarActionOrder);
    }
    if (partial && Array.isArray(partial.titleBarHiddenActions)) {
      updates.titleBarHiddenActions = normalizeTitleBarHiddenActions(partial.titleBarHiddenActions);
    }
    if (partial && typeof partial.terminalBackgroundPositionX === "number") {
      updates.terminalBackgroundPositionX = normalizeTerminalBackgroundPosition(partial.terminalBackgroundPositionX);
    }
    if (partial && typeof partial.terminalBackgroundPositionY === "number") {
      updates.terminalBackgroundPositionY = normalizeTerminalBackgroundPosition(partial.terminalBackgroundPositionY);
    }
    if (Object.keys(updates).length > 0) {
      configStore.updateConfig(updates, { throwOnSaveError: true });
    }
    const config = configStore.getConfig();
    if (Object.hasOwn(updates, "desktopMascotEnabled")) {
      onDesktopMascotEnabledChange?.(config.desktopMascotEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(updates, "autoWorkBuddyCheckin")) {
      workBuddyAutoCheckinService?.setEnabled(config.autoWorkBuddyCheckin);
    }
    if (Object.prototype.hasOwnProperty.call(updates, "autoQoderCheckin")) {
      qoderAutoCheckinService?.setEnabled(config.autoQoderCheckin);
    }
    if (Object.hasOwn(updates, "mobileGraphicalSessionMinimalMode")) {
      getMobileRemoteService?.()?.broadcastMobilePreferences?.();
    }
    if (Object.hasOwn(updates, "graphicalMenuSecondaryActions")) {
      desktopBroadcast?.("config:graphical-menu-changed", config.graphicalMenuSecondaryActions);
      getMobileRemoteService?.()?.broadcastGraphicalMenuConfig?.();
    }
    return config;
  });

  ipcMain.handle("terminal-background:choose-image", async (event) => {
    if (!dialog || !userDataDir) {
      return { canceled: false, error: "Terminal background service unavailable" };
    }
    const ownerWindow = typeof getWindowFromEvent === "function" ? getWindowFromEvent(event) : undefined;
    const options = {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }]
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { canceled: true };
    }
    try {
      const name = copyBackgroundImage(result.filePaths[0], userDataDir);
      return { canceled: false, name };
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("dingtalk:get-config", () => dingTalkConfigStore.getConfig());
  ipcMain.handle("dingtalk:set-config", (_event, input) => dingTalkNotificationManager.updateConfig(input));
  ipcMain.handle("dingtalk:clear-credentials", () => dingTalkNotificationManager.clearCredentials());
  ipcMain.handle("dingtalk:test", () => dingTalkNotificationManager.testConnection());

  registerRouterIpcHandlers(ipcMain, "openrouter", openRouterService);
  registerRouterIpcHandlers(ipcMain, "nararouter", naraRouterService);
  registerRouterIpcHandlers(ipcMain, "minimax", miniMaxService);

  const MINIMAX_USAGE_CACHE_TTL_MS = 30 * 1000;
  const miniMaxUsageNow = miniMaxUsageOptions.now || (() => Date.now());
  let miniMaxUsageCache = null;
  ipcMain.handle("minimax:get-usage", async (_event, options = {}) => {
    const apiKey = String(miniMaxConfigStore?.getApiKey?.() || "").trim();
    if (!apiKey) throw new Error("请先在设置中配置 MiniMax API Key。");
    const ttlMs = miniMaxUsageOptions.cacheTtlMs ?? MINIMAX_USAGE_CACHE_TTL_MS;
    if (!options?.force && miniMaxUsageCache && miniMaxUsageCache.apiKey === apiKey
      && miniMaxUsageNow() - miniMaxUsageCache.snapshot.fetchedAt < ttlMs) {
      return miniMaxUsageCache.snapshot;
    }
    const snapshot = await readMiniMaxUsage({
      apiKey,
      timeoutMs: 10_000,
      now: miniMaxUsageNow,
      ...(miniMaxUsageOptions.fetchImpl ? { fetchImpl: miniMaxUsageOptions.fetchImpl } : {})
    });
    miniMaxUsageCache = { apiKey, snapshot };
    return snapshot;
  });

  ipcMain.handle("mobile-access:get-state", () => getMobileRemoteService().getState());
  ipcMain.handle("mobile-access:update-config", (_event, partial) => getMobileRemoteService().updateConfig(partial));
  ipcMain.handle("mobile-access:set-password", (_event, password) => getMobileRemoteService().setPassword(password));
  ipcMain.handle("mobile-access:list-audit", () => getMobileRemoteService().listAudit());
  ipcMain.handle("mobile-access:disconnect-connection", (_event, connectionId) => getMobileRemoteService().disconnectConnection(connectionId));

  return () => {
    for (const channel of SETTINGS_IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  };
}

module.exports = {
  SETTINGS_IPC_CHANNELS,
  registerSettingsIpcHandlers
};
