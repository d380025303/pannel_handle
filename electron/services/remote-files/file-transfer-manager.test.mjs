import { describe, expect, it, vi } from "vitest";
import { createFileTransferManager } from "./file-transfer-manager.cjs";
import { createRemoteFileService } from "./remote-file-service.cjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("file-transfer-manager", () => {
  it("coalesces progress and publishes final, canceled, retried and cleared states", async () => {
    vi.useFakeTimers();
    try {
      const runs = [deferred(), deferred()];
      let options;
      let attempt = 0;
      const broadcast = vi.fn();
      const manager = createFileTransferManager({
        broadcast,
        remoteFileService: {
          downloadFile: vi.fn((_session, _remote, _local, currentOptions) => {
            options = currentOptions;
            return runs[attempt++].promise;
          }),
          cancelDownload: vi.fn(async () => {
            runs[0].reject(Object.assign(new Error("canceled"), { code: "DOWNLOAD_CANCELED" }));
            return true;
          })
        }
      });
      const task = manager.enqueueDownload("s1", "/a", "a", "a");
      for (let i = 1; i <= 1000; i++) {
        options.onProgress({ transferredBytes: i, totalBytes: 2000, percent: i / 20 });
      }
      expect(manager.list()[0].transferredBytes).toBe(1000);
      expect(broadcast).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast.mock.lastCall[1][0]).toMatchObject({ status: "running", percent: 50 });
      expect(await manager.cancel(task.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(broadcast.mock.lastCall[1][0].status).toBe("canceled");
      expect(manager.retry(task.id)).toBe(true);
      expect(manager.list()[0]).toMatchObject({ status: "running", transferredBytes: 0, percent: null });
      await vi.advanceTimersByTimeAsync(150);
      expect(broadcast.mock.lastCall[1][0].status).toBe("running");
      runs[1].resolve();
      await vi.advanceTimersByTimeAsync(150);
      expect(broadcast.mock.lastCall[1][0]).toMatchObject({ status: "completed", percent: 100 });
      manager.clear(task.id);
      await manager.shutdown();
      expect(broadcast.mock.lastCall[1]).toEqual([]);
      const calls = broadcast.mock.calls.length;
      await vi.advanceTimersByTimeAsync(300);
      expect(broadcast).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1000, 2000, 5000])("coalesces an immediate batch of %i downloads into one final snapshot", async (count) => {
    const broadcast = vi.fn();
    const finished = deferred();
    let downloads = 0;
    const manager = createFileTransferManager({
      broadcast,
      remoteFileService: {
        downloadFile: async () => { if (++downloads === count) finished.resolve(); },
        cancelDownload: vi.fn()
      }
    });
    manager.enqueueDownloads("s1", Array.from({ length: count }, (_, i) => ({
      remotePath: `/file-${i}`, localPath: `file-${i}`, fileName: `file-${i}`
    })));
    await finished.promise;
    // Drain the final attempts without polling list() for every task.
    await new Promise((resolve) => setImmediate(resolve));
    await manager.shutdown();
    expect(downloads).toBe(count);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.lastCall[1]).toHaveLength(50);
    expect(broadcast.mock.lastCall[1].every((task) => task.status === "completed" && task.percent === 100)).toBe(true);
  });

  it("replaces an existing file only after a batch download succeeds", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-batch-download-"));
    const target = path.join(dir, "note.txt");
    await fs.writeFile(target, "original");
    const remoteFileService = {
      downloadFile: vi.fn(async (_sessionId, _remotePath, localPath) => { await fs.writeFile(localPath, "replacement"); }),
      cancelDownload: vi.fn()
    };
    try {
      const manager = createFileTransferManager({ remoteFileService, broadcast: vi.fn() });
      manager.enqueueDownloads("s1", [{ remotePath: "/note.txt", localPath: target, fileName: "note.txt", atomicOverwrite: true }]);
      await vi.waitFor(() => expect(manager.list()[0].status).toBe("completed"));
      expect(await fs.readFile(target, "utf8")).toBe("replacement");
      expect(remoteFileService.downloadFile.mock.calls[0][2]).not.toBe(target);

      remoteFileService.downloadFile.mockImplementationOnce(async (_sessionId, _remotePath, localPath) => {
        await fs.writeFile(localPath, "partial");
        throw new Error("network failed");
      });
      manager.enqueueDownloads("s1", [{ remotePath: "/note.txt", localPath: target, fileName: "note.txt", atomicOverwrite: true }]);
      await vi.waitFor(() => expect(manager.list().some((task) => task.status === "failed")).toBe(true));
      expect(await fs.readFile(target, "utf8")).toBe("replacement");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("updates a running upload from service progress", async () => {
    const upload = deferred();
    const remoteFileService = {
      uploadFile: vi.fn((_sessionId, _localPath, _remoteDir, _conflictPolicy, options) => {
        options?.onProgress({ transferredBytes: 5, totalBytes: 10, percent: 50 });
        return upload.promise;
      }),
      cancelDownload: vi.fn()
    };
    const manager = createFileTransferManager({
      remoteFileService,
      broadcast: vi.fn(),
      fsApi: { promises: { stat: vi.fn(async () => ({ size: 10 })) } }
    });

    manager.enqueueUploads("s1", ["C:\\large.dump"], "/target");
    await vi.waitFor(() => expect(manager.list()[0]).toEqual(expect.objectContaining({
      status: "running",
      transferredBytes: 5,
      totalBytes: 10,
      percent: 50
    })));

    upload.resolve({ status: "completed", remotePath: "/target/large.dump" });
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("completed"));
  });

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
    expect(remoteFileService.uploadFile).toHaveBeenLastCalledWith(
      "s1",
      "C:\\a.txt",
      "/target",
      "rename",
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
  });

  it("completes a same-file overwrite without truncating the original", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-same-file-upload-"));
    const source = path.join(dir, "a.txt");
    const content = Buffer.alloc(29, 65);
    const remoteFileService = createRemoteFileService({
      terminalManager: { getSession: () => ({ id: "s1", type: "windows", cwd: dir }) }
    });
    const manager = createFileTransferManager({ remoteFileService, broadcast: vi.fn() });
    try {
      await fs.writeFile(source, content);
      const [task] = manager.enqueueUploads("s1", [source], dir);
      await vi.waitFor(() => expect(manager.list()[0].status).toBe("conflict"));
      expect(manager.resolveConflict(task.id, "overwrite")).toBe(true);
      await vi.waitFor(() => expect(manager.list()[0]).toMatchObject({
        status: "completed", transferredBytes: 29, totalBytes: 29, percent: 100
      }));
      expect(await fs.readFile(source)).toEqual(content);
      expect((await fs.stat(source)).size).toBe(29);
    } finally {
      await manager.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("finishes skipped upload conflicts without overwriting the target and allows cleanup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-skipped-upload-"));
    const source = path.join(dir, "a.txt");
    const targetDir = path.join(dir, "target");
    const target = path.join(targetDir, "a.txt");
    try {
      await fs.mkdir(targetDir);
      await fs.writeFile(source, "replacement");
      await fs.writeFile(target, "original");
      const remoteFileService = createRemoteFileService({
        terminalManager: { getSession: () => ({ id: "s1", type: "windows", cwd: dir }) }
      });
      const manager = createFileTransferManager({ remoteFileService, broadcast: vi.fn() });
      const [task] = manager.enqueueUploads("s1", [source], targetDir);
      await vi.waitFor(() => expect(manager.list()[0].status).toBe("conflict"));

      expect(manager.resolveConflict(task.id, "skip")).toBe(true);
      await vi.waitFor(() => expect(manager.list()[0]).toEqual(expect.objectContaining({
        status: "canceled",
        error: "Upload skipped.",
        remotePath: target,
        transferredBytes: 0,
        percent: 0
      })));
      expect(await fs.readFile(target, "utf8")).toBe("original");
      expect(manager.hasActiveForSession("s1")).toBe(false);
      expect(manager.clear(task.id)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
    let uploadOptions;
    const remoteFileService = {
      uploadFile: vi.fn((_sessionId, _localPath, _remoteDir, _conflictPolicy, options) => {
        uploadOptions = options;
        return upload.promise;
      }),
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
    uploadOptions.onProgress({ transferredBytes: 5, totalBytes: 10, percent: 50 });
    expect(manager.list()[0]).toEqual(expect.objectContaining({ status: "canceled", transferredBytes: 0, percent: 0 }));
    expect(manager.retry(task.id)).toBe(false);

    upload.resolve({ status: "completed", remotePath: "/target/a.txt" });
    await vi.waitFor(() => expect(manager.retry(task.id)).toBe(true));
    await vi.waitFor(() => expect(remoteFileService.uploadFile).toHaveBeenCalledTimes(2));
  });
});
