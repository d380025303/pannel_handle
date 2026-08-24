const fs = require("node:fs");

function createOpenRouterConfigStore({ configFile, safeStorage, logger = console }) {
  let encryptedApiKey = "";

  function encrypt(value) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法保存 OpenRouter API Key。");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  function decrypt(value) {
    if (!value) return "";
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法读取 OpenRouter API Key。");
    }
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }

  function save() {
    const tmpPath = `${configFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ encryptedApiKey }, null, 2), "utf-8");
    fs.renameSync(tmpPath, configFile);
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      encryptedApiKey = typeof parsed?.encryptedApiKey === "string" ? parsed.encryptedApiKey : "";
    } catch (err) {
      if (err.code !== "ENOENT") logger.error("Failed to load OpenRouter config:", err);
    }
  }

  function getConfig() {
    return { hasApiKey: Boolean(encryptedApiKey) };
  }

  function getApiKey() {
    try {
      return decrypt(encryptedApiKey);
    } catch (err) {
      logger.error("Failed to decrypt OpenRouter API Key:", err);
      throw new Error("无法解密 OpenRouter API Key，请清除后重新配置。");
    }
  }

  function setApiKey(apiKey) {
    const value = String(apiKey || "").trim();
    if (!value) throw new Error("OpenRouter API Key 不能为空。");
    encryptedApiKey = encrypt(value);
    save();
    return getConfig();
  }

  function clear() {
    encryptedApiKey = "";
    save();
    return getConfig();
  }

  return { load, getConfig, getApiKey, setApiKey, clear };
}

module.exports = { createOpenRouterConfigStore };
