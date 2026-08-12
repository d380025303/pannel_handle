const path = require("node:path");
const { Readable } = require("node:stream");
const { app, BrowserWindow, clipboard, dialog, Notification, protocol, safeStorage, shell } = require("electron");
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
const { createCompletionService } = require("./services/completion-service.cjs");
const { createMobileRemoteService } = require("./services/mobile-remote-service.cjs");
const { createTerminalStateHub } = require("./services/terminal-state-hub.cjs");
const { MEDIA_PROTOCOL, createRemoteFileService } = require("./services/remote-file-service.cjs");
const { createFileTransferManager } = require("./services/file-transfer-manager.cjs");
const { createFileWatchManager } = require("./services/file-watch-manager.cjs");
const { createRemoteSystemService } = require("./services/remote-system-service.cjs");
const { createSshHookTunnelService } = require("./ssh/ssh-hook-tunnel-service.cjs");
const { createSshSessionRuntime } = require("./ssh/ssh-session-runtime.cjs");
const { createConfigStore } = require("./stores/config-store.cjs");
const { createCompletionConfigStore } = require("./stores/completion-config-store.cjs");
const { createCompletionMetricsStore } = require("./stores/completion-metrics-store.cjs");
const { createDingTalkConfigStore } = require("./stores/ding-talk-config-store.cjs");
const { createKnownHostStore } = require("./stores/known-host-store.cjs");
const { createMobileAccessStore } = require("./stores/mobile-access-store.cjs");
const { createSessionStore } = require("./stores/session-store.cjs");
const { createTerminalManager, getDefaultShell, getWslShell } = require("./terminal/terminal-manager.cjs");

let windowManager = null;
let sessionStore = null;
let configStore = null;
let completionConfigStore = null;
let completionMetricsStore = null;
let dingTalkConfigStore = null;
let knownHostStore = null;
let terminalManager = null;
let agentHookServer = null;
let remoteFileService = null;
let fileTransferManager = null;
let fileWatchManager = null;
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
let completionService = null;
let mobileAccessStore = null;
let mobileRemoteService = null;
let terminalStateHub = null;

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
    completionConfigStore = createCompletionConfigStore({
      configFile: path.join(app.getPath("userData"), "completion.json"),
      safeStorage
    });
    completionMetricsStore = createCompletionMetricsStore({
      metricsFile: path.join(app.getPath("userData"), "completion-metrics.json")
    });
    dingTalkConfigStore = createDingTalkConfigStore({
      configFile: path.join(app.getPath("userData"), "dingtalk.json"),
      safeStorage
    });
    knownHostStore = createKnownHostStore({
      knownHostsFile: path.join(app.getPath("userData"), "known-hosts.json")
    });
    mobileAccessStore = createMobileAccessStore({
      accessFile: path.join(app.getPath("userData"), "mobile-access.json"),
      safeStorage
    });
    hookConfigManager = createHookConfigManager();
    configStore.loadConfig();
    completionConfigStore.loadConfig();
    completionMetricsStore.load();
    dingTalkConfigStore.loadConfig();
    knownHostStore.loadKnownHosts();
    mobileAccessStore.load();
    terminalStateHub = createTerminalStateHub({ scrollback: 5000 });
    const broadcast = (channel, payload) => {
      windowManager.broadcast(channel, payload);
      if (mobileRemoteService) {
        mobileRemoteService.handleTerminalEvent(channel, payload);
      }
    };
    terminalManager = createTerminalManager({
      sessionStore,
      configStore,
      broadcast,
      getHookUrl: () => agentHookServer ? agentHookServer.getHookUrl() : "",
      knownHostStore,
      onAgentStatusChanged: (payload) => {
        if (completionService) {
          completionService.recordAgentStatus(payload);
        }
        if (agentNotificationManager) {
          agentNotificationManager.handleStatus(payload);
        }
        if (dingTalkNotificationManager) {
          dingTalkNotificationManager.handleStatus(payload);
        }
      },
      onSessionClosed: (id) => {
        if (completionService) {
          completionService.clearSession(id);
        }
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
    remoteFileService = createRemoteFileService({
      terminalManager,
      sessionStore,
      knownHostStore,
      sshSessionRuntime,
      shellApi: shell
    });
    fileTransferManager = createFileTransferManager({
      remoteFileService,
      broadcast: windowManager.broadcast
    });
    fileWatchManager = createFileWatchManager({ terminalManager, broadcast: windowManager.broadcast });
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
    mobileRemoteService = createMobileRemoteService({
      terminalManager,
      agentSessionLauncher,
      sessionStore,
      accessStore: mobileAccessStore,
      stateHub: terminalStateHub,
      getStaticRoot: () => app.isPackaged
        ? path.join(process.resourcesPath, "mobile")
        : path.resolve(__dirname, "..", "mobile", "dist"),
      desktopBroadcast: windowManager.broadcast,
      confirmPairing: async ({ deviceName, verificationCode }) => {
        const result = await dialog.showMessageBox(windowManager.focusWindow(), {
          type: "question",
          buttons: ["允许", "拒绝"],
          defaultId: 0,
          cancelId: 1,
          title: "移动设备配对",
          message: `允许“${deviceName}”控制终端吗？`,
          detail: `请核对手机上的校验码：${verificationCode}\n\n移动访问使用局域网 HTTP 明文连接。`
        });
        return result.response === 0;
      },
      notifyConnection: (device) => {
        if (Notification.isSupported()) {
          new Notification({
            title: "移动终端已连接",
            body: `${device.name} 已连接到 Pannel Handle`,
            silent: true
          }).show();
        }
      }
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
    completionService = createCompletionService({
      configStore: completionConfigStore,
      terminalManager,
      metricsStore: completionMetricsStore,
      isDebugEnabled: () => configStore.getConfig().debugMode,
      broadcastDebug: (payload) => windowManager.broadcast("completion:debug", payload)
    });

    sessionStore.loadLibrary();
    await agentHookServer.start();
    await mobileRemoteService.start().catch((err) => console.error("Failed to start mobile access:", err));
    registerIpcHandlers({
      terminalManager,
      agentSessionLauncher,
      sessionStore,
      configStore,
      completionConfigStore,
      completionMetricsStore,
      completionService,
      dingTalkConfigStore,
      dingTalkNotificationManager,
      windowManager,
      clipboard,
      clipboardImageService,
      dialog,
      remoteFileService,
      fileTransferManager,
      fileWatchManager,
      remoteSystemService,
      hookConfigManager,
      remoteHookConfigService,
      gitStatusService,
      projectSearchService,
      mobileRemoteService
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
  if (fileTransferManager) {
    void fileTransferManager.shutdown();
  }
  if (remoteFileService) {
    void remoteFileService.shutdown();
  }
  if (fileWatchManager) {
    void fileWatchManager.shutdown();
  }
  if (remoteSystemService) {
    void remoteSystemService.shutdown();
  }
  if (gitStatusService) {
    gitStatusService.shutdown();
  }
  if (sshHookTunnelService) {
    void sshHookTunnelService.shutdown();
  }
  if (agentHookServer) {
    agentHookServer.stop();
  }
  if (mobileRemoteService) {
    void mobileRemoteService.stop();
  }
  if (terminalStateHub) {
    terminalStateHub.shutdown();
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
