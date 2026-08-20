import { describe, expect, it, vi } from "vitest";
import { createFileTransferManager } from "./file-transfer-manager.cjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("file-transfer-manager", () => {
  it("runs at most two transfers and starts the next queued task", async () => {
    const runs = [deferred(), deferred(), deferred()];
    const remoteFileService = {
      downloadFile: vi.fn((_sessionId, _remotePath, _localPath, options) => {
        const run = runs[remoteFileService.downloadFile.mock.calls.length - 1];
        options.onProgress({ transferredBytes: 1, totalBytes: 2, percent: 50 });
        return run.promise;
      }),
      cancelDownload: vi.fn(async () => true)
    };
    const manager = createFileTransferManager({ remoteFileService, broadcast: vi.fn() });

    manager.enqueueDownload("s1", "/a", "C:\\a", "a");
    manager.enqueueDownload("s1", "/b", "C:\\b", "b");
    manager.enqueueDownload("s1", "/c", "C:\\c", "c");
    await vi.waitFor(() => expect(remoteFileService.downloadFile).toHaveBeenCalledTimes(2));
    expect(manager.list().filter((task) => task.status === "queued")).toHaveLength(1);

    runs[0].resolve({});
    await vi.waitFor(() => expect(remoteFileService.downloadFile).toHaveBeenCalledTimes(3));
    runs[1].resolve({});
    runs[2].resolve({});
    await vi.waitFor(() => expect(manager.list().every((task) => task.status === "completed")).toBe(true));
  });

  it("pauses upload conflicts and resumes with a selected policy", async () => {
    const remoteFileService = {
      uploadFile: vi.fn()
        .mockResolvedValueOnce({ status: "conflict", remotePath: "/target/a.txt" })
        .mockResolvedValueOnce({ status: "completed", remotePath: "/target/a (1).txt" }),
      cancelDownload: vi.fn()
    };
    const manager = createFileTransferManager({
      remoteFileService,
      broadcast: vi.fn(),
      fsApi: { promises: { stat: vi.fn(async () => ({ size: 10 })) } }
    });
    const [task] = manager.enqueueUploads("s1", ["C:\\a.txt"], "/target");
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("conflict"));
    expect(manager.resolveConflict(task.id, "rename")).toBe(true);
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("completed"));
    expect(remoteFileService.uploadFile).toHaveBeenLastCalledWith("s1", "C:\\a.txt", "/target", "rename");
  });

  it("keeps only the configured number of completed tasks", async () => {
    const remoteFileService = {
      uploadFile: vi.fn(async (_sessionId, localPath) => ({ status: "completed", remotePath: localPath })),
      cancelDownload: vi.fn()
    };
    const manager = createFileTransferManager({
      remoteFileService,
      broadcast: vi.fn(),
      concurrency: 2,
      historyLimit: 2,
      fsApi: { promises: { stat: vi.fn(async () => ({ size: 1 })) } }
    });
    manager.enqueueUploads("s1", ["a", "b", "c"], "/target");
    await vi.waitFor(() => expect(remoteFileService.uploadFile).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(manager.list()).toHaveLength(2));
  });

  it("does not retry a canceled upload until its in-flight copy has settled", async () => {
    const upload = deferred();
    const remoteFileService = {
      uploadFile: vi.fn(() => upload.promise),
      cancelDownload: vi.fn()
    };
    const manager = createFileTransferManager({
      remoteFileService,
      broadcast: vi.fn(),
      fsApi: { promises: { stat: vi.fn(async () => ({ size: 10 })) } }
    });

    const [task] = manager.enqueueUploads("s1", ["C:\\a.txt"], "/target");
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("running"));
    expect(await manager.cancel(task.id)).toBe(true);
    expect(manager.retry(task.id)).toBe(false);

    upload.resolve({ status: "completed", remotePath: "/target/a.txt" });
    await vi.waitFor(() => expect(manager.retry(task.id)).toBe(true));
    await vi.waitFor(() => expect(remoteFileService.uploadFile).toHaveBeenCalledTimes(2));
  });
});
