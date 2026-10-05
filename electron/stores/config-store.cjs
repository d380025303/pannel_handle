const { readJson, writeJson } = require("./business-store-io.cjs");
const { DEFAULT_SCREENSHOT_SHORTCUT, normalizeScreenshotShortcut } = require("../services/screenshot/screenshot-shortcut.cjs");

const DEFAULT_THEME_ID = "dark-slate";
const VALID_THEME_IDS = new Set(["dark-slate", "dark-blue", "dark-green", "light"]);
const DEFAULT_LOCALE = "zh-CN";
const VALID_LOCALES = new Set(["zh-CN", "en-US"]);
const DEFAULT_TITLE_BAR_ACTION_ORDER = ["terminal", "stats", "skills", "mcp", "assistant", "idea", "screenshot", "settings", "library", "quickAgent", "create"];
const VALID_TITLE_BAR_ACTIONS = new Set(DEFAULT_TITLE_BAR_ACTION_ORDER);
function normalizeTitleBarActionOrder(value) {
  const seen = new Set();
  const ordered = [];
  for (const id of Array.isArray(value) ? value : []) {
    if (VALID_TITLE_BAR_ACTIONS.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  const normalized = [...ordered, ...DEFAULT_TITLE_BAR_ACTION_ORDER.filter(id => !seen.has(id) && id !== "settings")];
  if (!seen.has("settings")) normalized.splice(7, 0, "settings");
  return normalized;
}
function normalizeTitleBarHiddenActions(value) {
  return DEFAULT_TITLE_BAR_ACTION_ORDER.filter(id => id !== "settings" && Array.isArray(value) && value.includes(id));
}
function normalizeThemeId(themeId) {
  return VALID_THEME_IDS.has(themeId) ? themeId : DEFAULT_THEME_ID;
}

function normalizeLocale(locale) {
  return VALID_LOCALES.has(locale) ? locale : DEFAULT_LOCALE;
}

function normalizeWindowsShell(value) {
  return ["cmd", "powershell", "pwsh"].includes(value) ? value : "cmd";
}

const DEFAULT_TERMINAL_BACKGROUND_IMAGE = "";
const DEFAULT_TERMINAL_BACKGROUND_OPACITY = 40;
const DEFAULT_TERMINAL_BACKGROUND_BLUR = 0;
const DEFAULT_TERMINAL_BACKGROUND_POSITION = 50;

function normalizeTerminalBackgroundImage(value) {
  if (typeof value !== "string") return DEFAULT_TERMINAL_BACKGROUND_IMAGE;
  if (value === "") return "";
  if (value.length > 260) return DEFAULT_TERMINAL_BACKGROUND_IMAGE;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    return DEFAULT_TERMINAL_BACKGROUND_IMAGE;
  }
  return value;
}

function normalizeTerminalBackgroundOpacity(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TERMINAL_BACKGROUND_OPACITY;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeTerminalBackgroundBlur(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TERMINAL_BACKGROUND_BLUR;
  return Math.min(40, Math.max(0, Math.round(value)));
}

function normalizeTerminalBackgroundPosition(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TERMINAL_BACKGROUND_POSITION;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function createConfigStore({ configFile, dataStore }) {
  let legacyCodexAppServerEnabled = true;
  let config = {
    defaultWindowsShell: "cmd",
    autoRestore: true,
    autoWorkBuddyCheckin: true,
    autoQoderCheckin: false,
    autoCollapseFileChains: true,
    debugMode: false,
    graphicalSessionMinimalMode: false,
    screenshotEnabled: true,
    screenshotShortcut: DEFAULT_SCREENSHOT_SHORTCUT,
    titleBarActionOrder: [...DEFAULT_TITLE_BAR_ACTION_ORDER],
    titleBarHiddenActions: [],
    lastActiveSessionIds: [],
    themeId: DEFAULT_THEME_ID,
    locale: DEFAULT_LOCALE,
    sidebarWidth: 290,
    rightToolsWidth: 380,
    terminalBackgroundImage: DEFAULT_TERMINAL_BACKGROUND_IMAGE,
    terminalBackgroundOpacity: DEFAULT_TERMINAL_BACKGROUND_OPACITY,
    terminalBackgroundBlur: DEFAULT_TERMINAL_BACKGROUND_BLUR,
    terminalBackgroundPositionX: DEFAULT_TERMINAL_BACKGROUND_POSITION,
    terminalBackgroundPositionY: DEFAULT_TERMINAL_BACKGROUND_POSITION
  };

  function serializeConfig() {
    return {
      defaultWindowsShell: config.defaultWindowsShell,
      autoRestore: config.autoRestore,
      autoWorkBuddyCheckin: config.autoWorkBuddyCheckin,
      autoQoderCheckin: config.autoQoderCheckin,
      autoCollapseFileChains: config.autoCollapseFileChains,
      debugMode: config.debugMode,
      graphicalSessionMinimalMode: config.graphicalSessionMinimalMode,
      screenshotEnabled: config.screenshotEnabled,
      screenshotShortcut: config.screenshotShortcut,
      titleBarActionOrder: config.titleBarActionOrder,
      titleBarHiddenActions: config.titleBarHiddenActions,
      lastActiveSessionIds: config.lastActiveSessionIds,
      themeId: config.themeId,
      locale: config.locale,
      sidebarWidth: config.sidebarWidth,
      rightToolsWidth: config.rightToolsWidth,
      terminalBackgroundImage: config.terminalBackgroundImage,
      terminalBackgroundOpacity: config.terminalBackgroundOpacity,
      terminalBackgroundBlur: config.terminalBackgroundBlur,
      terminalBackgroundPositionX: config.terminalBackgroundPositionX,
      terminalBackgroundPositionY: config.terminalBackgroundPositionY
    };
  }

  function loadConfig() {
    try {
      const parsed = readJson(dataStore, configFile);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        legacyCodexAppServerEnabled = typeof parsed.codexAppServerEnabled === "boolean" ? parsed.codexAppServerEnabled : true;
        config = {
          defaultWindowsShell: normalizeWindowsShell(parsed.defaultWindowsShell),
          autoRestore: typeof parsed.autoRestore === "boolean" ? parsed.autoRestore : true,
          autoWorkBuddyCheckin: typeof parsed.autoWorkBuddyCheckin === "boolean" ? parsed.autoWorkBuddyCheckin : true,
          autoQoderCheckin: parsed.autoQoderCheckin === true,
          autoCollapseFileChains: typeof parsed.autoCollapseFileChains === "boolean" ? parsed.autoCollapseFileChains : true,
          debugMode: typeof parsed.debugMode === "boolean" ? parsed.debugMode : false,
          graphicalSessionMinimalMode: typeof parsed.graphicalSessionMinimalMode === "boolean" ? parsed.graphicalSessionMinimalMode : false,
          screenshotEnabled: typeof parsed.screenshotEnabled === "boolean" ? parsed.screenshotEnabled : true,
          screenshotShortcut: normalizeScreenshotShortcut(parsed.screenshotShortcut) || DEFAULT_SCREENSHOT_SHORTCUT,
          titleBarActionOrder: normalizeTitleBarActionOrder(parsed.titleBarActionOrder),
          titleBarHiddenActions: normalizeTitleBarHiddenActions(parsed.titleBarHiddenActions),
          lastActiveSessionIds: Array.isArray(parsed.lastActiveSessionIds)
            ? parsed.lastActiveSessionIds.filter(id => typeof id === "string")
            : [],
          themeId: normalizeThemeId(parsed.themeId),
          locale: normalizeLocale(parsed.locale),
          sidebarWidth: typeof parsed.sidebarWidth === "number"
            && parsed.sidebarWidth >= 180 && parsed.sidebarWidth <= 500
            ? parsed.sidebarWidth : 290,
          rightToolsWidth: typeof parsed.rightToolsWidth === "number"
            && parsed.rightToolsWidth >= 280 && parsed.rightToolsWidth <= 600
            ? parsed.rightToolsWidth : 380,
          terminalBackgroundImage: normalizeTerminalBackgroundImage(parsed.terminalBackgroundImage),
          terminalBackgroundOpacity: normalizeTerminalBackgroundOpacity(parsed.terminalBackgroundOpacity),
          terminalBackgroundBlur: normalizeTerminalBackgroundBlur(parsed.terminalBackgroundBlur),
          terminalBackgroundPositionX: normalizeTerminalBackgroundPosition(parsed.terminalBackgroundPositionX),
          terminalBackgroundPositionY: normalizeTerminalBackgroundPosition(parsed.terminalBackgroundPositionY)
        };
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      console.error("Failed to load config:", err);
    }
  }

  function saveConfig(throwOnError = false) {
    try {
      writeJson(dataStore, configFile, serializeConfig());
    } catch (err) {
      console.error("Failed to save config:", err);
      if (throwOnError) throw err;
    }
  }

  function getConfig() {
    return {
      defaultWindowsShell: config.defaultWindowsShell,
      autoRestore: config.autoRestore,
      autoWorkBuddyCheckin: config.autoWorkBuddyCheckin,
      autoQoderCheckin: config.autoQoderCheckin,
      autoCollapseFileChains: config.autoCollapseFileChains,
      debugMode: config.debugMode,
      graphicalSessionMinimalMode: config.graphicalSessionMinimalMode,
      screenshotEnabled: config.screenshotEnabled,
      screenshotShortcut: config.screenshotShortcut,
      titleBarActionOrder: [...config.titleBarActionOrder],
      titleBarHiddenActions: [...config.titleBarHiddenActions],
      lastActiveSessionIds: [...config.lastActiveSessionIds],
      themeId: config.themeId,
      locale: config.locale,
      sidebarWidth: config.sidebarWidth,
      rightToolsWidth: config.rightToolsWidth,
      terminalBackgroundImage: config.terminalBackgroundImage,
      terminalBackgroundOpacity: config.terminalBackgroundOpacity,
      terminalBackgroundBlur: config.terminalBackgroundBlur,
      terminalBackgroundPositionX: config.terminalBackgroundPositionX,
      terminalBackgroundPositionY: config.terminalBackgroundPositionY
    };
  }

  function updateConfig(partial, options = {}) {
    const previousConfig = options.throwOnSaveError ? { ...config } : null;
    if (partial && typeof partial === "object") {
      if (Object.hasOwn(partial, "defaultWindowsShell")) {
        config.defaultWindowsShell = normalizeWindowsShell(partial.defaultWindowsShell);
      }
      if (typeof partial.autoRestore === "boolean") {
        config.autoRestore = partial.autoRestore;
      }
      if (typeof partial.autoWorkBuddyCheckin === "boolean") {
        config.autoWorkBuddyCheckin = partial.autoWorkBuddyCheckin;
      }
      if (typeof partial.autoQoderCheckin === "boolean") {
        config.autoQoderCheckin = partial.autoQoderCheckin;
      }
      if (typeof partial.autoCollapseFileChains === "boolean") {
        config.autoCollapseFileChains = partial.autoCollapseFileChains;
      }
      if (typeof partial.graphicalSessionMinimalMode === "boolean") {
        config.graphicalSessionMinimalMode = partial.graphicalSessionMinimalMode;
      }
      if (typeof partial.debugMode === "boolean") {
        config.debugMode = partial.debugMode;
      }
      if (typeof partial.screenshotEnabled === "boolean") {
        config.screenshotEnabled = partial.screenshotEnabled;
      }
      if (typeof partial.screenshotShortcut === "string") {
        const screenshotShortcut = normalizeScreenshotShortcut(partial.screenshotShortcut);
        if (screenshotShortcut) config.screenshotShortcut = screenshotShortcut;
      }
      if (Array.isArray(partial.lastActiveSessionIds)) {
        config.lastActiveSessionIds = partial.lastActiveSessionIds.filter(id => typeof id === "string");
      }
      if (typeof partial.themeId === "string") {
        config.themeId = normalizeThemeId(partial.themeId);
      }
      if (typeof partial.locale === "string") {
        config.locale = normalizeLocale(partial.locale);
      }
      if (typeof partial.sidebarWidth === "number"
        && partial.sidebarWidth >= 180 && partial.sidebarWidth <= 500) {
        config.sidebarWidth = partial.sidebarWidth;
      }
      if (typeof partial.rightToolsWidth === "number"
        && partial.rightToolsWidth >= 280 && partial.rightToolsWidth <= 600) {
        config.rightToolsWidth = partial.rightToolsWidth;
      }
      if (typeof partial.terminalBackgroundImage === "string") {
        config.terminalBackgroundImage = normalizeTerminalBackgroundImage(partial.terminalBackgroundImage);
      }
      if (typeof partial.terminalBackgroundOpacity === "number") {
        config.terminalBackgroundOpacity = normalizeTerminalBackgroundOpacity(partial.terminalBackgroundOpacity);
      }
      if (typeof partial.terminalBackgroundBlur === "number") {
        config.terminalBackgroundBlur = normalizeTerminalBackgroundBlur(partial.terminalBackgroundBlur);
      }
      if (Array.isArray(partial.titleBarActionOrder)) {
        config.titleBarActionOrder = normalizeTitleBarActionOrder(partial.titleBarActionOrder);
      }
      if (Array.isArray(partial.titleBarHiddenActions)) {
        config.titleBarHiddenActions = normalizeTitleBarHiddenActions(partial.titleBarHiddenActions);
      }
      if (typeof partial.terminalBackgroundPositionX === "number") {
        config.terminalBackgroundPositionX = normalizeTerminalBackgroundPosition(partial.terminalBackgroundPositionX);
      }
      if (typeof partial.terminalBackgroundPositionY === "number") {
        config.terminalBackgroundPositionY = normalizeTerminalBackgroundPosition(partial.terminalBackgroundPositionY);
      }
    }
    try {
      saveConfig(options.throwOnSaveError);
    } catch (error) {
      config = previousConfig;
      throw error;
    }
  }

  return {
    loadConfig,
    saveConfig,
    getConfig,
    getLegacyCodexAppServerEnabled: () => legacyCodexAppServerEnabled,
    updateConfig
  };
}

module.exports = {
  DEFAULT_TITLE_BAR_ACTION_ORDER,
  normalizeTitleBarActionOrder,
  normalizeTitleBarHiddenActions,
  DEFAULT_THEME_ID,
  VALID_THEME_IDS,
  DEFAULT_LOCALE,
  VALID_LOCALES,
  DEFAULT_TERMINAL_BACKGROUND_IMAGE,
  DEFAULT_TERMINAL_BACKGROUND_OPACITY,
  DEFAULT_TERMINAL_BACKGROUND_BLUR,
  DEFAULT_TERMINAL_BACKGROUND_POSITION,
  createConfigStore,
  normalizeThemeId,
  normalizeLocale,
  normalizeTerminalBackgroundImage,
  normalizeTerminalBackgroundOpacity,
  normalizeTerminalBackgroundBlur,
  normalizeTerminalBackgroundPosition
};
