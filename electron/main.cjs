const { createEnvironmentService } = require("./services/environment/index.cjs");
const path = require("node:path");
const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, Notification, protocol, safeStorage, shell } = require("electron");

if (process.argv.includes("--pannel-handle-qoder-activity-helper")) {
  void require("./services/token-usage/index.cjs").runQoderActivityHelper();
  return;
}

const { registerIpcHandlers } = require("./core/ipc-handlers.cjs");
const { createWindowManager } = require("./core/window-manager.cjs");
const { createAgentConversationManager } = require("./core/agent-conversation-manager.cjs");
const { createAgentHookServer } = require("./hooks/agent-hook-server.cjs");
const { createAgentSessionLauncher } = require("./hooks/agent-session-launcher.cjs");
const { createHookConfigManager } = require("./hooks/hook-config-manager.cjs");
const { createRemoteHookConfigService } = require("./hooks/remote-hook-config-service.cjs");
const { createAgentNotificationManager } = require("./notifications/agent-notification-manager.cjs");
const { createDingTalkNotificationManager } = require("./notifications/ding-talk-notification-manager.cjs");
const { createClipboardImageService } = require("./services/clipboard/index.cjs");
const { createGitModule } = require("./services/git/git-module.cjs");
const { createProjectSearchService } = require("./services/project-search/index.cjs");
const { createCodexModelBridgeModule } = require("./services/codex-model-bridge/index.cjs");
const { createMobileRemoteService } = require("./services/mobile-remote/index.cjs");
const { createLaunchTemplateService } = require("./services/launch-templates/index.cjs");
const { createTerminalStateHub } = require("./terminal/terminal-state-hub.cjs");
const { createRemoteFilesModule, registerRemoteFileScheme } = require("./services/remote-files/index.cjs");
const { createSkillsService } = require("./services/skills/skills-service.cjs");
const { createMcpConfigService } = require("./services/mcp/mcp-config-service.cjs");
const { createTokenUsageModule } = require("./services/token-usage/index.cjs");
const { createPostgresBackupService } = require("./services/postgres-backup/postgres-backup-service.cjs");
const { createAgentConversationHistoryService } = require("./services/conversation-history/index.cjs");
const { createWorkBuddyCheckinService, createWorkBuddyModelCatalogService, createWorkBuddyAutoCheckinService } = require("./services/workbuddy/index.cjs");
const { createIdeaModule } = require("./services/idea/idea-module.cjs");
const { createSettingsModule } = require("./services/settings/index.cjs");
const { createScreenshotModule } = require("./services/screenshot/index.cjs");
const {
  createRemoteAgentBridgeService,
  createRemoteSystemService,
  createSshAgentTransport,
  createSshFileSystem,
  createSshGitExecutor,
  createSshHookTunnelService,
  createSshSessionRuntime
} = require("./ssh/index.cjs");
const { createConfigStore } = require("./stores/config-store.cjs");
const { createDingTalkConfigStore } = require("./stores/ding-talk-config-store.cjs");
const { createKnownHostStore } = require("./stores/known-host-store.cjs");
const { createLaunchTemplateStore } = require("./stores/launch-template-store.cjs");
const { createMobileAccessStore } = require("./stores/mobile-access-store.cjs");
const { createOpenRouterConfigStore } = require("./stores/openrouter-config-store.cjs");
const { createCodeBuddyCodexConfigStore } = require("./stores/codebuddy-codex-config-store.cjs");
const { createSessionStore } = require("./stores/session-store.cjs");
const { createTemplateUsageStore } = require("./stores/template-usage-store.cjs");
const { createTerminalManager, getDefaultShell, getWslShell } = require("./terminal/terminal-manager.cjs");

