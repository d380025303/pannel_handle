const { ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { VALID_LOCALES, VALID_THEME_IDS } = require("./config-store.cjs");

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
    throw new Error("No local files were provided.");
  }
  return paths;
}

function getDownloadFileName(fileName, remotePath) {
  const fallback = path.posix.basename(String(remotePath || "download").replace(/\\/g, "/")) || "download";
  const rawName = String(fileName || fallback).trim() || fallback;
  const baseName = path.basename(rawName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return baseName || "download";
}

function registerIpcHandlers({ terminalManager, sessionStore, configStore, windowManager, clipboard, clipboardImageService, dialog, remoteFileService, remoteSystemService, hookConfigManager, remoteHookConfigService, gitStatusService, projectSearchService }) {
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

  ipcMain.handle("sessions:launch-selected", (_event, sessionsToLaunch) => {
    return terminalManager.launchSessions(sessionsToLaunch);
  });

  ipcMain.handle("sessions:delete-saved", (_event, id) => {
    return terminalManager.deleteSavedSession(id);
  });

  ipcMain.handle("sessions:reorder", (_event, orderedIds) => {
    return terminalManager.reorderSavedSessions(orderedIds);
  });

  ipcMain.handle("sessions:reorder-running", (_event, orderedIds) => {
    return terminalManager.reorderRunningSessions(orderedIds);
  });

  ipcMain.handle("wsl:list-distros", () => terminalManager.listWslDistros());

  ipcMain.handle("sessions:create", (_event, options) => terminalManager.createSession(options));

  ipcMain.handle("sessions:rename", (_event, { id, title }) => {
    return terminalManager.renameSession(id, title);
  });

  ipcMain.handle("sessions:update", (_event, { id, title, cwd, initialCommand, sshConfig, quickCommands, tags }) => {
    return terminalManager.updateSession(id, { title, cwd, initialCommand, sshConfig, quickCommands, tags });
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
    terminalManager.resize(id, cols, rows);
  });

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

  ipcMain.handle("remote-files:write-text", (_event, { sessionId, remotePath, content, expectedVersion }) => {
    return remoteFileService.writeText(sessionId, remotePath, content, expectedVersion);
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

  ipcMain.handle("remote-files:download-file", async (event, { sessionId, remotePath, fileName }) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showSaveDialog(ownerWindow, {
      defaultPath: fileName || "download"
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    const downloaded = await remoteFileService.downloadFile(sessionId, remotePath, result.filePath);
    return { canceled: false, ...downloaded };
  });

  ipcMain.handle("remote-files:start-download-drag", async (event, { sessionId, remotePath, fileName }) => {
    const tempRoot = path.join(os.tmpdir(), "pannel-handle-drag-downloads");
    await fs.promises.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.promises.mkdtemp(path.join(tempRoot, "drag-"));
    const localPath = path.join(tempDir, getDownloadFileName(fileName, remotePath));
    const downloaded = await remoteFileService.downloadFile(sessionId, remotePath, localPath);
    event.sender.startDrag({
      file: downloaded.localPath,
      icon: path.join(__dirname, "..", "build", "icon.png")
    });
    return { canceled: false, ...downloaded };
  });

  ipcMain.handle("remote-files:open-in-explorer", (_event, { sessionId, remotePath }) => {
    return remoteFileService.openInExplorer(sessionId, remotePath);
  });

  ipcMain.handle("remote-system:metrics", (_event, { sessionId }) => {
    return remoteSystemService.getMetrics(sessionId);
  });

  ipcMain.handle("git:status", (_event, { sessionId }) => {
    return gitStatusService.getStatus(sessionId);
  });

  ipcMain.handle("git:diff", (_event, { sessionId, file }) => {
    return gitStatusService.getDiff(sessionId, file);
  });

  ipcMain.handle("git:branches", (_event, { sessionId }) => {
    return gitStatusService.getBranches(sessionId);
  });

  ipcMain.handle("git:checkout-branch", (_event, { sessionId, branch }) => {
    return gitStatusService.checkoutBranch(sessionId, branch);
  });

  ipcMain.handle("git:stashes", (_event, { sessionId }) => {
    return gitStatusService.getStashes(sessionId);
  });

  ipcMain.handle("git:stash-changes", (_event, { sessionId }) => {
    return gitStatusService.stashChanges(sessionId);
  });

  ipcMain.handle("git:apply-stash", (_event, { sessionId, ref }) => {
    return gitStatusService.applyStash(sessionId, ref);
  });

  ipcMain.handle("git:pop-stash", (_event, { sessionId, ref }) => {
    return gitStatusService.popStash(sessionId, ref);
  });

  ipcMain.handle("git:revert-file", (_event, { sessionId, file }) => {
    return gitStatusService.revertFile(sessionId, file);
  });

  ipcMain.handle("project-search:files", (_event, { sessionId, query }) => {
    return projectSearchService.searchFiles(sessionId, query);
  });

  ipcMain.handle("project-search:text", (_event, { sessionId, query, requestId }) => {
    return projectSearchService.searchText(sessionId, query, requestId);
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
    if (Object.keys(updates).length > 0) {
      configStore.updateConfig(updates);
    }
    return configStore.getConfig();
  });

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
    const window = windowManager.getWindowFromEvent(event);
    if (window) {
      window.close();
    }
  });
}

module.exports = {
  registerIpcHandlers
};
