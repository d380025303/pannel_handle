const crypto = require("node:crypto");
const fs = require("node:fs");

function createFileTransferManager({ remoteFileService, broadcast, fsApi = fs, concurrency = 2, historyLimit = 50 }) {
  const tasks = new Map();
  const queue = [];
  const activeRuns = new Set();
  let running = 0;

  function serialize(task) {
    const { request, attemptRunning, ...publicTask } = task;
    return { ...publicTask };
  }

  function list() {
    return Array.from(tasks.values()).map(serialize).sort((a, b) => b.createdAt - a.createdAt);
  }

  function notify() {
    broadcast("file-transfers:changed", list());
  }

  function prune() {
    const completed = Array.from(tasks.values())
      .filter((task) => !task.attemptRunning && ["completed", "canceled", "failed"].includes(task.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const task of completed.slice(historyLimit)) tasks.delete(task.id);
  }

  function update(task, patch) {
    Object.assign(task, patch, { updatedAt: Date.now() });
    prune();
    notify();
  }

  async function run(task) {
    running += 1;
    task.attemptRunning = true;
    update(task, { status: "running", error: undefined });
    try {
      if (task.direction === "upload") {
        const stat = await fsApi.promises.stat(task.request.localPath);
        update(task, { totalBytes: Number(stat.size || 0), transferredBytes: 0, percent: 0 });
        const result = await remoteFileService.uploadFile(task.sessionId, task.request.localPath, task.request.remoteDir, task.request.conflictPolicy || "cancel");
        if (result.status === "conflict") {
          update(task, { status: "conflict", remotePath: result.remotePath });
          return;
        }
        if (task.status === "canceled" || result.status === "skipped") return;
        update(task, { status: "completed", remotePath: result.remotePath, transferredBytes: task.totalBytes, percent: 100 });
      } else {
        await remoteFileService.downloadFile(task.sessionId, task.request.remotePath, task.request.localPath, {
          transferId: task.id,
          onProgress: (progress) => update(task, {
            transferredBytes: progress.transferredBytes,
            totalBytes: progress.totalBytes,
            percent: progress.percent
          })
        });
        update(task, { status: "completed", transferredBytes: task.totalBytes, percent: 100 });
      }
    } catch (error) {
      update(task, {
        status: error?.code === "DOWNLOAD_CANCELED" ? "canceled" : "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      task.attemptRunning = false;
      running -= 1;
      prune();
      notify();
      schedule();
    }
  }

  function start(task) {
    const promise = run(task);
    activeRuns.add(promise);
    void promise.finally(() => activeRuns.delete(promise));
  }

  function schedule() {
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift();
      if (task.status === "queued") start(task);
    }
  }

  function enqueue(direction, sessionId, requests) {
    const created = requests.map((request) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      const task = {
        id,
        sessionId,
        direction,
        name: direction === "upload" ? request.fileName : request.fileName,
        localPath: request.localPath,
        remotePath: request.remotePath,
        status: "queued",
        transferredBytes: 0,
        totalBytes: 0,
        percent: null,
        createdAt: now,
        updatedAt: now,
        attemptRunning: false,
        request
      };
      tasks.set(id, task);
      queue.push(task);
      return serialize(task);
    });
    notify();
    schedule();
    return created;
  }

  function enqueueUploads(sessionId, localPaths, remoteDir) {
    return enqueue("upload", sessionId, localPaths.map((localPath) => ({
      localPath,
      remoteDir,
      fileName: require("node:path").basename(localPath)
    })));
  }

  function enqueueDownload(sessionId, remotePath, localPath, fileName) {
    return enqueue("download", sessionId, [{ remotePath, localPath, fileName }])[0];
  }

  async function cancel(id) {
    const task = tasks.get(id);
    if (!task || !["queued", "running"].includes(task.status)) return false;
    if (task.status === "queued") {
      update(task, { status: "canceled" });
      return true;
    }
    if (task.direction === "download") return remoteFileService.cancelDownload(id);
    update(task, { status: "canceled", error: "Upload cancellation will take effect after the current file." });
    return true;
  }

  function retry(id) {
    const task = tasks.get(id);
    if (!task || task.attemptRunning || !["failed", "canceled"].includes(task.status)) return false;
    update(task, { status: "queued", error: undefined, transferredBytes: 0, percent: null });
    queue.push(task);
    schedule();
    return true;
  }

  function resolveConflict(id, policy) {
    const task = tasks.get(id);
    if (!task || task.status !== "conflict" || !["overwrite", "skip", "rename"].includes(policy)) return false;
    task.request.conflictPolicy = policy;
    update(task, { status: "queued", error: undefined });
    queue.push(task);
    schedule();
    return true;
  }

  function clear(id) {
    if (id) {
      const task = tasks.get(id);
      if (task && !task.attemptRunning && !["queued", "running"].includes(task.status)) tasks.delete(id);
    } else {
      for (const [taskId, task] of tasks) {
        if (!task.attemptRunning && !["queued", "running"].includes(task.status)) tasks.delete(taskId);
      }
    }
    notify();
    return list();
  }

  function hasActiveForSession(sessionId) {
    return Array.from(tasks.values()).some((task) => task.sessionId === sessionId && ["queued", "running"].includes(task.status));
  }

  async function shutdown() {
    await Promise.all(Array.from(tasks.values()).filter((task) => ["queued", "running"].includes(task.status)).map((task) => cancel(task.id)));
    await Promise.allSettled(Array.from(activeRuns));
  }

  return { list, enqueueUploads, enqueueDownload, cancel, retry, resolveConflict, clear, hasActiveForSession, shutdown };
}

module.exports = { createFileTransferManager };
