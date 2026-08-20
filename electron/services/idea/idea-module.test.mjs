import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { IDEA_IPC_CHANNELS } = require("./idea-ipc-handlers.cjs");
const { createIdeaModule } = require("./idea-module.cjs");
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  };
}

describe("IDEA module", () => {
  it("owns IDEA startup, IPC registration, and idempotent cleanup", async () => {
    const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-module-test-"));
    tempDirs.push(discoveryDir);
    const ipcMain = createIpcMain();
    const ideaModule = createIdeaModule({ ipcMain, discoveryDir, broadcast: vi.fn() });

    expect(Array.from(ipcMain.handlers.keys())).toEqual(IDEA_IPC_CHANNELS);
    await ideaModule.start();
    await ideaModule.shutdown();
    await ideaModule.shutdown();

    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(IDEA_IPC_CHANNELS.length);
  });
});
