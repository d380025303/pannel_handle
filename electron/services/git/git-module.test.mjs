import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { GIT_IPC_CHANNELS } = require("./git-ipc-handlers.cjs");
const { createGitModule } = require("./git-module.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  };
}

describe("Git module", () => {
  it("owns Git IPC registration and lifecycle cleanup", () => {
    const ipcMain = createIpcMain();
    const gitModule = createGitModule({
      ipcMain,
      terminalManager: { getSession: vi.fn() },
      sessionStore: {},
      sshGitExecutor: {}
    });

    expect(Array.from(ipcMain.handlers.keys())).toEqual(GIT_IPC_CHANNELS);

    gitModule.shutdown();
    gitModule.shutdown();

    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(GIT_IPC_CHANNELS.length);
  });
});
