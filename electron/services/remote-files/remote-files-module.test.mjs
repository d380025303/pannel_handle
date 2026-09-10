import { describe, expect, it, vi } from "vitest";
import remoteFiles from "./index.cjs";

const { createRemoteFilesModule, registerRemoteFileScheme } = remoteFiles;

function createHarness() {
  const handlers = new Map();
  const streamHandlers = new Map();
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler))
  };
  const protocol = {
    registerStreamProtocol: vi.fn((scheme, handler) => streamHandlers.set(scheme, handler))
  };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true }))
  };
  const terminalManager = {
    getSession: vi.fn(() => ({ id: "run-1", type: "windows", cwd: "C:\\workspace" }))
  };
  const module = createRemoteFilesModule({
    app: { getFileIcon: vi.fn(), getPath: vi.fn(() => "C:\\Temp\\pannel-handle-test") },
    nativeImage: { createFromPath: vi.fn() },
    ipcMain,
    protocol,
    dialog,
    shellApi: { openPath: vi.fn() },
    terminalManager,
    sessionStore: {},
    knownHostStore: {},
    sshFileSystem: {},
    windowManager: { getWindowFromEvent: vi.fn(() => null) },
    broadcast: vi.fn(),
    fallbackIconPath: "C:\\app\\build\\icon.png"
  });
  return { dialog, handlers, module, protocol, streamHandlers, terminalManager };
}

describe("remote-files module", () => {
  it("registers the privileged media scheme through its public interface", () => {
    const protocol = { registerSchemesAsPrivileged: vi.fn() };

    registerRemoteFileScheme(protocol);

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: "pannel-media",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }]);
  });

  it("owns remote file IPC and preserves canceled dialog behavior", async () => {
    const harness = createHarness();

    expect(harness.handlers.get("remote-files:home")).toEqual(expect.any(Function));
    expect(harness.handlers.get("remote-files:start-download-drag")).toEqual(expect.any(Function));
    expect(harness.handlers.get("file-transfers:choose-upload")).toEqual(expect.any(Function));
    expect(harness.handlers.get("file-transfers:clear")).toEqual(expect.any(Function));
    await expect(harness.handlers.get("remote-files:choose-root")({}, {
      sessionId: "run-1",
      currentRoot: "C:\\workspace"
    })).resolves.toEqual({ canceled: true });
    await expect(harness.handlers.get("file-transfers:choose-download")({}, {
      sessionId: "run-1",
      remotePath: "C:\\workspace\\note.txt",
      fileName: "note.txt"
    })).resolves.toEqual({ canceled: true });
  });

  it("selects roots only for Windows sessions", async () => {
    const harness = createHarness();
    harness.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["D:\\shared"] });

    await expect(harness.handlers.get("remote-files:choose-root")({}, {
      sessionId: "run-1",
      currentRoot: "C:\\workspace"
    })).resolves.toEqual({ canceled: false, path: "D:\\shared" });
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledWith(null, {
      defaultPath: "C:\\workspace",
      properties: ["openDirectory"]
    });

    harness.dialog.showOpenDialog.mockClear();
    harness.terminalManager.getSession.mockReturnValue({ id: "run-2", type: "wsl", cwd: "/workspace" });
    await expect(harness.handlers.get("remote-files:choose-root")({}, {
      sessionId: "run-2",
      currentRoot: "/workspace"
    })).resolves.toEqual({ canceled: true });
    expect(harness.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it("rejects empty dropped paths at the module IPC seam", () => {
    const harness = createHarness();

    expect(() => harness.handlers.get("file-transfers:upload-paths")({}, {
      sessionId: "run-1",
      remoteDir: "C:\\workspace",
      localPaths: ["", "   "]
    })).toThrow("No valid local file paths found");
  });

  it("returns a 404 response for an unknown media preview", () => {
    const harness = createHarness();
    const callback = vi.fn();

    harness.streamHandlers.get("pannel-media")({
      url: "pannel-media://preview/missing",
      headers: {}
    }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it("exposes idempotent shutdown through the module interface", async () => {
    const harness = createHarness();

    const firstShutdown = harness.module.shutdown();
    const secondShutdown = harness.module.shutdown();

    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
  });
});
