import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { IDEA_IPC_CHANNELS, registerIdeaIpcHandlers } = require("./idea-ipc-handlers.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  };
}

function createIdeaService() {
  return {
    getSnapshot: vi.fn(() => "snapshot"),
    startConfiguration: vi.fn(() => "started"),
    stopExecution: vi.fn(() => "stopped"),
    stopAll: vi.fn(() => "all-stopped"),
    restartExecution: vi.fn(() => "restarted")
  };
}

describe("IDEA IPC handlers", () => {
  it("registers and routes every IDEA channel", () => {
    const ipcMain = createIpcMain();
    const ideaService = createIdeaService();
    registerIdeaIpcHandlers({ ipcMain, ideaService });

    expect(Array.from(ipcMain.handlers.keys())).toEqual(IDEA_IPC_CHANNELS);
    expect(ipcMain.handlers.get("idea-bridge:snapshot")()).toBe("snapshot");
    expect(ipcMain.handlers.get("idea-bridge:start")({}, {
      bridgeId: "bridge-1",
      projectId: "project-1",
      configurationId: "configuration-1",
      mode: "debug"
    })).toBe("started");
    expect(ideaService.startConfiguration).toHaveBeenCalledWith("bridge-1", "project-1", "configuration-1", "debug");
    expect(ipcMain.handlers.get("idea-bridge:stop")({}, { bridgeId: "bridge-1", instanceId: "instance-1" })).toBe("stopped");
    expect(ideaService.stopExecution).toHaveBeenCalledWith("bridge-1", "instance-1");
    expect(ipcMain.handlers.get("idea-bridge:stop-all")({}, {
      bridgeId: "bridge-1",
      projectId: "project-1",
      configurationId: "configuration-1"
    })).toBe("all-stopped");
    expect(ideaService.stopAll).toHaveBeenCalledWith("bridge-1", "project-1", "configuration-1");
    expect(ipcMain.handlers.get("idea-bridge:restart")({}, { bridgeId: "bridge-1", instanceId: "instance-1" })).toBe("restarted");
    expect(ideaService.restartExecution).toHaveBeenCalledWith("bridge-1", "instance-1");
  });

  it("rejects invalid IDs and execution modes before calling the service", () => {
    const ipcMain = createIpcMain();
    const ideaService = createIdeaService();
    registerIdeaIpcHandlers({ ipcMain, ideaService });

    expect(() => ipcMain.handlers.get("idea-bridge:start")({}, {
      bridgeId: "bridge-1",
      projectId: "project-1",
      configurationId: "configuration-1",
      mode: "profile"
    })).toThrow(/run or debug/i);
    expect(() => ipcMain.handlers.get("idea-bridge:stop")({}, {
      bridgeId: " ",
      instanceId: "instance-1"
    })).toThrow(/bridgeId is required/i);
    expect(() => ipcMain.handlers.get("idea-bridge:restart")({}, {
      bridgeId: "bridge-1",
      instanceId: "x".repeat(513)
    })).toThrow(/instanceId is required/i);
    expect(ideaService.startConfiguration).not.toHaveBeenCalled();
    expect(ideaService.stopExecution).not.toHaveBeenCalled();
    expect(ideaService.restartExecution).not.toHaveBeenCalled();
  });

  it("removes every registered handler", () => {
    const ipcMain = createIpcMain();
    const unregister = registerIdeaIpcHandlers({ ipcMain, ideaService: createIdeaService() });

    unregister();

    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(IDEA_IPC_CHANNELS);
  });
});