let windowManager = null;
let sessionStore = null;
let environmentService = null;
let templateUsageStore = null;
let launchTemplateStore = null;
let launchTemplateService = null;
let configStore = null;
const resolveConfiguredShell = (preference, requireAvailable = true) => getDefaultShell({
  requireAvailable,
  preference: preference || configStore?.getConfig().defaultWindowsShell || "cmd"
});
let openRouterConfigStore = null;
let naraRouterConfigStore = null;
let miniMaxConfigStore = null;
let codeBuddyCodexConfigStore = null;
let settingsModule = null;
let screenshotModule = null;
let codexModelBridgeModule = null;
let dingTalkConfigStore = null;
let knownHostStore = null;
let terminalManager = null;
let agentHookServer = null;
let remoteFilesModule = null;
let remoteSystemService = null;
let skillsService = null;
let mcpConfigService = null;
let remoteAgentBridgeService = null;
let tokenUsageModule = null;
let postgresBackupService = null;
let workBuddyCheckinService = null;
let workBuddyAutoCheckinService = null;
let sshHookTunnelService = null;
let sshSessionRuntime = null;
let remoteHookConfigService = null;
let hookConfigManager = null;
let agentNotificationManager = null;
let agentSessionLauncher = null;
let dingTalkNotificationManager = null;
let gitModule = null;
let projectSearchService = null;
let clipboardImageService = null;
let mobileAccessStore = null;
let mobileRemoteService = null;
let terminalStateHub = null;
let agentConversationManager = null;
let agentConversationHistoryService = null;
let ideaModule = null;

