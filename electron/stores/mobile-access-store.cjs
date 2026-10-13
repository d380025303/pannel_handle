const crypto = require("node:crypto");
const { readJson, writeJson } = require("./business-store-io.cjs");

const DEFAULT_PORT = 43123;
const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_MAX_ENTRIES = 1000;

function createMobileAccessStore({ accessFile, dataStore, now = () => Date.now() }) {
  let state = {
    config: { enabled: false, interfaceName: "", port: DEFAULT_PORT },
    password: null,
    audit: []
  };

  function pruneAudit() {
    const cutoff = now() - AUDIT_MAX_AGE_MS;
    state.audit = state.audit.filter((entry) => Number(entry.at) >= cutoff).slice(-AUDIT_MAX_ENTRIES);
  }

  function serialize() {
    pruneAudit();
    return {
      schemaVersion: 1,
      config: state.config,
      password: state.password,
      audit: state.audit
    };
  }

  function save() {
    writeJson(dataStore, accessFile, serialize());
  }

  function load() {
    try {
      const parsed = readJson(dataStore, accessFile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const port = Number(parsed.config?.port);
      const password = parsed.password && typeof parsed.password.salt === "string" && typeof parsed.password.hash === "string"
        && Buffer.from(parsed.password.salt, "base64").length === 16
        && Buffer.from(parsed.password.hash, "base64").length === 64
        ? parsed.password : null;
      state = {
        config: {
          enabled: parsed.config?.enabled === true && Boolean(password),
          interfaceName: typeof parsed.config?.interfaceName === "string" ? parsed.config.interfaceName : "",
          port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
        },
        password,
        audit: Array.isArray(parsed.audit) ? parsed.audit.filter((entry) => entry && typeof entry.type === "string") : []
      };
      pruneAudit();
      if (Array.isArray(parsed.devices) || (!password && parsed.config?.enabled === true)) save();
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Failed to load mobile access state:", error);
    }
  }

  function getConfig() {
    return { ...state.config, hasPassword: Boolean(state.password) };
  }

  function updateConfig(partial = {}) {
    if (partial.enabled === true && !state.password) throw new Error("请先设置移动访问密码。");
    if (typeof partial.enabled === "boolean") state.config.enabled = partial.enabled;
    if (typeof partial.interfaceName === "string") state.config.interfaceName = partial.interfaceName.trim();
    if (typeof partial.port !== "undefined") {
      const port = Number(partial.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("移动访问端口必须在 1024 到 65535 之间。");
      }
      state.config.port = port;
    }
    save();
    return getConfig();
  }

  function setPassword(value) {
    if (typeof value !== "string" || value.length < 8 || value.length > 128 || value.trim() !== value) {
      throw new Error("移动访问密码需为 8 到 128 个字符，且首尾不能有空格。");
    }
    const salt = crypto.randomBytes(16).toString("base64");
    const hash = crypto.scryptSync(value, Buffer.from(salt, "base64"), 64).toString("base64");
    const previous = { password: state.password, audit: state.audit.slice() };
    state.password = { salt, hash };
    addAudit("password.changed");
    try {
      save();
    } catch (error) {
      state.password = previous.password;
      state.audit = previous.audit;
      throw error;
    }
    return getConfig();
  }

  async function verifyPassword(value) {
    const password = state.password;
    if (!password || typeof value !== "string" || value.length > 128) return false;
    const expected = Buffer.from(password.hash, "base64");
    const actual = await new Promise((resolve, reject) => {
      crypto.scrypt(value, Buffer.from(password.salt, "base64"), expected.length, (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      });
    });
    return state.password === password && expected.length > 0 && crypto.timingSafeEqual(expected, actual);
  }

  function addAudit(type, details = {}) {
    state.audit.push({ id: crypto.randomUUID(), at: now(), type, ...details });
    pruneAudit();
  }

  function recordAudit(type, details = {}) {
    addAudit(type, details);
    save();
  }

  function listAudit() {
    pruneAudit();
    return state.audit.map((entry) => ({ ...entry })).reverse();
  }

  return {
    load,
    save,
    getConfig,
    updateConfig,
    setPassword,
    verifyPassword,
    recordAudit,
    listAudit
  };
}

module.exports = {
  DEFAULT_PORT,
  AUDIT_MAX_AGE_MS,
  AUDIT_MAX_ENTRIES,
  createMobileAccessStore
};
