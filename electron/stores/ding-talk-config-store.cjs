const { readJson, writeJson } = require("./business-store-io.cjs");

function createDingTalkConfigStore({ configFile, safeStorage, dataStore, logger = console }) {
  let config = {
    enabled: false,
    encryptedWebhook: "",
    encryptedSecret: ""
  };

  function encrypt(value) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法保存钉钉机器人凭据。");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  function decrypt(value) {
    if (!value) return "";
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法读取钉钉机器人凭据。");
    }
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }

  function commit(next) {
    writeJson(dataStore, configFile, next);
    config = next;
    return getConfig();
  }

  function loadConfig() {
    try {
      const parsed = readJson(dataStore, configFile);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = {
          enabled: parsed.enabled === true,
          encryptedWebhook: typeof parsed.encryptedWebhook === "string" ? parsed.encryptedWebhook : "",
          encryptedSecret: typeof parsed.encryptedSecret === "string" ? parsed.encryptedSecret : ""
        };
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.error("Failed to load DingTalk config:", err);
      }
    }
  }

  function getConfig() {
    return {
      enabled: config.enabled,
      hasWebhook: Boolean(config.encryptedWebhook),
      hasSecret: Boolean(config.encryptedSecret)
    };
  }

  function getCredentials() {
    return {
      webhook: decrypt(config.encryptedWebhook),
      secret: decrypt(config.encryptedSecret)
    };
  }

  function updateConfig(input) {
    const next = { ...config };
    if (typeof input.enabled === "boolean") {
      next.enabled = input.enabled;
    }
    if (typeof input.webhook === "string") {
      next.encryptedWebhook = encrypt(input.webhook);
    }
    if (typeof input.secret === "string") {
      next.encryptedSecret = input.secret ? encrypt(input.secret) : "";
    }
    return commit(next);
  }

  function clearCredentials() {
    return commit({
      enabled: false,
      encryptedWebhook: "",
      encryptedSecret: ""
    });
  }

  return {
    loadConfig,
    getConfig,
    getCredentials,
    updateConfig,
    clearCredentials
  };
}

module.exports = {
  createDingTalkConfigStore
};