registerRemoteFileScheme(protocol);

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
    windowManager = createWindowManager({
      onMainWindowClosed: () => agentConversationManager?.shutdown()
    });
    templateUsageStore = createTemplateUsageStore({
      usageFile: path.join(app.getPath("userData"), "template-usage.json")
    });
    templateUsageStore.load();
    launchTemplateStore = createLaunchTemplateStore({
      templatesFile: path.join(app.getPath("userData"), "launch-templates.json")
    });
    launchTemplateStore.load();
    environmentService = createEnvironmentService({
      configFile: path.join(app.getPath("userData"), "environment-profiles.json"),
      getReferences: () => [...(sessionStore?.getLibrary() || []), ...(terminalManager?.listSessions() || [])]
    });
    sessionStore = createSessionStore({
      environmentService,
      sessionsFile: path.join(app.getPath("userData"), "sessions.json"),
      // Reading saved metadata must work even if the selected shell is not installed.
      getDefaultShell: () => resolveConfiguredShell(undefined, false),
      getWslShell,
      safeStorage,
      onChanged: () => postgresBackupService?.schedule(),
      templateUsageStore,
      launchTemplateStore
    });
    configStore = createConfigStore({
      configFile: path.join(app.getPath("userData"), "config.json"),
      safeStorage
    });
    openRouterConfigStore = createOpenRouterConfigStore({
      configFile: path.join(app.getPath("userData"), "openrouter.json"),
      safeStorage
    });
    naraRouterConfigStore = createOpenRouterConfigStore({
      configFile: path.join(app.getPath("userData"), "nararouter.json"),
      safeStorage,
      providerName: "NaraRouter",
      assumeCompatibleWhenCapabilitiesMissing: true,
      verificationProfile: "chat-completions-bridge-v1"
    });
    miniMaxConfigStore = createOpenRouterConfigStore({
      configFile: path.join(app.getPath("userData"), "minimax.json"),
      safeStorage,
      providerName: "MiniMax",
      assumeCompatibleWhenCapabilitiesMissing: true,
      verificationProfile: "chat-completions-bridge-v1"
    });
    codeBuddyCodexConfigStore = createCodeBuddyCodexConfigStore({
      configFile: path.join(app.getPath("userData"), "codebuddy-codex.json")
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
    openRouterConfigStore.load();
    naraRouterConfigStore.load();
    miniMaxConfigStore.load();
    codeBuddyCodexConfigStore.load();
    dingTalkConfigStore.loadConfig();
    knownHostStore.loadKnownHosts();
    mobileAccessStore.load();
    agentConversationManager = createAgentConversationManager({
      broadcast: windowManager.broadcast
    });
    terminalStateHub = createTerminalStateHub({ scrollback: 5000 });
    const broadcast = (channel, payload) => {
      windowManager.broadcast(channel, payload);
      if (channel === "sessions:changed") postgresBackupService?.trackSessions(payload);
      if (mobileRemoteService) {
        mobileRemoteService.handleTerminalEvent(channel, payload);
      }
    };
    terminalManager = createTerminalManager({
      environmentService,
      getDefaultShell: resolveConfiguredShell,
      sessionStore,
      configStore,
      broadcast,
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
        if (remoteFilesModule) {
          void remoteFilesModule.disconnectSession(id);
        }
        if (remoteSystemService) {
          void remoteSystemService.disconnect(id);
        }
        tokenUsageModule?.disconnect(id);
        if (sshHookTunnelService) {
          void sshHookTunnelService.disconnect(id);
        }
        if (remoteAgentBridgeService) {
          void remoteAgentBridgeService.closeBinding(id);
        }
        if (codexModelBridgeModule) {
          codexModelBridgeModule.disconnect(id);
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
    const sshAgentTransport = createSshAgentTransport({ sshSessionRuntime });
    const sshFileSystem = createSshFileSystem({ sshSessionRuntime });
    const sshGitExecutor = createSshGitExecutor({ sshSessionRuntime });
    agentConversationHistoryService = createAgentConversationHistoryService({
      terminalManager,
      sshAgentTransport,
      homeDir: app.getPath("home")
    });
    workBuddyCheckinService = createWorkBuddyCheckinService();
    workBuddyAutoCheckinService = createWorkBuddyAutoCheckinService({
      checkinService: workBuddyCheckinService,
      notifyFailure: (error) => {
        const config = configStore.getConfig();
        const isEnglish = config.locale === "en-US";
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = rawMessage.replace(/[\r\n]+/g, " ").slice(0, 240);
        console.error("WorkBuddy auto check-in failed:", message);
        if (Notification.isSupported()) {
          new Notification({
            title: isEnglish ? "CodeBuddy auto check-in failed" : "CodeBuddy 自动签到失败",
            body: isEnglish
              ? `Please check your WorkBuddy login or network connection. ${message}`
              : `请检查 WorkBuddy 登录状态或网络连接。${message}`,
            silent: true
          }).show();
        }
      }
    });
    tokenUsageModule = createTokenUsageModule({
      ipcMain,
      terminalManager,
      sshAgentTransport,
      miniMaxConfigStore,
      databaseFile: path.join(app.getPath("userData"), "agent-token-stats.sqlite3"),
      legacyStatsFile: path.join(app.getPath("userData"), "agent-token-stats.json"),
      broadcast: windowManager.broadcast,
      conversationSink: agentConversationManager,
      onStatsChanged: () => postgresBackupService?.schedule(),
      onStatsCleared: () => postgresBackupService?.newStatsEpoch()
    });
    remoteFilesModule = createRemoteFilesModule({
      app,
      nativeImage,
      ipcMain,
      protocol,
      dialog,
      terminalManager,
      sshFileSystem,
      shellApi: shell,
      windowManager,
      broadcast: windowManager.broadcast,
      fallbackIconPath: path.join(__dirname, "..", "build", "icon.png")
    });
    const remoteFileService = remoteFilesModule.fileService;
    remoteAgentBridgeService = createRemoteAgentBridgeService({
      terminalManager,
      sshSessionRuntime,
      remoteFileService,
      windowManager,
      workspacesRoot: path.join(app.getPath("userData"), "remote-agent-workspaces"),
      broadcast: windowManager.broadcast
    });
    codexModelBridgeModule = createCodexModelBridgeModule({
      codeBuddy: {
        store: codeBuddyCodexConfigStore,
        workBuddyModelCatalogService: createWorkBuddyModelCatalogService(),
        verificationFile: path.join(app.getPath("userData"), "codebuddy-codex-verifications.json"),
        catalogFile: path.join(app.getPath("userData"), "codebuddy-codex-model-catalog.json"),
        preloadFile: app.isPackaged
          ? path.join(process.resourcesPath, "app.asar.unpacked", "electron", "services", "codex-model-bridge", "codebuddy-preload.cjs")
          : path.join(__dirname, "services", "codex-model-bridge", "codebuddy-preload.cjs")
      }
    });
    settingsModule = createSettingsModule({
      ipcMain,
      configStore,
      dingTalkConfigStore,
      dingTalkNotificationManager,
      workBuddyAutoCheckinService,
      getMobileRemoteService: () => mobileRemoteService,
      openRouterConfigStore,
      naraRouterConfigStore,
      miniMaxConfigStore,
      codeBuddyCodexBridgeService: codexModelBridgeModule.codeBuddyService,
      codexModelBridgeModule,
      openRouterCatalogFile: path.join(app.getPath("userData"), "openrouter-model-catalog.json"),
      naraRouterCatalogFile: path.join(app.getPath("userData"), "nararouter-model-catalog.json"),
      miniMaxCatalogFile: path.join(app.getPath("userData"), "minimax-model-catalog.json")
    });
    screenshotModule = createScreenshotModule({
      ipcMain,
      shellApi: shell,
      getWindowFromEvent: windowManager.getWindowFromEvent
    });
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
    mcpConfigService = createMcpConfigService({ homeDir: app.getPath("home"), terminalManager });
    skillsService = createSkillsService({ homeDir: app.getPath("home") });
    agentHookServer = createAgentHookServer({ terminalManager, agentTokenStatsService: tokenUsageModule });
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
      sessionStore,
      hookConfigManager,
      remoteHookConfigService,
      sshSessionRuntime,
      sshHookTunnelService,
      remoteAgentBridgeService,
      openRouterService: settingsModule.openRouterService,
      naraRouterService: settingsModule.naraRouterService,
      miniMaxService: settingsModule.miniMaxService,
      codexModelBridgeModule,
      getDefaultShell: resolveConfiguredShell,
      onTemplateLaunched: (templateId) => templateUsageStore.record(templateId)
    });
    launchTemplateService = createLaunchTemplateService({
      launchTemplateStore,
      sessionStore,
      agentSessionLauncher
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
    gitModule = createGitModule({
      ipcMain,
      terminalManager,
      sshGitExecutor
    });
    projectSearchService = createProjectSearchService({
      terminalManager,
      remoteFileService
    });
    ideaModule = createIdeaModule({
      ipcMain,
      discoveryDir: path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "Pannel Handle", "idea-bridge", "instances"),
      broadcast: windowManager.broadcast
    });
    sessionStore.loadLibrary();
    postgresBackupService = createPostgresBackupService({
      userData: app.getPath("userData"), safeStorage, sessionStore,
      statsFile: path.join(app.getPath("userData"), "agent-token-stats.sqlite3"),
      terminalManager, historyService: agentConversationHistoryService,
      onChanged: value => windowManager.broadcast("postgres-backup:changed", value)
    });
    postgresBackupService.load();
    postgresBackupService.trackSessions(sessionStore.getLibrary().filter(session => session.recentLaunchCount > 0));
    postgresBackupService.start();
    await agentHookServer.start();
    await remoteAgentBridgeService.start();
    await ideaModule.start().catch((err) => console.error("Failed to start IDEA bridge discovery:", err));
    await mobileRemoteService.start().catch((err) => console.error("Failed to start mobile access:", err));
    registerIpcHandlers({
      environmentService,
      terminalManager,
      mobileRemoteService,
      agentSessionLauncher,
      sessionStore,
      launchTemplateStore,
      launchTemplateService,
      windowManager,
      agentConversationManager,
      agentConversationHistoryService,
      clipboard,
      clipboardImageService,
      dialog,
      shellApi: shell,
      disconnectFileSession: remoteFilesModule.disconnectSession,
      remoteSystemService,
      skillsService,
      mcpConfigService,
      workBuddyCheckinService,
      hookConfigManager,
      remoteHookConfigService,
      projectSearchService,
      remoteAgentBridgeService,
      postgresBackupService
    });
    windowManager.createWindow();
    workBuddyAutoCheckinService.start(configStore.getConfig().autoWorkBuddyCheckin);

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
  if (remoteFilesModule) {
    void remoteFilesModule.shutdown();
  }
  if (remoteSystemService) {
    void remoteSystemService.shutdown();
  }
  if (remoteAgentBridgeService) {
    void remoteAgentBridgeService.shutdown();
  }
  settingsModule?.shutdown();
  screenshotModule?.shutdown();
  if (codexModelBridgeModule) {
    void codexModelBridgeModule.shutdown();
  }
  if (ideaModule) {
    void ideaModule.shutdown();
  }
  tokenUsageModule?.shutdown();
  if (postgresBackupService) void postgresBackupService.shutdown();
  if (workBuddyAutoCheckinService) {
    workBuddyAutoCheckinService.shutdown();
  }
  if (agentConversationManager) {
    agentConversationManager.shutdown();
  }
  if (gitModule) {
    gitModule.shutdown();
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
