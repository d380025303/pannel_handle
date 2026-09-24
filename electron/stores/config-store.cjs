const { readJson, writeJson } = require("./business-store-io.cjs");
const { DEFAULT_SCREENSHOT_SHORTCUT, normalizeScreenshotShortcut } = require("../services/screenshot/screenshot-shortcut.cjs");

const DEFAULT_THEME_ID = "dark-slate";
const VALID_THEME_IDS = new Set(["dark-slate", "dark-blue", "dark-green", "light"]);
const DEFAULT_LOCALE = "zh-CN";
const VALID_LOCALES = new Set(["zh-CN", "en-US"]);
function normalizeThemeId(themeId) {
  return VALID_THEME_IDS.has(themeId) ? themeId : DEFAULT_THEME_ID;
}

function normalizeLocale(locale) {
  return VALID_LOCALES.has(locale) ? locale : DEFAULT_LOCALE;
}

function normalizeWindowsShell(value) {
  return ["cmd", "powershell", "pwsh"].includes(value) ? value : "cmd";
}

function createConfigStore({ configFile, dataStore }) {
  let config = {
    defaultWindowsShell: "cmd",
    codexAppServerEnabled: true,
    autoRestore: true,
    autoWorkBuddyCheckin: true,
    autoCollapseFileChains: true,
    debugMode: false,
    screenshotEnabled: true,
    screenshotShortcut: DEFAULT_SCREENSHOT_SHORTCUT,
    lastActiveSessionIds: [],
    themeId: DEFAULT_THEME_ID,
    locale: DEFAULT_LOCALE,
    sidebarWidth: 290,
    rightToolsWidth: 380
  };

  function serializeConfig() {
    return {
      defaultWindowsShell: config.defaultWindowsShell,
      codexAppServerEnabled: config.codexAppServerEnabled,
      autoRestore: config.autoRestore,
      autoWorkBuddyCheckin: config.autoWorkBuddyCheckin,
      autoCollapseFileChains: config.autoCollapseFileChains,
      debugMode: config.debugMode,
      screenshotEnabled: config.screenshotEnabled,
      screenshotShortcut: config.screenshotShortcut,
      lastActiveSessionIds: config.lastActiveSessionIds,
      themeId: config.themeId,
      locale: config.locale,
      sidebarWidth: config.sidebarWidth,
      rightToolsWidth: config.rightToolsWidth
    };
  }

  function loadConfig() {
    try {
      const parsed = readJson(dataStore, configFile);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = {
          defaultWindowsShell: normalizeWindowsShell(parsed.defaultWindowsShell),
          codexAppServerEnabled: typeof parsed.codexAppServerEnabled === "boolean" ? parsed.codexAppServerEnabled : true,
          autoRestore: typeof parsed.autoRestore === "boolean" ? parsed.autoRestore : true,
          autoWorkBuddyCheckin: typeof parsed.autoWorkBuddyCheckin === "boolean" ? parsed.autoWorkBuddyCheckin : true,
          autoCollapseFileChains: typeof parsed.autoCollapseFileChains === "boolean" ? parsed.autoCollapseFileChains : true,
          debugMode: typeof parsed.debugMode === "boolean" ? parsed.debugMode : false,
          screenshotEnabled: typeof parsed.screenshotEnabled === "boolean" ? parsed.screenshotEnabled : true,
          screenshotShortcut: normalizeScreenshotShortcut(parsed.screenshotShortcut) || DEFAULT_SCREENSHOT_SHORTCUT,
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
            ? parsed.rightToolsWidth : 380
        };
      }
    } catch (err) {
      if (err.code === "ENOENT") return;
      console.error("Failed to load config:", err);
    }
  }

  function saveConfig() {
    try {
      writeJson(dataStore, configFile, serializeConfig());
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  }

  function getConfig() {
    return {
      defaultWindowsShell: config.defaultWindowsShell,
      codexAppServerEnabled: config.codexAppServerEnabled,
      autoRestore: config.autoRestore,
      autoWorkBuddyCheckin: config.autoWorkBuddyCheckin,
      autoCollapseFileChains: config.autoCollapseFileChains,
      debugMode: config.debugMode,
      screenshotEnabled: config.screenshotEnabled,
      screenshotShortcut: config.screenshotShortcut,
      lastActiveSessionIds: [...config.lastActiveSessionIds],
      themeId: config.themeId,
      locale: config.locale,
      sidebarWidth: config.sidebarWidth,
      rightToolsWidth: config.rightToolsWidth
    };
  }

  function updateConfig(partial) {
    if (partial && typeof partial === "object") {
      if (Object.hasOwn(partial, "defaultWindowsShell")) {
        config.defaultWindowsShell = normalizeWindowsShell(partial.defaultWindowsShell);
      }
      if (typeof partial.codexAppServerEnabled === "boolean") {
        config.codexAppServerEnabled = partial.codexAppServerEnabled;
      }
      if (typeof partial.autoRestore === "boolean") {
        config.autoRestore = partial.autoRestore;
      }
      if (typeof partial.autoWorkBuddyCheckin === "boolean") {
        config.autoWorkBuddyCheckin = partial.autoWorkBuddyCheckin;
      }
      if (typeof partial.autoCollapseFileChains === "boolean") {
        config.autoCollapseFileChains = partial.autoCollapseFileChains;
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
    }
    saveConfig();
  }

  return {
    loadConfig,
    saveConfig,
    getConfig,
    updateConfig
  };
}

module.exports = {
  DEFAULT_THEME_ID,
  VALID_THEME_IDS,
  DEFAULT_LOCALE,
  VALID_LOCALES,
  createConfigStore,
  normalizeThemeId,
  normalizeLocale
};
