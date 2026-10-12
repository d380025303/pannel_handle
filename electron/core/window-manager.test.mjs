import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("./window-manager.cjs", import.meta.url), "utf8");

describe("window close listener handshake", () => {
  let manager, window, onMainWindowClosed;
  beforeEach(() => {
    class Window extends EventEmitter {
      constructor() {
        super();
        this.webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
      }
      isDestroyed() { return Boolean(this.destroyed); }
      maximize() {}
      show() {}
      loadURL() {}
      close() {
        const event = { preventDefault: vi.fn() };
        this.emit("close", event);
        if (!event.preventDefault.mock.calls.length && !this.destroyed) {
          this.destroyed = true;
          this.emit("closed");
        }
        return event;
      }
    }
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, __dirname: import.meta.dirname,
      require: id => id === "electron" ? { app: { isPackaged: false }, BrowserWindow: Window } : require(id)
    });
    onMainWindowClosed = vi.fn();
    manager = module.exports.createWindowManager({ onMainWindowClosed });
    window = manager.createWindow();
  });
  function ready(value = true, sender = window.webContents) {
    manager.setCloseListenerReady({ sender }, value);
  }
  function navigate(isInPlace = false, isMainFrame = true) {
    window.webContents.emit("did-start-navigation", {}, "http://localhost", isInPlace, isMainFrame);
  }

  it("delivers an early native close once after readiness, then allows cancellation and retry", () => {
    expect(window.close().preventDefault).toHaveBeenCalledOnce();
    window.close();
    expect(window.webContents.send).not.toHaveBeenCalled();
    ready();
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("window:close-requested", undefined);
    ready(false);
    ready();
    window.close();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    manager.resolveClose(false);
    window.close();
    expect(window.webContents.send).toHaveBeenCalledTimes(2);
    manager.resolveClose(true);
    expect(window.close().preventDefault).not.toHaveBeenCalled();
  });

  it("queues API close requests and ignores readiness from other windows", () => {
    manager.requestClose();
    ready(true, {});
    expect(window.webContents.send).not.toHaveBeenCalled();
    ready();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("replays an unresolved request after main-frame reload readiness", () => {
    ready();
    manager.requestClose();
    navigate();
    manager.requestClose();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    ready();
    expect(window.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("keeps readiness across subframe and same-document navigation", () => {
    ready();
    navigate(false, false);
    navigate(true);
    manager.requestClose();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("allows native close after renderer loss with a pending request: %s", pending => {
    ready();
    if (pending) window.close();
    window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(window.close().preventDefault).not.toHaveBeenCalled();
    }
    expect(window.webContents.send).toHaveBeenCalledTimes(pending ? 1 : 0);
    expect(manager.getMainWindow()).toBeNull();
    expect(onMainWindowClosed).toHaveBeenCalledOnce();
  });

  it("allows API close after renderer loss before the handshake", () => {
    window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    manager.requestClose();
    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(onMainWindowClosed).toHaveBeenCalledOnce();
  });

  it("restores confirmation after a recovered renderer completes the handshake", () => {
    ready();
    window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    navigate();
    ready();
    expect(window.close().preventDefault).toHaveBeenCalledOnce();
    manager.resolveClose(false);
    expect(manager.getMainWindow()).toBe(window);
    expect(window.close().preventDefault).toHaveBeenCalledOnce();
    manager.resolveClose(true);
    expect(onMainWindowClosed).toHaveBeenCalledOnce();
  });
});
