const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startNativeFileDrag } = require("./native-file-drag.cjs");

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeLocalPaths(localPaths) {
  if (!Array.isArray(localPaths)) {
    throw new Error("Local file paths are required.");
  }
  const paths = localPaths
    .filter((filePath) => typeof filePath === "string")
    .map((filePath) => filePath.trim())
    .filter(Boolean);
  if (paths.length === 0) {
    throw new Error("No valid local file paths found. Only local files can be uploaded.");
  }
  return paths;
}

function getDownloadFileName(fileName, remotePath, pathApi = path) {
  const fallback = pathApi.posix.basename(String(remotePath || "download").replace(/\\/g, "/")) || "download";
  const rawName = String(fileName || fallback).trim() || fallback;
  const baseName = pathApi.basename(rawName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return baseName || "download";
}

function registerRemoteFileIpcHandlers({
  app,
  nativeImage,
  ipcMain,
  dialog,
  terminalManager,
  windowManager,
  remoteFileService,
  fileTransferManager,
  fileWatchManager,
  fallbackIconPath,
  fsApi = fs,
  osApi = os,
  pathApi = path,
  startNativeFileDragApi = startNativeFileDrag
}) {
  const downloadOwners = new Map();

  async function runDownload(event, { transferId, sessionId, remotePath, localPath, fileName }) {
    const id = String(transferId || "").trim();
    if (!id) throw new Error("A download transfer ID is required.");
    if (downloadOwners.has(id) || Array.from(downloadOwners.values()).includes(event.sender.id)) {
      throw new Error("Another download is already in progress.");
    }
    downloadOwners.set(id, event.sender.id);
    let lastProgressAt = 0;
    const sendProgress = (payload) => {
      const now = Date.now();
      if (payload.percent !== 100 && now - lastProgressAt < 80) return;
      lastProgressAt = now;
      if (!event.sender.isDestroyed()) {
        event.sender.send("remote-files:download-progress", {
          ...payload,
          sessionId,
          remotePath,
          fileName,
          status: "running"
        });
      }
    };
    const cancelWhenDestroyed = () => void remoteFileService.cancelDownload(id);
    event.sender.once("destroyed", cancelWhenDestroyed);
    try {
      const downloaded = await remoteFileService.downloadFile(sessionId, remotePath, localPath, {
        transferId: id,
        onProgress: sendProgress
      });
      if (!event.sender.isDestroyed()) {
        event.sender.send("remote-files:download-progress", {
          transferId: id,
          sessionId,
          remotePath,
          fileName,
          status: "completed"
        });
      }
      return { canceled: false, ...downloaded };
    } catch (error) {
      const canceled = error?.code === "DOWNLOAD_CANCELED";
      if (!event.sender.isDestroyed()) {
        event.sender.send("remote-files:download-progress", {
          transferId: id,
          sessionId,
          remotePath,
          fileName,
          status: canceled ? "canceled" : "failed",
          error: canceled ? undefined : getErrorMessage(error)
        });
      }
      if (canceled) return { canceled: true, transferId: id };
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelWhenDestroyed);
      downloadOwners.delete(id);
    }
  }

  ipcMain.handle("remote-files:home", (_event, { sessionId }) => remoteFileService.getHome(sessionId));
  ipcMain.handle("remote-files:list", (_event, { sessionId, remotePath }) => remoteFileService.list(sessionId, remotePath));
  ipcMain.handle("remote-files:read-text", (_event, { sessionId, remotePath }) => remoteFileService.readText(sessionId, remotePath));
  ipcMain.handle("remote-files:preview-file", (_event, { sessionId, remotePath }) => remoteFileService.previewFile(sessionId, remotePath));
  ipcMain.handle("remote-files:release-preview", (_event, { previewId }) => remoteFileService.releasePreview(previewId));
  ipcMain.handle("remote-files:write-text", (_event, { sessionId, remotePath, content, expectedVersion, options }) => (
    remoteFileService.writeText(sessionId, remotePath, content, expectedVersion, options)
  ));
  ipcMain.handle("remote-files:create", (_event, { sessionId, parentPath, name, kind, conflictPolicy }) => (
    remoteFileService.createEntry(sessionId, parentPath, name, kind, conflictPolicy)
  ));
  ipcMain.handle("remote-files:move", (_event, { sessionId, sourcePath, targetDirectory, name, conflictPolicy }) => (
    remoteFileService.moveEntry(sessionId, sourcePath, targetDirectory, name, conflictPolicy)
  ));

  ipcMain.handle("remote-files:choose-root", async (event, { sessionId, currentRoot }) => {
    const session = terminalManager.getSession(sessionId);
    if (!session || session.type !== "windows") return { canceled: true };
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, {
      defaultPath: currentRoot,
      properties: ["openDirectory"]
    });
    return result.canceled || result.filePaths.length === 0
      ? { canceled: true }
      : { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("remote-files:upload-file", async (event, { sessionId, remoteDir }) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, { properties: ["openFile"] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const uploaded = await remoteFileService.uploadFile(sessionId, result.filePaths[0], remoteDir);
    return { canceled: false, ...uploaded };
  });

  ipcMain.handle("remote-files:upload-files", async (_event, { sessionId, remoteDir, localPaths }) => {
    const uploaded = await remoteFileService.uploadFiles(sessionId, sanitizeLocalPaths(localPaths), remoteDir);
    return { canceled: false, uploaded };
  });

  ipcMain.handle("remote-files:download-file", async (event, { transferId, sessionId, remotePath, fileName }) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showSaveDialog(ownerWindow, { defaultPath: fileName || "download" });
    if (result.canceled || !result.filePath) return { canceled: true };
    return runDownload(event, { transferId, sessionId, remotePath, localPath: result.filePath, fileName });
  });

  ipcMain.handle("remote-files:start-download-drag", async (event, { transferId, sessionId, remotePath, fileName }) => {
    const tempRoot = pathApi.join(osApi.tmpdir(), "pannel-handle-drag-downloads");
    await fsApi.promises.mkdir(tempRoot, { recursive: true });
    const tempDir = await fsApi.promises.mkdtemp(pathApi.join(tempRoot, "drag-"));
    const localPath = pathApi.join(tempDir, getDownloadFileName(fileName, remotePath, pathApi));
    const downloaded = await runDownload(event, { transferId, sessionId, remotePath, localPath, fileName });
    if (downloaded.canceled) return downloaded;
    await startNativeFileDragApi({
      app,
      nativeImage,
      sender: event.sender,
      filePath: downloaded.localPath,
      fallbackIconPath
    });
    return { canceled: false, ...downloaded };
  });

  ipcMain.handle("remote-files:cancel-download", (event, { transferId }) => {
    const id = String(transferId || "");
    if (downloadOwners.get(id) !== event.sender.id) return false;
    return remoteFileService.cancelDownload(id);
  });
  ipcMain.handle("remote-files:open-in-explorer", (_event, { sessionId, remotePath }) => remoteFileService.openInExplorer(sessionId, remotePath));
  ipcMain.handle("remote-files:delete", (_event, { sessionId, remotePath, options }) => remoteFileService.deleteEntry(sessionId, remotePath, options));
  ipcMain.handle("remote-files:watch", (_event, { sessionId, directories }) => fileWatchManager.setDirectories(sessionId, directories));
  ipcMain.handle("remote-files:unwatch", (_event, { sessionId }) => fileWatchManager.stop(sessionId));

  ipcMain.handle("file-transfers:list", () => fileTransferManager.list());
  ipcMain.handle("file-transfers:choose-upload", async (event, { sessionId, remoteDir }) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, { properties: ["openFile", "multiSelections"] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, tasks: fileTransferManager.enqueueUploads(sessionId, result.filePaths, remoteDir) };
  });
  ipcMain.handle("file-transfers:upload-paths", (_event, { sessionId, remoteDir, localPaths }) => ({
    canceled: false,
    tasks: fileTransferManager.enqueueUploads(sessionId, sanitizeLocalPaths(localPaths), remoteDir)
  }));
  ipcMain.handle("file-transfers:choose-download", async (event, { sessionId, remotePath, fileName }) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showSaveDialog(ownerWindow, { defaultPath: fileName || "download" });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, task: fileTransferManager.enqueueDownload(sessionId, remotePath, result.filePath, fileName) };
  });
  ipcMain.handle("file-transfers:choose-download-batch", async (event, { sessionId, entries }) => {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("No entries were selected for download.");
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const destination = result.filePaths[0];
    const directories = new Set();
    const requests = new Map();
    const seenTypes = new Map();
    async function collect(entry, relativeParent = "") {
      const name = getDownloadFileName(entry.name, entry.path, pathApi);
      const relativePath = pathApi.join(relativeParent, name);
      const localPath = pathApi.resolve(destination, relativePath);
      const destinationRoot = pathApi.resolve(destination);
      if (!localPath.startsWith(`${destinationRoot}${pathApi.sep}`)) throw new Error("Invalid download path.");
      const key = localPath.toLowerCase();
      const kind = entry.type === "directory" ? "directory" : "file";
      if (seenTypes.has(key) && seenTypes.get(key) !== kind) throw new Error(`Download name conflict: ${relativePath}`);
      seenTypes.set(key, kind);
      if (entry.type === "directory") {
        directories.add(localPath);
        const children = await remoteFileService.list(sessionId, entry.path);
        for (const child of children) await collect(child, relativePath);
      } else {
        directories.add(pathApi.dirname(localPath));
        requests.set(key, { remotePath: entry.path, localPath, fileName: name, atomicOverwrite: true });
      }
    }
    for (const entry of entries) await collect(entry);
    for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
      await fsApi.promises.mkdir(directory, { recursive: true });
    }
    return { canceled: false, tasks: fileTransferManager.enqueueDownloads(sessionId, [...requests.values()]) };
  });
  ipcMain.handle("file-transfers:cancel", (_event, { id }) => fileTransferManager.cancel(id));
  ipcMain.handle("file-transfers:retry", (_event, { id }) => fileTransferManager.retry(id));
  ipcMain.handle("file-transfers:resolve-conflict", (_event, { id, policy }) => fileTransferManager.resolveConflict(id, policy));
  ipcMain.handle("file-transfers:clear", (_event, { id }) => fileTransferManager.clear(id));
}

module.exports = {
  getDownloadFileName,
  registerRemoteFileIpcHandlers,
  sanitizeLocalPaths
};
