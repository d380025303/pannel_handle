const fs = require("node:fs");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createCompletionConfigStore({ configFile, safeStorage, logger = console }) {
  const THINKING_LEVELS = new Set(["high", "max"]);

  let config = {
    enabled: false,
    baseUrl: DEFAULT_BASE_URL,
    model: "",
    encryptedApiKey: "",
    thinkingEnabled: false,
    thinkingLevel: "high"
  };

  function encrypt(value) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法保存智能补全 API Key。");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  function decrypt(value) {
    if (!value) return "";
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法读取智能补全 API Key。");
    }
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }

  function serializeConfig() {
    return { ...config };
  }

  function saveConfig() {
    const tmpPath = `${configFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(serializeConfig(), null, 2), "utf-8");
    fs.renameSync(tmpPath, configFile);
  }

  function loadConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = {
          enabled: parsed.enabled === true,
          baseUrl: normalizeText(parsed.baseUrl) || DEFAULT_BASE_URL,
          model: normalizeText(parsed.model),
          encryptedApiKey: typeof parsed.encryptedApiKey === "string" ? parsed.encryptedApiKey : "",
          thinkingEnabled: parsed.thinkingEnabled === true,
          thinkingLevel: THINKING_LEVELS.has(parsed.thinkingLevel) ? parsed.thinkingLevel : "high"
        };
      }
    } catch (err) {
      if (err.code !== "ENOENT") logger.error("Failed to load completion config:", err);
    }
  }

  function getConfig() {
    return {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      hasApiKey: Boolean(config.encryptedApiKey),
      thinkingEnabled: config.thinkingEnabled,
      thinkingLevel: config.thinkingLevel
    };
  }

  function getCredentials() {
    return { apiKey: decrypt(config.encryptedApiKey) };
  }

  function updateConfig(input = {}) {
    const next = { ...config };
    if (typeof input.enabled === "boolean") next.enabled = input.enabled;
    if (typeof input.baseUrl === "string") {
      const baseUrl = normalizeText(input.baseUrl);
      if (!baseUrl) throw new Error("请输入智能补全 Base URL。");
      next.baseUrl = baseUrl;
    }
    if (typeof input.model === "string") next.model = normalizeText(input.model);
    if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      next.encryptedApiKey = encrypt(input.apiKey.trim());
    }
    if (typeof input.thinkingEnabled === "boolean") next.thinkingEnabled = input.thinkingEnabled;
    if (THINKING_LEVELS.has(input.thinkingLevel)) next.thinkingLevel = input.thinkingLevel;
    config = next;
    saveConfig();
    return getConfig();
  }

  function clearCredentials() {
    config = { ...config, enabled: false, encryptedApiKey: "" };
    saveConfig();
    return getConfig();
  }

  return { loadConfig, getConfig, getCredentials, updateConfig, clearCredentials };
}

module.exports = { DEFAULT_BASE_URL, createCompletionConfigStore };
