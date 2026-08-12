const { ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
  MAX_AGENT_OUTPUT_MAX_BYTES,
  MIN_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
  MIN_AGENT_OUTPUT_MAX_BYTES,
  VALID_LOCALES,
  VALID_THEME_IDS,
  isIntegerInRange
} = require("../stores/config-store.cjs");

function getImportedSessions(input) {
  const parsed = JSON.parse(input);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.sessions)) {
    return parsed.sessions;
  }
  throw new Error("Imported file must contain a sessions array.");
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
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

function getDownloadFileName(fileName, remotePath) {
  const fallback = path.posix.basename(String(remotePath || "download").replace(/\\/g, "/")) || "download";
  const rawName = String(fileName || fallback).trim() || fallback;
  const baseName = path.basename(rawName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return baseName || "download";
}

function registerIpcHandlers({ terminalManager, agentSessionLauncher, sessionStore, launchTemplateStore, launchTemplateService, configStore, dingTalkConfigStore, dingTalkNotificationManager, windowManager, clipboard, clipboardImageService, dialog, remoteFileService, fileTransferManager, fileWatchManager, remoteSystemService, agentUsageService, hookConfigManager, remoteHookConfigService, gitStatusService, projectSearchService, mobileRemoteService }) {
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
    } catch (err) {
      const canceled = err?.code === "DOWNLOAD_CANCELED";
      if (!event.sender.isDestroyed()) {
        event.sender.send("remote-files:download-progress", {
          transferId: id,
          sessionId,
          remotePath,
          fileName,
          status: canceled ? "canceled" : "failed",
          error: canceled ? undefined : getErrorMessage(err)
        });
      }
      if (canceled) return { canceled: true, transferId: id };
      throw err;
    } finally {
      event.sender.removeListener("destroyed", cancelWhenDestroyed);
      downloadOwners.delete(id);
    }
  }

  ipcMain.handle("sessions:list", () => terminalManager.listSessions());

  ipcMain.handle("sessions:load-saved", () => sessionStore.getLibrary());

  ipcMain.handle("sessions:export-library", async (event) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showSaveDialog(ownerWindow, {
      defaultPath: "pannel-handle-sessions.json",
      filters: [
        { name: "JSON", extensions: ["json"] }
      ]
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    try {
      const payload = {
        schemaVersion: 1,
        exportedAt: Date.now(),
        source: "pannel-handle",
        sessions: sessionStore.exportLibrary({ includeEncryptedSecrets: true })
      };
      fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf-8");
      return {
        canceled: false,
        ok: true,
        filePath: result.filePath,
        exportedCount: payload.sessions.length
      };
    } catch (err) {
      console.error("Failed to export session library:", err);
      return {
        canceled: false,
        ok: false,
        error: getErrorMessage(err)
      };
    }
  });

  ipcMain.handle("sessions:import-library", async (event) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, {
      properties: ["openFile"],
      filters: [
        { name: "JSON", extensions: ["json"] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    try {
      const raw = fs.readFileSync(result.filePaths[0], "utf-8");
      const importedSessions = getImportedSessions(raw);
      const imported = sessionStore.importLibrary(importedSessions);
      return {
        canceled: false,
        ok: true,
        filePath: result.filePaths[0],
        importedCount: imported.importedCount,
        sessions: imported.sessions
      };
    } catch (err) {
      console.error("Failed to import session library:", err);
      return {
        canceled: false,
        ok: false,
        error: getErrorMessage(err)
      };
    }
  });

  ipcMain.handle("sessions:launch-selected", async (_event, sessionsToLaunch, launchMode) => {
    return agentSessionLauncher.launchSessions(sessionsToLaunch, { recordUsage: launchMode === "manual" });
  });

  ipcMain.handle("launch-templates:list", () => launchTemplateStore.getAll());

  ipcMain.handle("launch-templates:create", (_event, input) => launchTemplateStore.create(input));

  ipcMain.handle("launch-templates:update", (_event, id, input) => launchTemplateStore.update(String(id || ""), input));

  ipcMain.handle("launch-templates:delete", (_event, id) => launchTemplateStore.remove(String(id || "")));

  ipcMain.handle("launch-templates:launch", (_event, id) => launchTemplateService.launch(String(id || "")));

  ipcMain.handle("sessions:delete-saved", (_event, id) => {
    return terminalManager.deleteSavedSession(id);
  });

  ipcMain.handle("sessions:duplicate", (_event, id) => {
    return terminalManager.duplicateSavedSession(id);
  });

  ipcMain.handle("sessions:reorder-running", (_event, orderedIds) => {
    return terminalManager.reorderRunningSessions(orderedIds);
  });

  ipcMain.handle("wsl:list-distros", () => terminalManager.listWslDistros());

  ipcMain.handle("sessions:create", async (_event, options) => {
    return agentSessionLauncher.createSession(options);
  });

  ipcMain.handle("sessions:rename", (_event, { id, title }) => {
    return terminalManager.renameSession(id, title);
  });

  ipcMain.handle("sessions:update", async (_event, { id, title, cwd, initialCommand, agentProvider, sshConfig, quickCommands, tags }) => {
    return terminalManager.updateSession(id, { title, cwd, initialCommand, agentProvider, sshConfig, quickCommands, tags });
  });

  ipcMain.handle("sessions:close", async (_event, id) => {
    const sessions = terminalManager.closeSession(id);
    if (remoteFileService) {
      await remoteFileService.disconnect(id);
    }
    if (remoteSystemService) {
      await remoteSystemService.disconnect(id);
    }
    return sessions;
  });

  ipcMain.handle("terminal:history", (_event, id) => terminalManager.getHistory(id));

  ipcMain.handle("clipboard:write-text", (_event, text) => {
    if (typeof text !== "string" || text.length === 0) {
      return false;
    }

    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle("clipboard:read-text", () => {
    return clipboard.readText();
  });

  ipcMain.handle("clipboard:paste-image-to-session", (_event, sessionId) => {
    return clipboardImageService.pasteImageToSession(sessionId);
  });

  ipcMain.on("terminal:write", (_event, { id, data }) => {
    terminalManager.write(id, data);
  });

  ipcMain.on("terminal:resize", (_event, { id, cols, rows }) => {
    if (mobileRemoteService) mobileRemoteService.resizeFromDesktop(id, cols, rows);
    else terminalManager.resize(id, cols, rows);
  });

  ipcMain.on("terminal:claim-size", (_event, { id, cols, rows }) => {
    if (mobileRemoteService) mobileRemoteService.claimDesktopSize(id, cols, rows);
    else terminalManager.resize(id, cols, rows);
  });

  ipcMain.handle("mobile-access:get-state", () => mobileRemoteService.getState());
  ipcMain.handle("mobile-access:update-config", (_event, partial) => mobileRemoteService.updateConfig(partial));
  ipcMain.handle("mobile-access:create-pairing", () => mobileRemoteService.createPairing());
  ipcMain.handle("mobile-access:list-audit", () => mobileRemoteService.listAudit());
  ipcMain.handle("mobile-access:revoke-device", (_event, deviceId) => mobileRemoteService.revokeDevice(deviceId));
  ipcMain.handle("mobile-access:disconnect-device", () => mobileRemoteService.disconnectActiveDevice());

  ipcMain.handle("remote-files:home", (_event, { sessionId }) => {
    return remoteFileService.getHome(sessionId);
  });

  ipcMain.handle("remote-files:list", (_event, { sessionId, remotePath }) => {
    return remoteFileService.list(sessionId, remotePath);
  });

  ipcMain.handle("remote-files:read-text", (_event, { sessionId, remotePath }) => {
    return remoteFileService.readText(sessionId, remotePath);
  });

  ipcMain.handle("remote-files:preview-file", (_event, { sessionId, remotePath }) => {
    return remoteFileService.previewFile(sessionId, remotePath);
  });

  ipcMain.handle("remote-files:release-preview", (_event, { previewId }) => {
    return remoteFileService.releasePreview(previewId);
  });

  ipcMain.handle("remote-files:write-text", (_event, { sessionId, remotePath, content, expectedVersion, options }) => {
    return remoteFileService.writeText(sessionId, remotePath, content, expectedVersion, options);
  });

  ipcMain.handle("remote-files:create", (_event, { sessionId, parentPath, name, kind, conflictPolicy }) => {
    return remoteFileService.createEntry(sessionId, parentPath, name, kind, conflictPolicy);
  });

  ipcMain.handle("remote-files:move", (_event, { sessionId, sourcePath, targetDirectory, name, conflictPolicy }) => {
    return remoteFileService.moveEntry(sessionId, sourcePath, targetDirectory, name, conflictPolicy);
  });

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
    const result = await dialog.showOpenDialog(ownerWindow, {
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const uploaded = await remoteFileService.uploadFile(sessionId, result.filePaths[0], remoteDir);
    return { canceled: false, ...uploaded };
  });

  ipcMain.handle("remote-files:upload-files", async (_event, { sessionId, remoteDir, localPaths }) => {
    const uploaded = await remoteFileService.uploadFiles(sessionId, sanitizeLocalPaths(localPaths), remoteDir);
    return { canceled: false, uploaded };
  });

  ipcMain.handle("remote-files:download-file", async (event, { transferId, sessionId, remotePath, fileName }) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showSaveDialog(ownerWindow, {
      defaultPath: fileName || "download"
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    return runDownload(event, { transferId, sessionId, remotePath, localPath: result.filePath, fileName });
  });

  ipcMain.handle("remote-files:start-download-drag", async (event, { transferId, sessionId, remotePath, fileName }) => {
    const tempRoot = path.join(os.tmpdir(), "pannel-handle-drag-downloads");
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.promises.mkdtemp(path.join(tempRoot, "drag-"));
    const localPath = path.join(tempDir, getDownloadFileName(fileName, remotePath));
    const downloaded = await runDownload(event, { transferId, sessionId, remotePath, localPath, fileName });
    if (downloaded.canceled) return downloaded;
    event.sender.startDrag({
      file: downloaded.localPath,
      icon: path.join(__dirname, "..", "..", "build", "icon.png")
    });
    return { canceled: false, ...downloaded };
  });

  ipcMain.handle("remote-files:cancel-download", (event, { transferId }) => {
    const id = String(transferId || "");
    if (downloadOwners.get(id) !== event.sender.id) return false;
    return remoteFileService.cancelDownload(id);
  });

  ipcMain.handle("remote-files:open-in-explorer", (_event, { sessionId, remotePath }) => {
    return remoteFileService.openInExplorer(sessionId, remotePath);
  });

  ipcMain.handle("remote-files:delete", (_event, { sessionId, remotePath, options }) => {
    return remoteFileService.deleteEntry(sessionId, remotePath, options);
  });
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

  ipcMain.handle("file-transfers:cancel", (_event, { id }) => fileTransferManager.cancel(id));
  ipcMain.handle("file-transfers:retry", (_event, { id }) => fileTransferManager.retry(id));
  ipcMain.handle("file-transfers:resolve-conflict", (_event, { id, policy }) => fileTransferManager.resolveConflict(id, policy));
  ipcMain.handle("file-transfers:clear", (_event, { id }) => fileTransferManager.clear(id));

  ipcMain.handle("remote-system:metrics", (_event, { sessionId }) => {
    return remoteSystemService.getMetrics(sessionId);
  });

  ipcMain.handle("agent-usage:get", (_event, { sessionId, force }) => {
    return agentUsageService.getUsage(sessionId, { force: Boolean(force) });
  });

  ipcMain.on("agent-usage:cancel", (_event, { sessionId }) => {
    agentUsageService.disconnect(sessionId);
  });

  ipcMain.handle("git:status", (_event, { sessionId }) => {
    return gitStatusService.getStatus(sessionId);
  });

  ipcMain.handle("git:snapshot", (_event, { sessionId }) => {
    return gitStatusService.getSnapshot(sessionId);
  });

  ipcMain.handle("git:discover-repository", (_event, { sessionId }) => {
    return gitStatusService.discoverRepository(sessionId);
  });

  ipcMain.handle("git:choose-directory", async (event, { sessionId, currentDirectory }) => {
    const session = terminalManager.getSession(sessionId);
    if (!session || session.type !== "windows") return { canceled: true };
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, {
      defaultPath: currentDirectory || session.gitCwd || session.cwd,
      properties: ["openDirectory"]
    });
    return result.canceled || result.filePaths.length === 0
      ? { canceled: true }
      : { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("git:change-directory", (_event, { sessionId, cwd }) => {
    return gitStatusService.changeDirectory(sessionId, cwd);
  });

  ipcMain.handle("git:diff", (_event, { sessionId, request, file }) => {
    return gitStatusService.getDiff(sessionId, request || file);
  });

  ipcMain.handle("git:branches", (_event, { sessionId }) => {
    return gitStatusService.getBranches(sessionId);
  });

  ipcMain.handle("git:remotes", (_event, { sessionId }) => {
    return gitStatusService.getRemotes(sessionId);
  });

  ipcMain.handle("git:checkout-branch", (_event, { sessionId, branch, operationId }) => {
    return gitStatusService.checkoutBranch(sessionId, branch, operationId);
  });

  ipcMain.handle("git:create-branch", (_event, { sessionId, branchName, operationId }) => {
    return gitStatusService.createBranch(sessionId, branchName, operationId);
  });

  ipcMain.handle("git:stashes", (_event, { sessionId }) => {
    return gitStatusService.getStashes(sessionId);
  });

  ipcMain.handle("git:history", (_event, { sessionId, options }) => {
    return gitStatusService.getHistory(sessionId, options);
  });

  ipcMain.handle("git:stage-files", (_event, { sessionId, paths, operationId }) => {
    return gitStatusService.stageFiles(sessionId, paths, operationId);
  });

  ipcMain.handle("git:stage-all", (_event, { sessionId, operationId }) => {
    return gitStatusService.stageAll(sessionId, operationId);
  });

  ipcMain.handle("git:unstage-files", (_event, { sessionId, paths, operationId }) => {
    return gitStatusService.unstageFiles(sessionId, paths, operationId);
  });

  ipcMain.handle("git:unstage-all", (_event, { sessionId, operationId }) => {
    return gitStatusService.unstageAll(sessionId, operationId);
  });

  ipcMain.handle("git:discard-working-tree", (_event, { sessionId, file, operationId }) => {
    return gitStatusService.discardWorkingTree(sessionId, file, operationId);
  });

  ipcMain.handle("git:commit", (_event, { sessionId, message, operationId }) => {
    return gitStatusService.commit(sessionId, message, operationId);
  });

  ipcMain.handle("git:fetch", (_event, { sessionId, remote, operationId }) => {
    return gitStatusService.fetchRemote(sessionId, remote, operationId);
  });

  ipcMain.handle("git:pull", (_event, { sessionId, operationId }) => {
    return gitStatusService.pullBranch(sessionId, operationId);
  });

  ipcMain.handle("git:push", (_event, { sessionId, remote, operationId }) => {
    return gitStatusService.pushBranch(sessionId, remote, operationId);
  });

  ipcMain.handle("git:stash-changes", (_event, { sessionId, message, operationId }) => {
    return gitStatusService.stashChanges(sessionId, message, operationId);
  });

  ipcMain.handle("git:apply-stash", (_event, { sessionId, ref, operationId }) => {
    return gitStatusService.applyStash(sessionId, ref, operationId);
  });

  ipcMain.handle("git:pop-stash", (_event, { sessionId, ref, operationId }) => {
    return gitStatusService.popStash(sessionId, ref, operationId);
  });

  ipcMain.handle("git:drop-stash", (_event, { sessionId, ref, operationId }) => {
    return gitStatusService.dropStash(sessionId, ref, operationId);
  });

  ipcMain.handle("git:revert-file", (_event, { sessionId, file, operationId }) => {
    return gitStatusService.revertFile(sessionId, file, operationId);
  });

  ipcMain.handle("git:cancel-operation", (_event, { operationId }) => {
    return gitStatusService.cancelOperation(operationId);
  });

  ipcMain.handle("project-search:list-directories", (_event, { sessionId, rootPath }) => {
    return projectSearchService.listDirectories(sessionId, rootPath);
  });

  ipcMain.handle("project-search:files", (_event, { sessionId, query, rootPath, options }) => {
    return projectSearchService.searchFiles(sessionId, query, rootPath, options);
  });

  ipcMain.handle("project-search:workspace-entries", (_event, { sessionId, query, rootPath, options }) => {
    return projectSearchService.searchWorkspaceEntries(sessionId, query, rootPath, options);
  });

  ipcMain.handle("project-search:text", (_event, { sessionId, query, requestId, rootPath, options }) => {
    return projectSearchService.searchText(sessionId, query, requestId, rootPath, options);
  });

  ipcMain.handle("project-search:cancel-text", (_event, { sessionId, requestId }) => {
    return projectSearchService.cancelTextSearch(sessionId, requestId);
  });

  ipcMain.handle("hooks:select-project-directory", async (event, defaultPath) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, {
      defaultPath: typeof defaultPath === "string" ? defaultPath : undefined,
      properties: ["openDirectory"]
    });
    return result.canceled || result.filePaths.length === 0
      ? { canceled: true }
      : { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle("hooks:inspect", (_event, { target, providers }) => {
    if (target?.type === "ssh") {
      return remoteHookConfigService.inspect(target, providers);
    }
    return hookConfigManager.inspect(target, providers);
  });

  ipcMain.handle("hooks:install", (_event, { target, providers }) => {
    if (target?.type === "ssh") {
      return remoteHookConfigService.install(target, providers);
    }
    return hookConfigManager.install(target, providers);
  });

  ipcMain.handle("window:is-maximized", (event) => {
    const window = windowManager.getWindowFromEvent(event);
    return window ? window.isMaximized() : false;
  });

  ipcMain.handle("config:get", () => configStore.getConfig());

  ipcMain.handle("config:set", (_event, partial) => {
    const updates = {};
    if (partial && typeof partial.autoRestore === "boolean") {
      updates.autoRestore = partial.autoRestore;
    }
    if (partial && typeof partial.debugMode === "boolean") {
      updates.debugMode = partial.debugMode;
    }
    if (partial && typeof partial.themeId === "string" && VALID_THEME_IDS.has(partial.themeId)) {
      updates.themeId = partial.themeId;
    }
    if (partial && typeof partial.locale === "string" && VALID_LOCALES.has(partial.locale)) {
      updates.locale = partial.locale;
    }
    if (partial && typeof partial.rightToolsWidth === "number"
      && partial.rightToolsWidth >= 280 && partial.rightToolsWidth <= 600) {
      updates.rightToolsWidth = partial.rightToolsWidth;
    }
    if (partial && isIntegerInRange(
      partial.listenerAgentHistoryMaxEntries,
      MIN_AGENT_OUTPUT_HISTORY_MAX_ENTRIES,
      MAX_AGENT_OUTPUT_HISTORY_MAX_ENTRIES
    )) {
      updates.listenerAgentHistoryMaxEntries = partial.listenerAgentHistoryMaxEntries;
    }
    if (partial && isIntegerInRange(
      partial.listenerAgentOutputMaxBytes,
      MIN_AGENT_OUTPUT_MAX_BYTES,
      MAX_AGENT_OUTPUT_MAX_BYTES
    )) {
      updates.listenerAgentOutputMaxBytes = partial.listenerAgentOutputMaxBytes;
    }
    if (Object.keys(updates).length > 0) {
      configStore.updateConfig(updates);
    }
    return configStore.getConfig();
  });

  ipcMain.handle("dingtalk:get-config", () => dingTalkConfigStore.getConfig());

  ipcMain.handle("dingtalk:set-config", (_event, input) => {
    return dingTalkNotificationManager.updateConfig(input);
  });

  ipcMain.handle("dingtalk:clear-credentials", () => {
    return dingTalkNotificationManager.clearCredentials();
  });

  ipcMain.handle("dingtalk:test", () => dingTalkNotificationManager.testConnection());

  ipcMain.on("window:minimize", (event) => {
    const window = windowManager.getWindowFromEvent(event);
    if (window) {
      window.minimize();
    }
  });

  ipcMain.on("window:toggle-maximize", (event) => {
    const window = windowManager.getWindowFromEvent(event);
    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  ipcMain.on("window:close", (event) => {
    windowManager.requestClose();
  });
  ipcMain.on("window:resolve-close", (_event, confirmed) => windowManager.resolveClose(Boolean(confirmed)));
}

module.exports = {
  registerIpcHandlers
};
