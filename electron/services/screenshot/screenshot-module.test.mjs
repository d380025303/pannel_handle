import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  SCREEN_CLIP_READY_DELAY_MS,
  WINDOW_HIDE_DELAY_MS,
  createScreenshotService
} = require("./screenshot-service.cjs");
const { SCREENSHOT_IPC_CHANNELS } = require("./screenshot-ipc-handlers.cjs");
const { createScreenshotModule } = require("./screenshot-module.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(channel => handlers.delete(channel))
  };
}

describe("screenshot module", () => {
  it("opens the fixed Windows region screenshot protocol", async () => {
    const shellApi = { openExternal: vi.fn().mockResolvedValue(undefined) };
    const service = createScreenshotService({ shellApi, platform: "win32" });
    await expect(service.captureRegion()).resolves.toEqual({ status: "launched" });
    expect(shellApi.openExternal).toHaveBeenCalledWith("ms-screenclip:");
  });

  it("temporarily hides the owner window and restores it without taking focus", async () => {
    const calls = [];
    const ownerWindow = {
      hide: vi.fn(() => calls.push("hide")),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      showInactive: vi.fn(() => calls.push("showInactive"))
    };
    const shellApi = { openExternal: vi.fn(async () => calls.push("openExternal")) };
    const delay = vi.fn(async milliseconds => calls.push(`delay:${milliseconds}`));
    const service = createScreenshotService({ shellApi, platform: "win32", delay });

    await expect(service.captureRegion(ownerWindow)).resolves.toEqual({ status: "launched" });

    expect(calls).toEqual([
      "hide",
      `delay:${WINDOW_HIDE_DELAY_MS}`,
      "openExternal",
      `delay:${SCREEN_CLIP_READY_DELAY_MS}`,
      "showInactive"
    ]);
    expect(ownerWindow.showInactive).toHaveBeenCalledTimes(1);
  });

  it("restores the owner window when launching the screenshot protocol fails", async () => {
    const ownerWindow = {
      hide: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      showInactive: vi.fn()
    };
    const delay = vi.fn().mockResolvedValue(undefined);
    const service = createScreenshotService({
      shellApi: { openExternal: vi.fn().mockRejectedValue(new Error("protocol missing")) },
      platform: "win32",
      delay
    });

    await expect(service.captureRegion(ownerWindow)).rejects.toThrow("protocol missing");
    expect(delay).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(WINDOW_HIDE_DELAY_MS);
    expect(ownerWindow.showInactive).toHaveBeenCalledOnce();
  });

  it("does not hide or restore an unavailable owner window", async () => {
    const ownerWindow = {
      hide: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      showInactive: vi.fn()
    };
    const delay = vi.fn().mockResolvedValue(undefined);
    const service = createScreenshotService({
      shellApi: { openExternal: vi.fn().mockResolvedValue(undefined) },
      platform: "win32",
      delay
    });

    await expect(service.captureRegion(ownerWindow)).resolves.toEqual({ status: "launched" });
    expect(ownerWindow.hide).not.toHaveBeenCalled();
    expect(ownerWindow.showInactive).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it("does not restore the owner window when it is destroyed during capture", async () => {
    const ownerWindow = {
      hide: vi.fn(),
      isDestroyed: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      isVisible: vi.fn(() => true),
      showInactive: vi.fn()
    };
    const service = createScreenshotService({
      shellApi: { openExternal: vi.fn().mockResolvedValue(undefined) },
      platform: "win32",
      delay: vi.fn().mockResolvedValue(undefined)
    });

    await expect(service.captureRegion(ownerWindow)).resolves.toEqual({ status: "launched" });
    expect(ownerWindow.hide).toHaveBeenCalledOnce();
    expect(ownerWindow.showInactive).not.toHaveBeenCalled();
  });

  it("rejects unsupported platforms and propagates launch failures", async () => {
    const unsupported = createScreenshotService({ shellApi: { openExternal: vi.fn() }, platform: "linux" });
    await expect(unsupported.captureRegion()).rejects.toThrow("仅支持 Windows");

    const failed = createScreenshotService({ shellApi: { openExternal: vi.fn().mockRejectedValue(new Error("protocol missing")) }, platform: "win32" });
    await expect(failed.captureRegion()).rejects.toThrow("protocol missing");
  });

  it("owns its IPC handler and shuts down idempotently", async () => {
    const ipcMain = createIpcMain();
    const captureRegion = vi.fn().mockResolvedValue({ status: "launched" });
    const ownerWindow = {};
    const event = { sender: {} };
    const getWindowFromEvent = vi.fn(() => ownerWindow);
    const module = createScreenshotModule({
      ipcMain,
      shellApi: {},
      getWindowFromEvent,
      createService: vi.fn(() => ({ captureRegion }))
    });
    expect([...ipcMain.handlers.keys()]).toEqual(SCREENSHOT_IPC_CHANNELS);
    await expect(ipcMain.handlers.get("screenshot:capture-region")(event)).resolves.toEqual({ status: "launched" });
    expect(getWindowFromEvent).toHaveBeenCalledWith(event);
    expect(captureRegion).toHaveBeenCalledWith(ownerWindow);
    module.shutdown();
    module.shutdown();
    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1);
  });
});
