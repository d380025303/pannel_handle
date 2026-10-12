import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("./window-manager.cjs", import.meta.url), "utf8");

describe("window close listener handshake", () => {
  let manager, window;
  beforeEach(() => {
    class Window extends EventEmitter {
      constructor() {
        super();
        this.webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
      }
      isDestroyed() { return false; }
      maximize() {}
      show() {}
      loadURL() {}
      close() {
        const event = { preventDefault: vi.fn() };
        this.emit("close", event);
        return event;
      }
    }
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, __dirname: import.meta.dirname,
      require: id => id === "electron" ? { app: { isPackaged: false }, BrowserWindow: Window } : require(id)
    });
    manager = module.exports.createWindowManager();
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
});
