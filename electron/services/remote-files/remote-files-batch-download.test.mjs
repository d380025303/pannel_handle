import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { registerRemoteFileIpcHandlers } from "./remote-files-ipc-handlers.cjs";

function harness(list) {
  const handlers = new Map();
  const mkdir = vi.fn(async () => undefined);
  const enqueueDownloads = vi.fn(() => []);
  const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["C:\\downloads"] })) };
  registerRemoteFileIpcHandlers({
    app: {}, nativeImage: {}, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog, terminalManager: {}, windowManager: { getWindowFromEvent: () => null },
    remoteFileService: { list }, fileTransferManager: { enqueueDownloads }, fileWatchManager: {},
    fsApi: { promises: { mkdir } }, pathApi: path.win32
  });
  return { handler: handlers.get("file-transfers:choose-download-batch"), mkdir, enqueueDownloads, dialog };
}

describe("batch remote download", () => {
  it("expands folders, keeps empty folders, and queues files under one chosen directory", async () => {
    const list = vi.fn(async (_sessionId, remotePath) => remotePath === "/project"
      ? [{ name: "nested", path: "/project/nested", type: "directory" }, { name: "readme.txt", path: "/project/readme.txt", type: "file" }]
      : []);
    const test = harness(list);
    const result = await test.handler({}, { sessionId: "s1", entries: [{ name: "project", path: "/project", type: "directory" }] });
    expect(test.dialog.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("s1", "/project/nested");
    expect(test.mkdir).toHaveBeenCalledWith("C:\\downloads\\project\\nested", { recursive: true });
    expect(test.enqueueDownloads).toHaveBeenCalledWith("s1", [{
      remotePath: "/project/readme.txt", localPath: "C:\\downloads\\project\\readme.txt", fileName: "readme.txt", atomicOverwrite: true
    }]);
    expect(result).toEqual({ canceled: false, tasks: [] });
  });

  it("does not queue a partial tree when listing fails", async () => {
    const test = harness(vi.fn(async () => { throw new Error("remote listing failed"); }));
    await expect(test.handler({}, { sessionId: "s1", entries: [{ name: "project", path: "/project", type: "directory" }] })).rejects.toThrow("remote listing failed");
    expect(test.enqueueDownloads).not.toHaveBeenCalled();
    expect(test.mkdir).not.toHaveBeenCalled();
  });

  it("rejects names that would leave the chosen directory", async () => {
    const test = harness(vi.fn());
    await expect(test.handler({}, { sessionId: "s1", entries: [{ name: "..", path: "/outside", type: "file" }] })).rejects.toThrow("Invalid download path");
    expect(test.enqueueDownloads).not.toHaveBeenCalled();
  });
});
