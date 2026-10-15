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
  it.each(["D:\\", "C:\\downloads"])("queues multiple files and folders under %s", async (destination) => {
    const test = harness(vi.fn(async () => [{ name: "nested.txt", path: "/project/nested.txt", type: "file" }]));
    test.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destination] });
    await test.handler({}, { sessionId: "s1", entries: [
      { name: "report.txt", path: "/report.txt", type: "file" },
      { name: "project", path: "/project", type: "directory" }
    ] });
    expect(test.enqueueDownloads).toHaveBeenCalledExactlyOnceWith("s1", [
      { remotePath: "/report.txt", localPath: path.win32.join(destination, "report.txt"), fileName: "report.txt", atomicOverwrite: true },
      { remotePath: "/project/nested.txt", localPath: path.win32.join(destination, "project", "nested.txt"), fileName: "nested.txt", atomicOverwrite: true }
    ]);
  });

  it.each(["file", "directory"])("rejects case-conflicting %s sources before creating directories or queuing", async (type) => {
    const list = vi.fn(async (_sessionId, remotePath) => remotePath === "/project" ? [
      { name: "README.txt", path: "/project/README.txt", type },
      { name: "readme.txt", path: "/project/readme.txt", type }
    ] : []);
    const test = harness(list);
    await expect(test.handler({}, { sessionId: "s1", entries: [
      { name: "project", path: "/project", type: "directory" }
    ] })).rejects.toThrow("Download name conflict:");
    expect(test.mkdir).not.toHaveBeenCalled();
    expect(test.enqueueDownloads).not.toHaveBeenCalled();
  });

  it("deduplicates repeated selections of the same source", async () => {
    const test = harness(vi.fn());
    const entry = { name: "readme.txt", path: "/project/readme.txt", type: "file" };
    const result = await test.handler({}, { sessionId: "s1", entries: [entry, { ...entry }] });
    expect(result.canceled).toBe(false);
    expect(test.enqueueDownloads).toHaveBeenCalledExactlyOnceWith("s1", [{
      remotePath: entry.path, localPath: "C:\\downloads\\readme.txt", fileName: entry.name, atomicOverwrite: true
    }]);
  });

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

  it.each(["D:\\", "C:\\downloads"])("rejects names that would leave %s", async (destination) => {
    const test = harness(vi.fn());
    test.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [destination] });
    await expect(test.handler({}, { sessionId: "s1", entries: [{ name: "..", path: "/outside", type: "file" }] })).rejects.toThrow("Invalid download path");
    expect(test.enqueueDownloads).not.toHaveBeenCalled();
    expect(test.mkdir).not.toHaveBeenCalled();
  });
});
