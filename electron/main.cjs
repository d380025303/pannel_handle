const { createEnvironmentService } = require("./services/environment/index.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, Notification, protocol, safeStorage, shell, powerMonitor } = require("electron");

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
const { createCodexWorkspaceTrustService } = require("./hooks/codex-workspace-trust-service.cjs");
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
const { registerTerminalBackgroundScheme, registerTerminalBackgroundProtocol } = require("./services/settings/terminal-background.cjs");
const { createSkillsService } = require("./services/skills/skills-service.cjs");
const { createMcpConfigService } = require("./services/mcp/mcp-config-service.cjs");
const { createSessionStatusServer } = require("./services/mcp/session-status-server.cjs");
const { createTokenUsageModule } = require("./services/token-usage/index.cjs");
const { createPostgresBackupService } = require("./services/postgres-backup/postgres-backup-service.cjs");
const { createAgentConversationHistoryService } = require("./services/conversation-history/index.cjs");
const { createProjectAssistantService } = require("./services/project-assistant/project-assistant-service.cjs");
const { createCodexSessionControl } = require("./services/project-assistant/codex-session-control.cjs");
const { createCodexAppServerSessionService } = require("./services/codex-app-server/session-service.cjs");
const { createCodexVersionService } = require("./services/codex-app-server/version-service.cjs");
const { createCodeBuddyVersionService } = require("./services/codebuddy-acp/version-service.cjs");
const { createOpenCodeVersionService } = require("./services/opencode-acp/version-service.cjs");
const { createCodexPluginService } = require("./services/codex-app-server/plugin-service.cjs");
const { createCodeBuddyPluginService } = require("./services/codebuddy-acp/plugin-service.cjs");
const { createCodeBuddyAcpSessionService } = require("./services/codebuddy-acp/session-service.cjs");
const { createOpenCodeAcpSessionService } = require("./services/opencode-acp/session-service.cjs");
const { createClaudeAcpSessionService } = require("./services/claude-acp/session-service.cjs");
const { createGraphicalSessionRouter } = require("./services/codebuddy-acp/session-router.cjs");
const { createQoderAcpSessionService } = require("./services/qoder-acp/session-service.cjs");
const { createGeminiAcpSessionService } = require("./services/gemini-acp/session-service.cjs");
const { createGrokAcpSessionService } = require("./services/grok-acp/session-service.cjs");
const { createQuestionAnswerStore } = require("./services/codex-app-server/question-answer-store.cjs");
const { createDiagnosticsStore } = require("./services/codex-app-server/diagnostics-store.cjs");
const { createWorkBuddyCheckinService, createWorkBuddyModelCatalogService, createWorkBuddyAutoCheckinService } = require("./services/workbuddy/index.cjs");
const { createQoderAutoCheckinService } = require("./services/qoder-checkin/auto-checkin.cjs");
const { createQoderCheckinService } = require("./services/qoder-checkin/service.cjs");
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

const { createSessionStore } = require("./stores/session-store.cjs");
const { createBusinessDataStore } = require("./stores/business-data-store.cjs");
const { createTemplateUsageStore } = require("./stores/template-usage-store.cjs");
const { createTerminalManager, getDefaultShell, getWslShell } = require("./terminal/terminal-manager.cjs");
const { createSessionShellService } = require("./terminal/session-shell-service.cjs");

let windowManager = null;
let sessionStore = null;
let businessDataStore = null;
let modelCatalogDir = null;
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

let settingsModule = null;
let screenshotModule = null;
let codexModelBridgeModule = null;
let dingTalkConfigStore = null;
let knownHostStore = null;
let terminalManager = null;
let sessionShellService = null;
let agentHookServer = null;
let remoteFilesModule = null;
let remoteSystemService = null;
let skillsService = null;
let mcpConfigService = null;
let sessionStatusServer = null;
let remoteAgentBridgeService = null;
let codexWorkspaceTrustService = null;
let tokenUsageModule = null;
let postgresBackupService = null;
let qoderCheckinService = null;
let qoderAutoCheckinService = null;
let qoderResumeHandler = null;
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
let projectAssistantService = null;
let codexSessionControl = null;
let codexAppServerSessionService = null;
let questionAnswerStore = null;
let diagnosticsStore = null;

registerRemoteFileScheme(protocol);
registerTerminalBackgroundScheme(protocol);

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
    businessDataStore = createBusinessDataStore({ userData: app.getPath("userData") }).open();
    modelCatalogDir = fs.mkdtempSync(path.join(app.getPath("temp"), "pannel-handle-catalog-"));
    templateUsageStore = createTemplateUsageStore({
      usageFile: path.join(app.getPath("userData"), "template-usage.json"), dataStore: businessDataStore
    });
    templateUsageStore.load();
    launchTemplateStore = createLaunchTemplateStore({
      templatesFile: path.join(app.getPath("userData"), "launch-templates.json"), dataStore: businessDataStore
    });
    launchTemplateStore.load();
    environmentService = createEnvironmentService({
      configFile: path.join(app.getPath("userData"), "environment-profiles.json"), dataStore: businessDataStore,
      getReferences: () => [...(sessionStore?.getLibrary() || []), ...(terminalManager?.listSessions() || [])]
    });
    sessionStore = createSessionStore({
      environmentService,
      sessionsFile: path.join(app.getPath("userData"), "sessions.json"), dataStore: businessDataStore,
      // Reading saved metadata must work even if the selected shell is not installed.
      getDefaultShell: () => resolveConfiguredShell(undefined, false),
      getWslShell,
      safeStorage,
      onChanged: () => postgresBackupService?.schedule(),
      templateUsageStore,
      launchTemplateStore,
      getLegacyCodexAppServerEnabled: () => configStore.getLegacyCodexAppServerEnabled()
    });
    configStore = createConfigStore({
      configFile: path.join(app.getPath("userData"), "config.json"), dataStore: businessDataStore,
      safeStorage
    });
    configStore.loadConfig();
    dingTalkConfigStore = createDingTalkConfigStore({
      configFile: path.join(app.getPath("userData"), "dingtalk.json"), dataStore: businessDataStore,
      safeStorage
    });
    knownHostStore = createKnownHostStore({
      knownHostsFile: path.join(app.getPath("userData"), "known-hosts.json"), dataStore: businessDataStore
    });
    mobileAccessStore = createMobileAccessStore({
      accessFile: path.join(app.getPath("userData"), "mobile-access.json"), dataStore: businessDataStore
    });
    openRouterConfigStore = createOpenRouterConfigStore({
      configFile: path.join(app.getPath("userData"), "openrouter.json"), dataStore: businessDataStore,
      safeStorage
    });
    naraRouterConfigStore = createOpenRouterConfigStore({
      configFile: path.join(app.getPath("userData"), "nararouter.json"), dataStore: businessDataStore,
      safeStorage,
      providerName: "NaraRouter",
      assumeCompatibleWhenCapabilitiesMissing: true,
      verificationProfile: "chat-completions-bridge-v1"
    });
    miniMaxConfigStore = createOpenRouterConfigStore({
      configFile: path.join(app.getPath("userData"), "minimax.json"), dataStore: businessDataStore,
      safeStorage,
      providerName: "MiniMax",
      assumeCompatibleWhenCapabilitiesMissing: true,
      verificationProfile: "chat-completions-bridge-v1"
    });
    openRouterConfigStore.load();
    naraRouterConfigStore.load();
    miniMaxConfigStore.load();

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
      mobileRemoteService?.handleDesktopEvent(channel, payload);
      sessionStatusServer?.handleDesktopEvent(channel, payload);
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
        sessionShellService?.close(id);
        codexAppServerSessionService?.close(id);
        void codexWorkspaceTrustService?.release(id).catch(error => console.error("Codex workspace trust cleanup failed:", error));
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
    sessionShellService = createSessionShellService({
      terminalManager, environmentService, sessionStore, knownHostStore,
      broadcast: (channel, payload) => windowManager.broadcast(channel, payload)
    });
    questionAnswerStore = createQuestionAnswerStore({ userData: app.getPath("userData") });
    diagnosticsStore = createDiagnosticsStore({ userData: app.getPath("userData") });
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
    const codexGraphicalService = createCodexAppServerSessionService({
      environmentService,
      terminalManager,
      broadcast,
      sessionStore,
      questionAnswerStore,
      diagnosticsStore,
      sshAgentTransport,
      sshFileSystem,
      onTokenUsage: usage => tokenUsageModule?.recordAppServerUsage(usage)
    });
    agentConversationHistoryService = createAgentConversationHistoryService({
      terminalManager,
      sshAgentTransport,
      homeDir: app.getPath("home")
    });
    const codeBuddyGraphicalService = createCodeBuddyAcpSessionService({
      environmentService, terminalManager, sessionStore, broadcast, sshAgentTransport, sshFileSystem,
      historyService: agentConversationHistoryService,
      workBuddyModelCatalogService: createWorkBuddyModelCatalogService(),
      onTokenUsageCheckpoint: usage => tokenUsageModule?.recordGraphicalCodeBuddy(usage),
      onTokenLiveEvent: event => tokenUsageModule?.handleGraphicalCodeBuddyLive(event)
    });
    const openCodeGraphicalService = createOpenCodeAcpSessionService({
      environmentService, terminalManager, sessionStore, broadcast, sshAgentTransport, sshFileSystem,
      getCapabilityEndpoint: id => agentHookServer?.getOpenCodeCapabilityEndpoint(id),
      clearCapabilityEndpoint: id => agentHookServer?.clearOpenCodeCapabilityEndpoint(id),
      onTokenUsageCheckpoint: usage => tokenUsageModule?.recordGraphicalOpenCode(usage)
    });
    const claudeGraphicalService = createClaudeAcpSessionService({
      environmentService, terminalManager, broadcast, sshAgentTransport, sshFileSystem
    });
    const qoderGraphicalService = createQoderAcpSessionService({
      environmentService, terminalManager, broadcast, sshAgentTransport, sshFileSystem
    });
    const geminiGraphicalService = createGeminiAcpSessionService({
      environmentService, terminalManager, broadcast, sshAgentTransport, sshFileSystem,
      historyService: agentConversationHistoryService
    });
    const grokGraphicalService = createGrokAcpSessionService({
      environmentService, terminalManager, broadcast, sshAgentTransport, sshFileSystem,
      historyService: agentConversationHistoryService
    });
    codexAppServerSessionService = createGraphicalSessionRouter(codexGraphicalService, codeBuddyGraphicalService, terminalManager, openCodeGraphicalService, claudeGraphicalService, qoderGraphicalService, geminiGraphicalService, grokGraphicalService);
    const codexVersionService = createCodexVersionService({ terminalManager, sshAgentTransport });
    const codeBuddyVersionService = createCodeBuddyVersionService({ terminalManager, sshAgentTransport });
    const openCodeVersionService = createOpenCodeVersionService({ terminalManager, sshAgentTransport });
    const codexPluginService = createCodexPluginService({ terminalManager, graphicalService: codexGraphicalService,
      environmentService, sshAgentTransport });
    const codeBuddyPluginService = createCodeBuddyPluginService({ terminalManager, graphicalService: codeBuddyGraphicalService });
    const sshGitExecutor = createSshGitExecutor({ sshSessionRuntime });
    qoderCheckinService = createQoderCheckinService();
    qoderAutoCheckinService = createQoderAutoCheckinService({
      checkinService: qoderCheckinService,
      notifyFailure: error => {
        const isEnglish = configStore.getConfig().locale === "en-US";
        if (Notification.isSupported()) new Notification({
          title: isEnglish ? "Qoder auto check-in failed" : "Qoder 自动签到失败",
          body: error.message, silent: true
        }).show();
      }
    });
    ipcMain.handle("qoder-checkin:get-status", () => qoderCheckinService.getStatus());
    ipcMain.handle("qoder-checkin:claim", () => qoderCheckinService.claim());
    qoderResumeHandler = () => qoderAutoCheckinService.resume();
    powerMonitor.on("resume", qoderResumeHandler);
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
      onStatsCleared: () => {
        codexGraphicalService.resetUsageBaselines();
        tokenUsageModule?.resetGraphicalCodeBuddyBaselines();
        codeBuddyGraphicalService.resetUsageBaselines();
        openCodeGraphicalService.resetUsageBaselines();
        postgresBackupService?.newStatsEpoch();
      }
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
    codexWorkspaceTrustService = createCodexWorkspaceTrustService({ broadcast: windowManager.broadcast });
    codexModelBridgeModule = createCodexModelBridgeModule({});
    settingsModule = createSettingsModule({
      ipcMain,
      configStore,
      dingTalkConfigStore,
      dingTalkNotificationManager,
      workBuddyAutoCheckinService,
    qoderAutoCheckinService,
      getMobileRemoteService: () => mobileRemoteService,
      openRouterConfigStore,
      naraRouterConfigStore,
      miniMaxConfigStore,

      codexModelBridgeModule,
      openRouterCatalogFile: path.join(modelCatalogDir, "openrouter-model-catalog.json"),
      naraRouterCatalogFile: path.join(modelCatalogDir, "nararouter-model-catalog.json"),
      miniMaxCatalogFile: path.join(modelCatalogDir, "minimax-model-catalog.json"),
      dialog,
      getWindowFromEvent: windowManager.getWindowFromEvent,
      userDataDir: app.getPath("userData"),
      listOpenCodeWslDistros: () => terminalManager.listSessions()
        .filter(session => session.agentProvider === "opencode" && session.type === "wsl" && session.wslDistro)
        .map(session => session.wslDistro)
    });
    try { settingsModule.syncOpenCodeModels(); }
    catch (error) { console.error("Failed to synchronize OpenCode models:", error); }
    registerTerminalBackgroundProtocol(protocol, app.getPath("userData"));
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
    mcpConfigService = createMcpConfigService({ homeDir: app.getPath("home"), terminalManager,
      graphicalService: codexGraphicalService, sshAgentTransport, sshFileSystem, environmentService });
    skillsService = createSkillsService({ homeDir: app.getPath("home"), terminalManager,
      codexAppServerSessionService: codexGraphicalService, environmentService });
    hookConfigManager = createHookConfigManager();
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
      codexAppServerSessionService,
      sessionStore,
      hookConfigManager,
      remoteHookConfigService,
      sshSessionRuntime,
      sshHookTunnelService,
      remoteAgentBridgeService,
      codexWorkspaceTrustService,
      openRouterService: settingsModule.openRouterService,
      naraRouterService: settingsModule.naraRouterService,
      miniMaxService: settingsModule.miniMaxService,
      openCodeModelSync: settingsModule.openCodeModelSync,
      codexModelBridgeModule,
      getDefaultShell: resolveConfiguredShell,
      onTemplateLaunched: (templateId) => templateUsageStore.record(templateId)
    });
    launchTemplateService = createLaunchTemplateService({
      launchTemplateStore,
      sessionStore,
      agentSessionLauncher
    });
    codexSessionControl = createCodexSessionControl({
      terminalManager,
      stateHub: terminalStateHub,
      conversationManager: agentConversationManager
    });
    projectAssistantService = createProjectAssistantService({
      userData: app.getPath("userData"),
      broadcast: windowManager.broadcast,
      dependencies: {
        terminalManager, sessionStore, launchTemplateStore, launchTemplateService,
        agentSessionLauncher, tokenUsageModule,
        disconnectFileSession: remoteFilesModule.disconnectSession,
        remoteSystemService,
        codexSessionControl
      }
    });
    mobileRemoteService = createMobileRemoteService({
      terminalManager,
      agentSessionLauncher,
      sessionStore,
      graphicalService: codexAppServerSessionService,
      codexPluginService, codexVersionService, projectSearchService: { searchWorkspaceEntries: (...args) => projectSearchService.searchWorkspaceEntries(...args) }, mcpConfigService,
      getAgentUsage: (sessionId, options) => tokenUsageModule.getUsage(sessionId, options),
      codeBuddyPluginService, codeBuddyVersionService,
      getCodeBuddyVerifiedModels: () => [
        ["openrouter", openRouterConfigStore], ["nararouter", naraRouterConfigStore], ["minimax", miniMaxConfigStore]
      ].flatMap(([source, store]) => !store.getApiKey() ? [] : store.getCachedModels()
        .filter(model => store.getAgentModelVerifications("codebuddy")[model.id]?.status === "passed")
        .map(model => ({ source, id: model.id, name: model.name }))),
      getCodexVerifiedModels: () => [
        ["openrouter", openRouterConfigStore], ["nararouter", naraRouterConfigStore], ["minimax", miniMaxConfigStore]
      ].flatMap(([source, store]) => store.getApiKey() ? store.getCachedModels()
        .filter(model => store.getAgentModelVerifications("codex")[model.id]?.status === "passed")
        .map(model => ({ source, id: model.id, name: model.name || model.id })) : []),
      getOpenCodeVerifiedModels: () => Object.fromEntries([
        ["openrouter", openRouterConfigStore], ["nararouter", naraRouterConfigStore], ["minimax", miniMaxConfigStore]
      ].map(([source, store]) => {
        if (!store.getApiKey()) return [source, new Set()];
        const verified = store.getAgentModelVerifications("opencode");
        return [source, new Set(store.getCachedModels().filter(model => verified[model.id]?.status === "passed")
          .map(model => `${source}/${model.id}`))];
      })),
      accessStore: mobileAccessStore,
      stateHub: terminalStateHub,
      getStaticRoot: () => app.isPackaged
        ? path.join(process.resourcesPath, "mobile")
        : path.resolve(__dirname, "..", "mobile", "dist"),
      desktopBroadcast: windowManager.broadcast,
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
    sessionStatusServer = createSessionStatusServer({
      userData: app.getPath("userData"), terminalManager,
      graphicalService: codexAppServerSessionService, stateHub: terminalStateHub,
      broadcast: windowManager.broadcast
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
      userData: app.getPath("userData"), safeStorage, sessionStore, dataStore: businessDataStore,
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
    await sessionStatusServer.start().catch((err) => console.error("Failed to start session status MCP:", err));
    registerIpcHandlers({
      environmentService,
      terminalManager,
      sessionShellService,
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
      sessionStatusServer,
      workBuddyCheckinService,
      hookConfigManager,
      remoteHookConfigService,
      projectSearchService,
      remoteAgentBridgeService,
      codexWorkspaceTrustService,
      postgresBackupService,
      projectAssistantService,
      codexSessionControl,
      codexAppServerSessionService,
      codexVersionService,
      codeBuddyVersionService,
      openCodeVersionService,
      codexPluginService,
      codeBuddyPluginService
    });
    windowManager.createWindow();
    workBuddyAutoCheckinService.start(configStore.getConfig().autoWorkBuddyCheckin);
    qoderAutoCheckinService.start(configStore.getConfig().autoQoderCheckin);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager.createWindow();
      }
    });
  }).catch((error) => {
    console.error("Failed to initialize application data:", error);
    dialog.showErrorBox("Pannel Handle 启动失败", `业务数据迁移或加载失败：${error.message}`);
    app.quit();
  });
}

