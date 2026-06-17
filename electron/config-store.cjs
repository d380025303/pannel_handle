const fs = require("node:fs");

const DEFAULT_THEME_ID = "dark-slate";
const VALID_THEME_IDS = new Set(["dark-slate", "dark-blue", "dark-green", "light"]);
const QQ_BOT_NOTIFY_STATUSES = new Set(["waiting_for_permission", "completed", "failed", "ended"]);

const DEFAULT_QQ_BOT_CONFIG = {
  enabled: false,
  appId: "",
  clientSecret: "",
  clientSecretEncrypted: "",
  targetOpenid: "",
  notifyStatuses: ["waiting_for_permission", "completed", "failed", "ended"],
  queueWhenUnavailable: true
};

function normalizeThemeId(themeId) {
  return VALID_THEME_IDS.has(themeId) ? themeId : DEFAULT_THEME_ID;
}

function normalizeQqBotConfig(value, decryptSecret) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const clientSecretEncrypted = typeof input.clientSecretEncrypted === "string" ? input.clientSecretEncrypted : "";
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_QQ_BOT_CONFIG.enabled,
    appId: typeof input.appId === "string" ? input.appId.trim() : "",
    clientSecret: decryptSecret(clientSecretEncrypted),
    clientSecretEncrypted,
    targetOpenid: typeof input.targetOpenid === "string" ? input.targetOpenid.trim() : "",
    notifyStatuses: Array.isArray(input.notifyStatuses)
      ? input.notifyStatuses.filter(status => QQ_BOT_NOTIFY_STATUSES.has(status))
      : DEFAULT_QQ_BOT_CONFIG.notifyStatuses,
    queueWhenUnavailable: typeof input.queueWhenUnavailable === "boolean"
      ? input.queueWhenUnavailable
      : DEFAULT_QQ_BOT_CONFIG.queueWhenUnavailable
  };
}

function getPublicQqBotConfig(config) {
  const qqBot = config.qqBot || DEFAULT_QQ_BOT_CONFIG;
  return {
    enabled: qqBot.enabled,
    appId: qqBot.appId,
    clientSecretSet: Boolean(qqBot.clientSecret || qqBot.clientSecretEncrypted),
    targetOpenid: qqBot.targetOpenid,
    notifyStatuses: [...qqBot.notifyStatuses],
    queueWhenUnavailable: qqBot.queueWhenUnavailable
  };
}

function createConfigStore({ configFile, safeStorage }) {
  let config = {
    autoRestore: true,
    debugMode: false,
    lastActiveSessionIds: [],
    themeId: DEFAULT_THEME_ID,
    qqBot: { ...DEFAULT_QQ_BOT_CONFIG }
  };

  function canEncryptSecrets() {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  }

  function encryptSecret(secret) {
    if (!secret) return "";
    if (!canEncryptSecrets()) {
      throw new Error("Electron safeStorage is not available; QQ bot client secret was not saved.");
    }
    return safeStorage.encryptString(secret).toString("base64");
  }

  function decryptSecret(encryptedSecret) {
    if (!encryptedSecret || !canEncryptSecrets()) return "";
    try {
      return safeStorage.decryptString(Buffer.from(encryptedSecret, "base64"));
    } catch (err) {
      console.error("Failed to decrypt QQ bot client secret:", err);
      return "";
    }
  }

  function serializeConfig() {
    return {
      autoRestore: config.autoRestore,
      debugMode: config.debugMode,
      lastActiveSessionIds: config.lastActiveSessionIds,
      themeId: config.themeId,
      qqBot: {
        enabled: config.qqBot.enabled,
        appId: config.qqBot.appId,
        clientSecretEncrypted: config.qqBot.clientSecretEncrypted,
        targetOpenid: config.qqBot.targetOpenid,
        notifyStatuses: config.qqBot.notifyStatuses,
        queueWhenUnavailable: config.qqBot.queueWhenUnavailable
      }
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
          qqBot: normalizeQqBotConfig(parsed.qqBot, decryptSecret)
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
      qqBot: getPublicQqBotConfig(config)
    };
  }

  function getQqBotConfig() {
    return {
      ...config.qqBot,
      notifyStatuses: [...config.qqBot.notifyStatuses]
    };
  }

  function getPublicQqBotConfigForRenderer() {
    return getPublicQqBotConfig(config);
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
    }
    saveConfig();
  }

  function updateQqBotConfig(partial) {
    try {
      if (partial && typeof partial === "object") {
        if (typeof partial.enabled === "boolean") {
          config.qqBot.enabled = partial.enabled;
        }
        if (typeof partial.appId === "string") {
          config.qqBot.appId = partial.appId.trim();
        }
        if (typeof partial.targetOpenid === "string") {
          config.qqBot.targetOpenid = partial.targetOpenid.trim();
        }
        if (Array.isArray(partial.notifyStatuses)) {
          const notifyStatuses = partial.notifyStatuses.filter(status => QQ_BOT_NOTIFY_STATUSES.has(status));
          config.qqBot.notifyStatuses = notifyStatuses.length > 0 ? notifyStatuses : [...DEFAULT_QQ_BOT_CONFIG.notifyStatuses];
        }
        if (typeof partial.queueWhenUnavailable === "boolean") {
          config.qqBot.queueWhenUnavailable = partial.queueWhenUnavailable;
        }
        if (typeof partial.clientSecret === "string") {
          const clientSecret = partial.clientSecret.trim();
          if (clientSecret) {
            const clientSecretEncrypted = encryptSecret(clientSecret);
            config.qqBot.clientSecret = clientSecret;
            config.qqBot.clientSecretEncrypted = clientSecretEncrypted;
          }
        }
        if (partial.clearClientSecret === true) {
          config.qqBot.clientSecret = "";
          config.qqBot.clientSecretEncrypted = "";
        }
      }
      saveConfig();
      return { ok: true, config: getPublicQqBotConfigForRenderer() };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        config: getPublicQqBotConfigForRenderer()
      };
    }
  }

  return {
    loadConfig,
    saveConfig,
    getConfig,
    getQqBotConfig,
    getPublicQqBotConfig: getPublicQqBotConfigForRenderer,
    updateConfig,
    updateQqBotConfig
  };
}

module.exports = {
  DEFAULT_THEME_ID,
  DEFAULT_QQ_BOT_CONFIG,
  QQ_BOT_NOTIFY_STATUSES,
  VALID_THEME_IDS,
  createConfigStore,
  normalizeThemeId
};
