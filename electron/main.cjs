const path = require("node:path");
const { Readable } = require("node:stream");
const { app, BrowserWindow, clipboard, dialog, Notification, protocol, safeStorage, shell } = require("electron");
const { createListenerAgentCli } = require("./agents/listener-agent-cli.cjs");
const { createListenerAgentManager } = require("./agents/listener-agent-manager.cjs");
const { createListenerAgentStore } = require("./agents/listener-agent-store.cjs");
const { registerIpcHandlers } = require("./core/ipc-handlers.cjs");
const { createWindowManager } = require("./core/window-manager.cjs");
const { createAgentHookServer } = require("./hooks/agent-hook-server.cjs");
const { createAgentSessionLauncher } = require("./hooks/agent-session-launcher.cjs");
const { createHookConfigManager } = require("./hooks/hook-config-manager.cjs");
const { createRemoteHookConfigService } = require("./hooks/remote-hook-config-service.cjs");
const { createAgentNotificationManager } = require("./notifications/agent-notification-manager.cjs");
const { createDingTalkNotificationManager } = require("./notifications/ding-talk-notification-manager.cjs");
const { createClipboardImageService } = require("./services/clipboard-image-service.cjs");
const { createGitStatusService } = require("./services/git-status-service.cjs");
const { createProjectSearchService } = require("./services/project-search-service.cjs");
const { MEDIA_PROTOCOL, createRemoteFileService } = require("./services/remote-file-service.cjs");
const { createRemoteSystemService } = require("./services/remote-system-service.cjs");
const { createSshHookTunnelService } = require("./ssh/ssh-hook-tunnel-service.cjs");
const { createSshSessionRuntime } = require("./ssh/ssh-session-runtime.cjs");
const { createConfigStore } = require("./stores/config-store.cjs");
const { createDingTalkConfigStore } = require("./stores/ding-talk-config-store.cjs");
const { createKnownHostStore } = require("./stores/known-host-store.cjs");
const { createSessionStore } = require("./stores/session-store.cjs");
const { createTerminalManager, getDefaultShell, getWslShell } = require("./terminal/terminal-manager.cjs");

let windowManager = null;
let sessionStore = null;
let configStore = null;
let dingTalkConfigStore = null;
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
let agentSessionLauncher = null;
let dingTalkNotificationManager = null;
let gitStatusService = null;
let projectSearchService = null;
let clipboardImageService = null;
let listenerAgentStore = null;
let listenerAgentManager = null;

protocol.registerSchemesAsPrivileged([{
  scheme: MEDIA_PROTOCOL,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true
  }
}]);

function registerMediaPreviewProtocol() {
  protocol.registerStreamProtocol(MEDIA_PROTOCOL, (request, callback) => {
    try {
      if (!remoteFileService) {
        throw new Error("Media preview service is not available.");
      }
      const rangeHeader = request.headers?.Range || request.headers?.range;
      callback(remoteFileService.createPreviewStreamResponse(request.url, rangeHeader));
    } catch (err) {
      callback({
        statusCode: 404,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain",
          "Content-Length": "0"
        },
        data: Readable.from([])
      });
    }
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (windowManager) {
      windowManager.createWindow();
    }
  });

  app.whenReady().then(async () => {
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
      configFile: path.join(app.getPath("userData"), "config.json"),
      safeStorage
    });
    dingTalkConfigStore = createDingTalkConfigStore({
      configFile: path.join(app.getPath("userData"), "dingtalk.json"),
      safeStorage
    });
    knownHostStore = createKnownHostStore({
      knownHostsFile: path.join(app.getPath("userData"), "known-hosts.json")
    });
    hookConfigManager = createHookConfigManager();
    configStore.loadConfig();
    dingTalkConfigStore.loadConfig();
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
        if (dingTalkNotificationManager) {
          dingTalkNotificationManager.handleStatus(payload);
        }
      },
      onSessionClosed: (id) => {
        if (agentNotificationManager) {
          agentNotificationManager.clearSession(id);
        }
        if (dingTalkNotificationManager) {
          dingTalkNotificationManager.clearSession(id);
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
        if (listenerAgentManager) {
          void listenerAgentManager.syncAll();
        }
      }
    });
    agentNotificationManager = createAgentNotificationManager({
      Notification,
      windowManager,
      terminalManager
    });
    dingTalkNotificationManager = createDingTalkNotificationManager({
      configStore: dingTalkConfigStore,
      terminalManager
    });
    sshSessionRuntime = createSshSessionRuntime({
      terminalManager,
      sessionStore,
      knownHostStore
    });
    listenerAgentStore = createListenerAgentStore({
      historyFile: path.join(app.getPath("userData"), "listener-agent-history.json")
    });
    listenerAgentStore.load();
    remoteFileService = createRemoteFileService({
      terminalManager,
      sessionStore,
      knownHostStore,
      sshSessionRuntime,
      shellApi: shell
    });
    registerMediaPreviewProtocol();
    clipboardImageService = createClipboardImageService({
      clipboard,
      terminalManager,
      remoteFileService
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
    agentSessionLauncher = createAgentSessionLauncher({
      terminalManager,
      hookConfigManager,
      remoteHookConfigService,
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
      terminalManager,
      remoteFileService
    });

    listenerAgentManager = createListenerAgentManager({
      terminalManager,
      sessionStore,
      historyStore: listenerAgentStore,
      cli: createListenerAgentCli({ sshSessionRuntime }),
      sshSessionRuntime,
      broadcast: windowManager.broadcast
    });

    sessionStore.loadLibrary();
    await agentHookServer.start();
    registerIpcHandlers({
      terminalManager,
      agentSessionLauncher,
      sessionStore,
      configStore,
      dingTalkConfigStore,
      dingTalkNotificationManager,
      windowManager,
      clipboard,
      clipboardImageService,
      dialog,
      remoteFileService,
      remoteSystemService,
      hookConfigManager,
      remoteHookConfigService,
      gitStatusService,
      projectSearchService,
      listenerAgentManager
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
  if (listenerAgentManager) {
    listenerAgentManager.shutdown();
  }
  if (windowManager) {
    windowManager.closeWindowManager();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
