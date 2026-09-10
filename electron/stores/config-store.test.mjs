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
      defaultWindowsShell: "cmd",
      autoRestore: true,
      autoWorkBuddyCheckin: true,
      autoCollapseFileChains: true,
      debugMode: false,
      screenshotEnabled: true,
      screenshotShortcut: "Ctrl+Shift+X",
      lastActiveSessionIds: [],
      themeId: "dark-slate",
      locale: "zh-CN",
      sidebarWidth: 290,
      rightToolsWidth: 380
    });
  });

  it("loads, normalizes, and persists screenshot preferences", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ screenshotEnabled: false, screenshotShortcut: "shift+alt+7" }), "utf-8");
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig()).toMatchObject({ screenshotEnabled: false, screenshotShortcut: "Alt+Shift+7" });

    store.updateConfig({ screenshotEnabled: true, screenshotShortcut: "ctrl+f12" });
    expect(store.getConfig()).toMatchObject({ screenshotEnabled: true, screenshotShortcut: "Ctrl+F12" });
    store.updateConfig({ screenshotShortcut: "Ctrl+Shift+F" });
    expect(store.getConfig().screenshotShortcut).toBe("Ctrl+F12");
  });

  it("uses the screenshot defaults when saved values are invalid or missing", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ screenshotShortcut: "X" }), "utf-8");
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig()).toMatchObject({ screenshotEnabled: true, screenshotShortcut: "Ctrl+Shift+X" });
  });

  it("loads and persists automatic check-in, file chain collapsing, debugMode, themeId, and locale", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ autoRestore: false, autoWorkBuddyCheckin: false, autoCollapseFileChains: false, debugMode: true, themeId: "light", locale: "en-US" }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig().autoWorkBuddyCheckin).toBe(false);
    expect(store.getConfig().autoCollapseFileChains).toBe(false);
    expect(store.getConfig().debugMode).toBe(true);
    expect(store.getConfig().themeId).toBe("light");
    expect(store.getConfig().locale).toBe("en-US");

    store.updateConfig({ autoWorkBuddyCheckin: true, autoCollapseFileChains: true, debugMode: false, themeId: "dark-blue", locale: "zh-CN" });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.autoWorkBuddyCheckin).toBe(true);
    expect(saved.autoCollapseFileChains).toBe(true);
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

  it("ignores retired overlay settings and drops them on the next save", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({
      agentConversationOverlayEnabled: false,
      agentConversationOverlayLayoutVersion: 2,
      agentConversationOverlayBounds: { x: 260, y: 140, width: 360, height: 760 }
    }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();
    expect(store.getConfig()).not.toHaveProperty("agentConversationOverlayEnabled");
    expect(store.getConfig()).not.toHaveProperty("agentConversationOverlayBounds");

    store.updateConfig({ debugMode: true });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));

    expect(saved).not.toHaveProperty("agentConversationOverlayEnabled");
    expect(saved).not.toHaveProperty("agentConversationOverlayLayoutVersion");
    expect(saved).not.toHaveProperty("agentConversationOverlayBounds");
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

  it("ignores stale config fields when loading older config files", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({
      autoRestore: false,
      debugMode: true,
      screenshotEnabled: true,
      screenshotShortcut: "Ctrl+Shift+X",
      themeId: "light",
      listenerAgentHistoryMaxEntries: 250,
      listenerAgentOutputMaxBytes: 4 * 1024 * 1024,
      qqBot: {
        enabled: true,
        appId: "123",
        clientSecretEncrypted: "secret"
      }
    }), "utf-8");
    const store = createConfigStore({ configFile });

    store.loadConfig();

    expect(store.getConfig()).toEqual({
      defaultWindowsShell: "cmd",
      autoRestore: false,
      autoWorkBuddyCheckin: true,
      autoCollapseFileChains: true,
      debugMode: true,
      screenshotEnabled: true,
      screenshotShortcut: "Ctrl+Shift+X",
      lastActiveSessionIds: [],
      themeId: "light",
      locale: "zh-CN",
      sidebarWidth: 290,
      rightToolsWidth: 380
    });
  });
});


describe("sidebar width persistence", () => {
  it("restores saved width in a new store and preserves the right width", () => {
    const configFile = createTempConfigPath();
    const store = createConfigStore({ configFile });
    store.updateConfig({ sidebarWidth: 430, rightToolsWidth: 520 });
    const reopened = createConfigStore({ configFile });
    reopened.loadConfig();
    expect(reopened.getConfig()).toMatchObject({ sidebarWidth: 430, rightToolsWidth: 520 });
    reopened.updateConfig({ sidebarWidth: 501 });
    expect(reopened.getConfig().sidebarWidth).toBe(430);
  });

  it.each([null, "400", 179, 501])("defaults invalid saved width %s", (sidebarWidth) => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ sidebarWidth }));
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig().sidebarWidth).toBe(290);
  });
});


describe("default Windows shell", () => {
  it.each(["cmd", "powershell", "pwsh"])("persists %s across reloads", (defaultWindowsShell) => {
    const configFile = createTempConfigPath();
    const store = createConfigStore({ configFile });
    store.updateConfig({ defaultWindowsShell });
    store.updateConfig({ debugMode: true });
    const reopened = createConfigStore({ configFile });
    reopened.loadConfig();
    expect(reopened.getConfig()).toMatchObject({ defaultWindowsShell, debugMode: true });
  });

  it.each([undefined, null, "bash", 12])("defaults invalid or missing shell %s to CMD", (defaultWindowsShell) => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ defaultWindowsShell }));
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig().defaultWindowsShell).toBe("cmd");
    store.updateConfig({ defaultWindowsShell: "pwsh" });
    store.updateConfig({ defaultWindowsShell: "invalid" });
    expect(store.getConfig().defaultWindowsShell).toBe("cmd");
  });
});
