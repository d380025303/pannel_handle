const fs = require("node:fs");

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

function createConfigStore({ configFile }) {
  let config = {
    autoRestore: true,
    debugMode: false,
    lastActiveSessionIds: [],
    themeId: DEFAULT_THEME_ID,
    locale: DEFAULT_LOCALE,
    rightToolsWidth: 380
  };

  function serializeConfig() {
    return {
      autoRestore: config.autoRestore,
      debugMode: config.debugMode,
      lastActiveSessionIds: config.lastActiveSessionIds,
      themeId: config.themeId,
      locale: config.locale,
      rightToolsWidth: config.rightToolsWidth
    };
  }

  function loadConfig() {
    try {
      const data = fs.readFileSync(configFile, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = {
          autoRestore: typeof parsed.autoRestore === "boolean" ? parsed.autoRestore : true,
          debugMode: typeof parsed.debugMode === "boolean" ? parsed.debugMode : false,
          lastActiveSessionIds: Array.isArray(parsed.lastActiveSessionIds)
            ? parsed.lastActiveSessionIds.filter(id => typeof id === "string")
            : [],
          themeId: normalizeThemeId(parsed.themeId),
          locale: normalizeLocale(parsed.locale),
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
      const data = JSON.stringify(serializeConfig(), null, 2);
      const tmpPath = configFile + ".tmp";
      fs.writeFileSync(tmpPath, data, "utf-8");
      fs.renameSync(tmpPath, configFile);
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  }

  function getConfig() {
    return {
      autoRestore: config.autoRestore,
      debugMode: config.debugMode,
      lastActiveSessionIds: [...config.lastActiveSessionIds],
      themeId: config.themeId,
      locale: config.locale,
      rightToolsWidth: config.rightToolsWidth
    };
  }

  function updateConfig(partial) {
    if (partial && typeof partial === "object") {
      if (typeof partial.autoRestore === "boolean") {
        config.autoRestore = partial.autoRestore;
      }
      if (typeof partial.debugMode === "boolean") {
        config.debugMode = partial.debugMode;
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
