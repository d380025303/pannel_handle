const { VALID_LOCALES, VALID_THEME_IDS } = require("../../stores/config-store.cjs");
const { normalizeScreenshotShortcut } = require("../screenshot/screenshot-shortcut.cjs");
const { copyBackgroundImage } = require("./terminal-background.cjs");
const {
  normalizeTerminalBackgroundImage,
  normalizeTerminalBackgroundOpacity,
  normalizeTerminalBackgroundBlur
} = require("../../stores/config-store.cjs");

const SETTINGS_IPC_CHANNELS = [
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
  "openrouter:set-favorites",
  "nararouter:get-config",
  "nararouter:list-models",
  "nararouter:refresh-models",
  "nararouter:save-api-key",
  "nararouter:clear-api-key",
  "nararouter:test",
  "nararouter:verify-models",
  "nararouter:set-favorites",
  "minimax:get-config",
  "minimax:list-models",
  "minimax:refresh-models",
  "minimax:save-api-key",
  "minimax:clear-api-key",
  "minimax:test",
  "minimax:verify-models",
  "minimax:set-favorites",
  "codebuddy-codex:get-config",
  "codebuddy-codex:get-status",
  "codebuddy-codex:list-models",
  "codebuddy-codex:refresh-models",
  "codebuddy-codex:verify-model",
  "codebuddy-codex:set-favorites",
  "codebuddy-codex:set-experimental-acknowledged",
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
  ipcMain.handle(`${prefix}:set-favorites`, (_event, input) => service.setFavorites(input));
}

function registerSettingsIpcHandlers({
  ipcMain,
  configStore,
  dingTalkConfigStore,
  dingTalkNotificationManager,
  workBuddyAutoCheckinService,
  openRouterService,
  naraRouterService,
  miniMaxService,
  codeBuddyCodexBridgeService,
  getMobileRemoteService,
  dialog,
  getWindowFromEvent,
  userDataDir
}) {
  ipcMain.handle("config:get", () => configStore.getConfig());
  ipcMain.handle("config:set", (_event, partial) => {
    const updates = {};
    if (partial && ["cmd", "powershell", "pwsh"].includes(partial.defaultWindowsShell)) {
      updates.defaultWindowsShell = partial.defaultWindowsShell;
    }
    if (partial && typeof partial.autoRestore === "boolean") {
      updates.autoRestore = partial.autoRestore;
    }
    if (partial && typeof partial.autoWorkBuddyCheckin === "boolean") {
      updates.autoWorkBuddyCheckin = partial.autoWorkBuddyCheckin;
    }
    if (partial && typeof partial.autoCollapseFileChains === "boolean") {
      updates.autoCollapseFileChains = partial.autoCollapseFileChains;
    }
    if (partial && typeof partial.debugMode === "boolean") {
      updates.debugMode = partial.debugMode;
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
    if (Object.keys(updates).length > 0) {
      configStore.updateConfig(updates);
    }
    const config = configStore.getConfig();
    if (Object.prototype.hasOwnProperty.call(updates, "autoWorkBuddyCheckin")) {
      workBuddyAutoCheckinService?.setEnabled(config.autoWorkBuddyCheckin);
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

  ipcMain.handle("codebuddy-codex:get-config", () => codeBuddyCodexBridgeService.getConfig());
  ipcMain.handle("codebuddy-codex:get-status", () => codeBuddyCodexBridgeService.getStatus());
  ipcMain.handle("codebuddy-codex:list-models", () => codeBuddyCodexBridgeService.listModels());
  ipcMain.handle("codebuddy-codex:refresh-models", () => codeBuddyCodexBridgeService.refreshModels());
  ipcMain.handle("codebuddy-codex:verify-model", (_event, input) => codeBuddyCodexBridgeService.verifyModel(input));
  ipcMain.handle("codebuddy-codex:set-favorites", (_event, input) => codeBuddyCodexBridgeService.setFavorites(input));
  ipcMain.handle("codebuddy-codex:set-experimental-acknowledged", (_event, input) => codeBuddyCodexBridgeService.setExperimentalAcknowledged(input));

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