let graphicalShutdownComplete = false;
let graphicalShutdownPending = null;
app.on("before-quit", event => {
  if (graphicalShutdownComplete || !codexAppServerSessionService) return;
  event.preventDefault();
  if (!graphicalShutdownPending) {
    graphicalShutdownPending = Promise.resolve(codexAppServerSessionService.shutdown())
      .catch(error => console.error("Graphical session shutdown failed:", error))
      .finally(() => { graphicalShutdownComplete = true; app.quit(); });
  }
});

app.on("window-all-closed", async () => {
  await codexAppServerSessionService?.shutdown();
  if (configStore) {
    configStore.saveConfig();
  }
  if (sessionStore) {
    sessionStore.saveLibrary();
  }
  if (terminalManager) {
    terminalManager.shutdown();
  }
  sessionShellService?.shutdown();
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
  codexAppServerSessionService?.shutdown();
  screenshotModule?.shutdown();
  if (codexModelBridgeModule) {
    void codexModelBridgeModule.shutdown();
  }
  if (ideaModule) {
    void ideaModule.shutdown();
  }
  tokenUsageModule?.shutdown();
  projectAssistantService?.shutdown();
  if (postgresBackupService) void postgresBackupService.shutdown();
  qoderAutoCheckinService?.shutdown();
  if (qoderResumeHandler) powerMonitor.removeListener("resume", qoderResumeHandler);
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
  if (sessionStatusServer) {
    void sessionStatusServer.stop();
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

app.on("will-quit", () => {
  questionAnswerStore?.close();
  diagnosticsStore?.close();
  businessDataStore?.close();
  if (modelCatalogDir) {
    const target = path.resolve(modelCatalogDir);
    const tempRoot = path.resolve(app.getPath("temp"));
    if (target.startsWith(`${tempRoot}${path.sep}`) && path.basename(target).startsWith("pannel-handle-catalog-")) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
});
