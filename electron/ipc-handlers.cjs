const { ipcMain } = require("electron");
const fs = require("node:fs");

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

function registerIpcHandlers({ terminalManager, sessionStore, configStore, windowManager, clipboard, dialog, remoteFileService, remoteSystemService, hookConfigManager, remoteHookConfigService }) {
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

  ipcMain.handle("remote-system:metrics", (_event, { sessionId }) => {
    return remoteSystemService.getMetrics(sessionId);
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
