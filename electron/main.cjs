const path = require("node:path");
const { app, BrowserWindow, clipboard } = require("electron");
const { createClaudeHookServer } = require("./claude-hook-server.cjs");
const { registerIpcHandlers } = require("./ipc-handlers.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createTerminalManager, getDefaultShell, getWslShell } = require("./terminal-manager.cjs");
const { createWindowManager } = require("./window-manager.cjs");

let windowManager = null;
let sessionStore = null;
let terminalManager = null;
let claudeHookServer = null;

app.whenReady().then(() => {
  windowManager = createWindowManager();
  sessionStore = createSessionStore({
    sessionsFile: path.join(app.getPath("userData"), "sessions.json"),
    getDefaultShell,
    getWslShell
  });
  terminalManager = createTerminalManager({
    sessionStore,
    broadcast: windowManager.broadcast,
    getHookUrl: () => claudeHookServer ? claudeHookServer.getHookUrl() : ""
  });
  claudeHookServer = createClaudeHookServer({ terminalManager });

  sessionStore.loadLibrary();
  claudeHookServer.start();
  registerIpcHandlers({
    terminalManager,
    sessionStore,
    windowManager,
    clipboard
  });
  windowManager.createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (sessionStore) {
    sessionStore.saveLibrary();
  }
  if (terminalManager) {
    terminalManager.shutdown();
  }
  if (claudeHookServer) {
    claudeHookServer.stop();
  }
  if (windowManager) {
    windowManager.closeWindowManager();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
