const path = require("node:path");
const { app, BrowserWindow, clipboard, safeStorage } = require("electron");
const { createAgentHookServer } = require("./agent-hook-server.cjs");
const { registerIpcHandlers } = require("./ipc-handlers.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createTerminalManager, getDefaultShell, getWslShell } = require("./terminal-manager.cjs");
const { createWindowManager } = require("./window-manager.cjs");

let windowManager = null;
let sessionStore = null;
let terminalManager = null;
let agentHookServer = null;

app.whenReady().then(() => {
  windowManager = createWindowManager();
  sessionStore = createSessionStore({
    sessionsFile: path.join(app.getPath("userData"), "sessions.json"),
    getDefaultShell,
    getWslShell,
    safeStorage
  });
  terminalManager = createTerminalManager({
    sessionStore,
    broadcast: windowManager.broadcast,
    getHookUrl: () => agentHookServer ? agentHookServer.getHookUrl() : ""
  });
  agentHookServer = createAgentHookServer({ terminalManager });

  sessionStore.loadLibrary();
  agentHookServer.start();
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
  if (agentHookServer) {
    agentHookServer.stop();
  }
  if (windowManager) {
    windowManager.closeWindowManager();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
