import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { DEFAULT_BOUNDS, constrainBounds, createAgentConversationOverlayManager } = require("./agent-conversation-overlay-manager.cjs");

class MockBrowserWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.visible = false;
    this.destroyed = false;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.webContents = new EventEmitter();
    this.webContents.send = vi.fn();
    this.showInactive = vi.fn(() => { this.visible = true; });
    this.hide = vi.fn(() => { this.visible = false; });
    this.setAlwaysOnTop = vi.fn();
    this.loadURL = vi.fn();
    this.loadFile = vi.fn();
    this.getBounds = vi.fn(() => this.bounds);
    this.destroy = vi.fn(() => { this.destroyed = true; this.emit("closed"); });
    MockBrowserWindow.instances.push(this);
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
}

function createHarness(enabled = true) {
  MockBrowserWindow.instances = [];
  let config = {
    agentConversationOverlayEnabled: enabled,
    themeId: "dark-slate",
    locale: "zh-CN"
  };
  const configStore = {
    getConfig: vi.fn(() => ({ ...config })),
    updateConfig: vi.fn(partial => { config = { ...config, ...partial }; })
  };
  const windowManager = { focusAndSelectSession: vi.fn(), focusWindow: vi.fn() };
  const manager = createAgentConversationOverlayManager({
    BrowserWindow: MockBrowserWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    configStore,
    windowManager,
    isPackaged: false,
    preloadPath: "C:\\app\\overlay-preload.cjs",
    indexPath: "C:\\app\\index.html",
    setTimeoutFn: vi.fn(),
    clearTimeoutFn: vi.fn()
  });
  return { manager, configStore, windowManager };
}

describe("Agent conversation overlay manager", () => {
  it("uses a narrow, tall default that remains inside the display work area", () => {
    expect(DEFAULT_BOUNDS).toEqual({ width: 320, height: 720 });
    const screen = { getPrimaryDisplay: () => ({ workArea: { x: 100, y: 50, width: 800, height: 600 } }) };
    expect(constrainBounds(screen)).toEqual({
      x: 556, y: 50, width: 320, height: 600
    });
  });

  it("constrains restored geometry to the display work area", () => {
    const screen = { getDisplayMatching: () => ({ workArea: { x: 100, y: 50, width: 800, height: 600 } }) };
    expect(constrainBounds(screen, { x: -500, y: 900, width: 500, height: 300 })).toEqual({
      x: 100, y: 350, width: 500, height: 300
    });
  });

  it("creates a secure always-on-top window only after the active turn has a reply", () => {
    const { manager } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Main", provider: "codex", supported: true });
    expect(MockBrowserWindow.instances).toHaveLength(0);

    manager.appendMessages("panel-1", [{ id: "one", provider: "codex", kind: "commentary", text: "正在检查", timestamp: 1 }]);
    const win = MockBrowserWindow.instances[0];
    win.webContents.emit("did-finish-load");
    expect(win.options).toMatchObject({
      alwaysOnTop: true,
      skipTaskbar: true,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000"
    });
    expect(win.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false });
    expect(win.showInactive).toHaveBeenCalled();
  });

  it("suppresses the current turn after close and reopens on the next turn", () => {
    const { manager } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Main", provider: "codex", supported: true });
    manager.appendMessages("panel-1", [{ id: "one", provider: "codex", kind: "commentary", text: "one", timestamp: 1 }]);
    const win = MockBrowserWindow.instances[0];
    win.webContents.emit("did-finish-load");
    const event = { preventDefault: vi.fn() };
    win.emit("close", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();

    win.showInactive.mockClear();
    manager.appendMessages("panel-1", [{ id: "two", provider: "codex", kind: "commentary", text: "two", timestamp: 2 }]);
    expect(win.showInactive).not.toHaveBeenCalled();

    manager.startTurn({ sessionId: "panel-1", sessionTitle: "Main", provider: "codex", supported: true });
    manager.appendMessages("panel-1", [{ id: "three", provider: "codex", kind: "final", text: "three", timestamp: 3 }]);
    expect(win.showInactive).toHaveBeenCalled();
  });

  it("follows the selected session and exposes unsupported remote turns", () => {
    const { manager, windowManager } = createHarness();
    manager.setActiveSession("panel-1");
    manager.startTurn({ sessionId: "panel-2", sessionTitle: "Remote", provider: "codebuddy", supported: false });
    expect(MockBrowserWindow.instances).toHaveLength(0);
    manager.setActiveSession("panel-2");
    MockBrowserWindow.instances[0].webContents.emit("did-finish-load");
    expect(MockBrowserWindow.instances[0].showInactive).toHaveBeenCalled();
    expect(manager.getSnapshot().turn).toMatchObject({ status: "unsupported", supported: false });
    manager.focusActiveSession();
    expect(windowManager.focusAndSelectSession).toHaveBeenCalledWith("panel-2");
  });
});
