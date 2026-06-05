const { ipcMain } = require("electron");

function registerIpcHandlers({ terminalManager, sessionStore, configStore, windowManager, clipboard }) {
  ipcMain.handle("sessions:list", () => terminalManager.listSessions());

  ipcMain.handle("sessions:load-saved", () => sessionStore.getLibrary());

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

  ipcMain.handle("sessions:update", (_event, { id, title, initialCommand, sshConfig, quickCommands }) => {
    return terminalManager.updateSession(id, { title, initialCommand, sshConfig, quickCommands });
  });

  ipcMain.handle("sessions:close", (_event, id) => terminalManager.closeSession(id));

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
