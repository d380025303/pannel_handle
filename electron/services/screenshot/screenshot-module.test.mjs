import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createScreenshotService } = require("./screenshot-service.cjs");
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

  it("rejects unsupported platforms and propagates launch failures", async () => {
    const unsupported = createScreenshotService({ shellApi: { openExternal: vi.fn() }, platform: "linux" });
    await expect(unsupported.captureRegion()).rejects.toThrow("仅支持 Windows");

    const failed = createScreenshotService({ shellApi: { openExternal: vi.fn().mockRejectedValue(new Error("protocol missing")) }, platform: "win32" });
    await expect(failed.captureRegion()).rejects.toThrow("protocol missing");
  });

  it("owns its IPC handler and shuts down idempotently", async () => {
    const ipcMain = createIpcMain();
    const captureRegion = vi.fn().mockResolvedValue({ status: "launched" });
    const module = createScreenshotModule({
      ipcMain,
      shellApi: {},
      createService: vi.fn(() => ({ captureRegion }))
    });
    expect([...ipcMain.handlers.keys()]).toEqual(SCREENSHOT_IPC_CHANNELS);
    await expect(ipcMain.handlers.get("screenshot:capture-region")()).resolves.toEqual({ status: "launched" });
    module.shutdown();
    module.shutdown();
    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(1);
  });
});
