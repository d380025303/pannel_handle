import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createConfigStore } = require("./config-store.cjs");

const tempDirs = [];

function createTempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-config-"));
  tempDirs.push(dir);
  return path.join(dir, "config.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config-store", () => {
  it("defaults debugMode to false when config file is missing", () => {
    const store = createConfigStore({ configFile: createTempConfigPath() });

    store.loadConfig();

    expect(store.getConfig()).toEqual({
      autoRestore: true,
      debugMode: false,
      lastActiveSessionIds: [],
      themeId: "dark-slate",
      qqBot: {
        enabled: false,
        appId: "",
        clientSecretSet: false,
        targetOpenid: "",
        notifyStatuses: ["waiting_for_permission", "completed", "failed", "ended"],
        queueWhenUnavailable: true
      }
    });
  });

  it("loads and persists debugMode and themeId", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ autoRestore: false, debugMode: true, themeId: "light" }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().debugMode).toBe(true);
    expect(store.getConfig().themeId).toBe("light");

    store.updateConfig({ debugMode: false, themeId: "dark-blue" });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.debugMode).toBe(false);
    expect(saved.themeId).toBe("dark-blue");
  });

  it("falls back to the default themeId when an invalid value is loaded or saved", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ themeId: "unknown" }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().themeId).toBe("dark-slate");

    store.updateConfig({ themeId: "neon" });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.themeId).toBe("dark-slate");
  });

  it("stores QQ bot client secrets encrypted and exposes only a set flag", () => {
    const configFile = createTempConfigPath();
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (buffer) => buffer.toString("utf-8").replace(/^encrypted:/, "")
    };
    const store = createConfigStore({ configFile, safeStorage });

    const result = store.updateQqBotConfig({
      enabled: true,
      appId: "123",
      clientSecret: "secret",
      targetOpenid: "openid"
    });

    expect(result.ok).toBe(true);
    expect(store.getConfig().qqBot).toEqual(expect.objectContaining({
      enabled: true,
      appId: "123",
      clientSecretSet: true,
      targetOpenid: "openid"
    }));
    expect(store.getQqBotConfig().clientSecret).toBe("secret");

    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.qqBot.clientSecret).toBeUndefined();
    expect(saved.qqBot.clientSecretEncrypted).toBe(Buffer.from("encrypted:secret").toString("base64"));
  });

  it("rejects QQ bot secret updates when safeStorage is unavailable", () => {
    const store = createConfigStore({
      configFile: createTempConfigPath(),
      safeStorage: { isEncryptionAvailable: () => false }
    });

    const result = store.updateQqBotConfig({ clientSecret: "secret" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/safeStorage/);
    expect(store.getConfig().qqBot.clientSecretSet).toBe(false);
  });
});
