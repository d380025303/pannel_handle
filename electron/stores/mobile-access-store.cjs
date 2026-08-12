const crypto = require("node:crypto");
const fs = require("node:fs");

const DEFAULT_PORT = 43123;
const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_MAX_ENTRIES = 1000;

function createMobileAccessStore({ accessFile, safeStorage, now = () => Date.now() }) {
  let state = {
    config: { enabled: false, interfaceName: "", port: DEFAULT_PORT },
    devices: [],
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
      devices: state.devices,
      audit: state.audit
    };
  }

  function save() {
    const tmpPath = `${accessFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(serialize(), null, 2), "utf8");
    fs.renameSync(tmpPath, accessFile);
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(accessFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const port = Number(parsed.config?.port);
      state = {
        config: {
          enabled: parsed.config?.enabled === true,
          interfaceName: typeof parsed.config?.interfaceName === "string" ? parsed.config.interfaceName : "",
          port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
        },
        devices: Array.isArray(parsed.devices)
          ? parsed.devices.filter((device) => device && typeof device.id === "string" && typeof device.encryptedToken === "string")
          : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit.filter((entry) => entry && typeof entry.type === "string") : []
      };
      pruneAudit();
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Failed to load mobile access state:", error);
    }
  }

  function getConfig() {
    return { ...state.config };
  }

  function updateConfig(partial = {}) {
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

  function encryptToken(token) {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error("Windows 安全存储不可用，无法保存移动设备令牌。");
    }
    return safeStorage.encryptString(token).toString("base64");
  }

  function decryptToken(encryptedToken) {
    try {
      return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
    } catch {
      return "";
    }
  }

  function listDevices() {
    return state.devices.map(({ encryptedToken: _encryptedToken, ...device }) => ({ ...device }));
  }

  function addDevice(name) {
    const token = crypto.randomBytes(32).toString("base64url");
    const device = {
      id: crypto.randomUUID(),
      name: String(name || "Android Chrome").trim().slice(0, 80) || "Android Chrome",
      encryptedToken: encryptToken(token),
      createdAt: now(),
      lastSeenAt: now()
    };
    state.devices.push(device);
    addAudit("pair.approved", { deviceId: device.id, deviceName: device.name });
    save();
    return { device: listDevices().find((item) => item.id === device.id), token };
  }

  function verifyDevice(deviceId, token) {
    const device = state.devices.find((item) => item.id === deviceId);
    if (!device || typeof token !== "string") return null;
    const expected = Buffer.from(decryptToken(device.encryptedToken), "utf8");
    const actual = Buffer.from(token, "utf8");
    if (expected.length === 0 || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    device.lastSeenAt = now();
    save();
    const { encryptedToken: _encryptedToken, ...safeDevice } = device;
    return safeDevice;
  }

  function revokeDevice(deviceId) {
    const device = state.devices.find((item) => item.id === deviceId);
    if (!device) return false;
    state.devices = state.devices.filter((item) => item.id !== deviceId);
    addAudit("device.revoked", { deviceId: device.id, deviceName: device.name });
    save();
    return true;
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
    listDevices,
    addDevice,
    verifyDevice,
    revokeDevice,
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
