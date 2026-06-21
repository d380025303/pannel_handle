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
      locale: "zh-CN",
      rightToolsWidth: 380
    });
  });

  it("loads and persists debugMode, themeId, and locale", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ autoRestore: false, debugMode: true, themeId: "light", locale: "en-US" }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().debugMode).toBe(true);
    expect(store.getConfig().themeId).toBe("light");
    expect(store.getConfig().locale).toBe("en-US");

    store.updateConfig({ debugMode: false, themeId: "dark-blue", locale: "zh-CN" });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.debugMode).toBe(false);
    expect(saved.themeId).toBe("dark-blue");
    expect(saved.locale).toBe("zh-CN");
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

  it("falls back to the default locale when an invalid value is loaded or saved", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ locale: "fr-FR" }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().locale).toBe("zh-CN");

    store.updateConfig({ locale: "de-DE" });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.locale).toBe("zh-CN");
  });

  it("loads and persists rightToolsWidth", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ rightToolsWidth: 520 }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().rightToolsWidth).toBe(520);

    store.updateConfig({ rightToolsWidth: 320 });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.rightToolsWidth).toBe(320);
  });

  it("falls back to default rightToolsWidth when an out-of-range value is loaded", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ rightToolsWidth: 999 }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().rightToolsWidth).toBe(380);

    store.updateConfig({ rightToolsWidth: 100 });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.rightToolsWidth).toBe(380);
  });

  it("ignores stale QQ bot config fields when loading older config files", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({
      autoRestore: false,
      debugMode: true,
      themeId: "light",
      qqBot: {
        enabled: true,
        appId: "123",
        clientSecretEncrypted: "secret"
      }
    }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();

    expect(store.getConfig()).toEqual({
      autoRestore: false,
      debugMode: true,
      lastActiveSessionIds: [],
      themeId: "light",
      locale: "zh-CN",
      rightToolsWidth: 380
    });
  });
});
