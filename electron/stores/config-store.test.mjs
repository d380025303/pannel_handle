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
  it("defaults Qoder check-in off in old configs and persists opt-in", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ autoRestore: true }));
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig().autoQoderCheckin).toBe(false);
    store.updateConfig({ autoQoderCheckin: true });
    const reloaded = createConfigStore({ configFile });
    reloaded.loadConfig();
    expect(reloaded.getConfig().autoQoderCheckin).toBe(true);
  });
  it("normalizes, persists, and reloads title bar icon preferences", () => {
    const configFile = createTempConfigPath();
    const store = createConfigStore({ configFile });
    store.updateConfig({ titleBarActionOrder: ["create", "create", "overview", "unknown", "terminal"], titleBarHiddenActions: ["stats", "stats", "settings", "overview", "unknown"] });
    expect(store.getConfig().titleBarActionOrder.slice(0, 3)).toEqual(["create", "terminal", "stats"]);
    expect(store.getConfig().titleBarHiddenActions).toEqual(["stats"]);
    const reloaded = createConfigStore({ configFile });
    reloaded.loadConfig();
    expect(reloaded.getConfig().titleBarActionOrder).toEqual(store.getConfig().titleBarActionOrder);
    expect(reloaded.getConfig().titleBarHiddenActions).toEqual(["stats"]);
  });

  it("filters the removed assistant from old icon preferences", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({
      titleBarActionOrder: ["create", "assistant", "settings", "terminal"],
      titleBarHiddenActions: ["assistant", "stats"]
    }));
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig().titleBarActionOrder.slice(0, 3)).toEqual(["create", "settings", "terminal"]);
    expect(store.getConfig().titleBarActionOrder).not.toContain("assistant");
    expect(store.getConfig().titleBarHiddenActions).toEqual(["stats"]);
    store.updateConfig({ titleBarActionOrder: store.getConfig().titleBarActionOrder });
    const reloaded = createConfigStore({ configFile });
    reloaded.loadConfig();
    expect(reloaded.getConfig().titleBarActionOrder).toEqual(store.getConfig().titleBarActionOrder);
    expect(reloaded.getConfig().titleBarHiddenActions).toEqual(["stats"]);
  });

  it("keeps the old settings position and persists a custom one", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ titleBarActionOrder: ["create", "terminal", "stats", "skills", "mcp", "idea", "screenshot", "library", "quickAgent"] }));
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig().titleBarActionOrder).toEqual(["create", "terminal", "stats", "skills", "mcp", "idea", "settings", "screenshot", "library", "quickAgent"]);
    store.updateConfig({ titleBarActionOrder: ["settings", ...store.getConfig().titleBarActionOrder.filter(id => id !== "settings")] });
    const reloaded = createConfigStore({ configFile });
    reloaded.loadConfig();
    expect(reloaded.getConfig().titleBarActionOrder[0]).toBe("settings");
  });

  it("rolls back title bar preferences when saving fails", () => {
    const store = createConfigStore({ configFile: createTempConfigPath(), dataStore: { write: () => { throw new Error("disk unavailable"); } } });
    const before = store.getConfig();
    expect(() => store.updateConfig({ titleBarHiddenActions: ["terminal"] }, { throwOnSaveError: true })).toThrow("disk unavailable");
    expect(store.getConfig()).toEqual(before);
  });
  it("reads the old Codex App Server switch only for template migration", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({ codexAppServerEnabled: false }));
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getLegacyCodexAppServerEnabled()).toBe(false);
    expect(store.getConfig()).not.toHaveProperty("codexAppServerEnabled");
    store.updateConfig({ autoRestore: false });
    expect(JSON.parse(fs.readFileSync(configFile, "utf-8"))).not.toHaveProperty("codexAppServerEnabled");
  });
  it("defaults debugMode to false when config file is missing", () => {
    const store = createConfigStore({ configFile: createTempConfigPath() });

    store.loadConfig();

    expect(store.getConfig()).toEqual({
      defaultWindowsShell: "cmd",
      autoRestore: true,
      autoWorkBuddyCheckin: true,
      autoQoderCheckin: false,
      autoCollapseFileChains: true,
      debugMode: false,
      graphicalSessionMinimalMode: false,
      screenshotEnabled: true,
      screenshotShortcut: "Ctrl+Shift+X",
      titleBarActionOrder: ["terminal", "stats", "skills", "mcp", "idea", "screenshot", "settings", "library", "quickAgent", "create"],
      titleBarHiddenActions: [],
      lastActiveSessionIds: [],
      themeId: "dark-slate",
      locale: "zh-CN",
      sidebarWidth: 290,
      rightToolsWidth: 380,
      terminalBackgroundImage: "",
      terminalBackgroundOpacity: 40,
      terminalBackgroundBlur: 0,
      terminalBackgroundPositionX: 50,
      terminalBackgroundPositionY: 50
    });
  });

  it("loads, normalizes, and persists terminal background settings", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({
      terminalBackgroundImage: "123-bg.png",
      terminalBackgroundOpacity: 65,
      terminalBackgroundBlur: 12
    }), "utf-8");
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig()).toMatchObject({
      terminalBackgroundImage: "123-bg.png",
      terminalBackgroundOpacity: 65,
      terminalBackgroundBlur: 12,
      terminalBackgroundPositionX: 50,
      terminalBackgroundPositionY: 50
    });

    store.updateConfig({ terminalBackgroundImage: "", terminalBackgroundOpacity: 0, terminalBackgroundBlur: 40, terminalBackgroundPositionX: 20, terminalBackgroundPositionY: 80 });
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(saved.terminalBackgroundImage).toBe("");
    expect(saved.terminalBackgroundOpacity).toBe(0);
    expect(saved.terminalBackgroundBlur).toBe(40);
    expect(saved.terminalBackgroundPositionX).toBe(20);
    expect(saved.terminalBackgroundPositionY).toBe(80);
  });

  it("normalizes invalid terminal background values on load and update", () => {
    const configFile = createTempConfigPath();
    fs.writeFileSync(configFile, JSON.stringify({
      terminalBackgroundImage: "../evil.png",
      terminalBackgroundOpacity: 250,
      terminalBackgroundBlur: -5,
      terminalBackgroundPositionX: -12,
      terminalBackgroundPositionY: 123
    }), "utf-8");
    const store = createConfigStore({ configFile });
    store.loadConfig();
    expect(store.getConfig()).toMatchObject({
      terminalBackgroundImage: "",
      terminalBackgroundOpacity: 100,
      terminalBackgroundBlur: 0,
      terminalBackgroundPositionX: 0,
      terminalBackgroundPositionY: 100
    });

    store.updateConfig({ terminalBackgroundImage: "a/b.png" });
    expect(store.getConfig().terminalBackgroundImage).toBe("");
    store.updateConfig({ terminalBackgroundImage: "ok.webp" });
    expect(store.getConfig().terminalBackgroundImage).toBe("ok.webp");
  });

  it("rolls back background position when saving fails", () => {
    const store = createConfigStore({
      configFile: createTempConfigPath(),
      dataStore: { write: () => { throw new Error("disk unavailable"); } }
    });
    expect(() => store.updateConfig({ terminalBackgroundPositionX: 20 }, { throwOnSaveError: true }))
      .toThrow("disk unavailable");
    expect(store.getConfig().terminalBackgroundPositionX).toBe(50);
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
      graphicalSessionMinimalMode: false,
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
      autoQoderCheckin: false,
      autoCollapseFileChains: true,
      debugMode: true,
      graphicalSessionMinimalMode: false,
      screenshotEnabled: true,
      screenshotShortcut: "Ctrl+Shift+X",
      titleBarActionOrder: ["terminal", "stats", "skills", "mcp", "idea", "screenshot", "settings", "library", "quickAgent", "create"],
      titleBarHiddenActions: [],
      lastActiveSessionIds: [],
      themeId: "light",
      locale: "zh-CN",
      sidebarWidth: 290,
      rightToolsWidth: 380,
      terminalBackgroundImage: "",
      terminalBackgroundOpacity: 40,
      terminalBackgroundBlur: 0,
      terminalBackgroundPositionX: 50,
      terminalBackgroundPositionY: 50
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

 it("defaults minimal mode off for legacy config and persists only booleans", () => {
   const configFile = createTempConfigPath();
   fs.writeFileSync(configFile, JSON.stringify({ debugMode: true }));
   const store = createConfigStore({ configFile });
   store.loadConfig();
   expect(store.getConfig().graphicalSessionMinimalMode).toBe(false);
   store.updateConfig({ graphicalSessionMinimalMode: true });
   store.updateConfig({ graphicalSessionMinimalMode: "false" });
   const reloaded = createConfigStore({ configFile });
   reloaded.loadConfig();
   expect(reloaded.getConfig().graphicalSessionMinimalMode).toBe(true);
   reloaded.updateConfig({ graphicalSessionMinimalMode: false });
   store.loadConfig();
   expect(store.getConfig().graphicalSessionMinimalMode).toBe(false);
 });
