const path = require("node:path");
const { app, BrowserWindow, clipboard, dialog, Notification, safeStorage, shell } = require("electron");
const { createAgentNotificationManager } = require("./agent-notification-manager.cjs");
const { createAgentHookServer } = require("./agent-hook-server.cjs");
const { createConfigStore } = require("./config-store.cjs");
const { createGitStatusService } = require("./git-status-service.cjs");
const { createHookConfigManager } = require("./hook-config-manager.cjs");
const { registerIpcHandlers } = require("./ipc-handlers.cjs");
const { createKnownHostStore } = require("./known-host-store.cjs");
const { createProjectSearchService } = require("./project-search-service.cjs");
const { createRemoteFileService } = require("./remote-file-service.cjs");
const { createRemoteHookConfigService } = require("./remote-hook-config-service.cjs");
const { createRemoteSystemService } = require("./remote-system-service.cjs");
const { createSessionStore } = require("./session-store.cjs");
const { createSshHookTunnelService } = require("./ssh-hook-tunnel-service.cjs");
const { createSshSessionRuntime } = require("./ssh-session-runtime.cjs");
const { createTerminalManager, getDefaultShell, getWslShell } = require("./terminal-manager.cjs");
const { createWindowManager } = require("./window-manager.cjs");

let windowManager = null;
let sessionStore = null;
let configStore = null;
let knownHostStore = null;
let terminalManager = null;
let agentHookServer = null;
let remoteFileService = null;
let remoteSystemService = null;
let sshHookTunnelService = null;
let sshSessionRuntime = null;
let remoteHookConfigService = null;
let hookConfigManager = null;
let agentNotificationManager = null;
let gitStatusService = null;
let projectSearchService = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (windowManager) {
      windowManager.createWindow();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === "win32") {
      app.setAppUserModelId("local.pannel-handle");
    }
    windowManager = createWindowManager();
    sessionStore = createSessionStore({
      sessionsFile: path.join(app.getPath("userData"), "sessions.json"),
      getDefaultShell,
      getWslShell,
      safeStorage
    });
    configStore = createConfigStore({
      configFile: path.join(app.getPath("userData"), "config.json")
    });
    knownHostStore = createKnownHostStore({
      knownHostsFile: path.join(app.getPath("userData"), "known-hosts.json")
    });
    hookConfigManager = createHookConfigManager();
    configStore.loadConfig();
    knownHostStore.loadKnownHosts();
    terminalManager = createTerminalManager({
      sessionStore,
      configStore,
      broadcast: windowManager.broadcast,
      getHookUrl: () => agentHookServer ? agentHookServer.getHookUrl() : "",
      knownHostStore,
      onAgentStatusChanged: (payload) => {
        if (agentNotificationManager) {
          agentNotificationManager.handleStatus(payload);
        }
      },
      onSessionClosed: (id) => {
        if (agentNotificationManager) {
          agentNotificationManager.clearSession(id);
        }
        if (remoteFileService) {
          void remoteFileService.disconnect(id);
        }
        if (remoteSystemService) {
          void remoteSystemService.disconnect(id);
        }
        if (sshHookTunnelService) {
          void sshHookTunnelService.disconnect(id);
        }
      }
    });
    agentNotificationManager = createAgentNotificationManager({
      Notification,
      windowManager,
      terminalManager
    });
    sshSessionRuntime = createSshSessionRuntime({
      terminalManager,
      sessionStore,
      knownHostStore
    });
    remoteFileService = createRemoteFileService({
      terminalManager,
      sessionStore,
      knownHostStore,
      sshSessionRuntime,
      shellApi: shell
    });
    remoteSystemService = createRemoteSystemService({
      terminalManager,
      sessionStore,
      knownHostStore,
      sshSessionRuntime
    });
    agentHookServer = createAgentHookServer({ terminalManager });
    sshHookTunnelService = createSshHookTunnelService({
      terminalManager,
      sessionStore,
      knownHostStore,
      sshSessionRuntime,
      getLocalHookPort: () => agentHookServer ? agentHookServer.getHookPort() : undefined
    });
    remoteHookConfigService = createRemoteHookConfigService({
      terminalManager,
      sessionStore,
      knownHostStore,
      sshSessionRuntime,
      sshHookTunnelService
    });
    gitStatusService = createGitStatusService({
      terminalManager,
      sessionStore,
      knownHostStore,
      sshSessionRuntime
    });
    projectSearchService = createProjectSearchService({
      terminalManager
    });

    sessionStore.loadLibrary();
    agentHookServer.start();
    registerIpcHandlers({
      terminalManager,
      sessionStore,
      configStore,
      windowManager,
      clipboard,
      dialog,
      remoteFileService,
      remoteSystemService,
      hookConfigManager,
      remoteHookConfigService,
      gitStatusService,
      projectSearchService
    });
    windowManager.createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager.createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (configStore) {
    configStore.saveConfig();
  }
  if (sessionStore) {
    sessionStore.saveLibrary();
  }
  if (terminalManager) {
    terminalManager.shutdown();
  }
  if (remoteFileService) {
    void remoteFileService.shutdown();
  }
  if (remoteSystemService) {
    void remoteSystemService.shutdown();
  }
  if (sshHookTunnelService) {
    void sshHookTunnelService.shutdown();
  }
  if (agentHookServer) {
    agentHookServer.stop();
  }
  if (agentNotificationManager) {
    agentNotificationManager.shutdown();
  }
  if (windowManager) {
    windowManager.closeWindowManager();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
