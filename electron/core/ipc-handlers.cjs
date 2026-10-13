const { ipcMain: defaultIpcMain } = require("electron");
const fs = require("node:fs");
const { openExternalHttpUrl } = require("./external-link.cjs");

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

function updateSessionFromIpc(terminalManager, { id, title, cwd, fileSort, preferredDiskMountPoint, initialCommand, agentProvider, agentLocation, localAgentCwd, modelSource, modelId, codexBackend, codexModel, codexExperimentalAcknowledged, graphicalSessionEnabled, sshConfig, quickCommands, tags, environmentProfileId, environmentOverrides, openCodeAdditionalDirectories }) {
  return terminalManager.updateSession(id, { title, cwd, fileSort, preferredDiskMountPoint, initialCommand, agentProvider, agentLocation, localAgentCwd, modelSource, modelId, codexBackend, codexModel, codexExperimentalAcknowledged, graphicalSessionEnabled, sshConfig, quickCommands, tags, environmentProfileId, environmentOverrides, openCodeAdditionalDirectories });
}

function registerIpcHandlers({ environmentService, ipcMain = defaultIpcMain, terminalManager, sessionShellService, mobileRemoteService, agentSessionLauncher, sessionStore, launchTemplateStore, launchTemplateService, windowManager, agentConversationManager, agentConversationHistoryService, clipboard, clipboardImageService, dialog, shellApi, disconnectFileSession, remoteSystemService, skillsService, mcpConfigService, sessionStatusServer, sessionApiService, moduleOwnerService, workBuddyCheckinService, hookConfigManager, remoteHookConfigService, projectSearchService, remoteAgentBridgeService, codexWorkspaceTrustService, postgresBackupService, codexAppServerSessionService, codexVersionService, codeBuddyVersionService, openCodeVersionService, codexPluginService, codeBuddyPluginService }) {

  if (environmentService) {
    ipcMain.handle("environment:list", () => environmentService.list());
    ipcMain.handle("environment:save", (_event, input) => environmentService.save(input));
    ipcMain.handle("environment:delete", (_event, id) => environmentService.remove(id));
    ipcMain.handle("environment:preview", (_event, input) => environmentService.preview(input));
  }
  ipcMain.handle("sessions:list", () => terminalManager.listSessions());

  ipcMain.handle("sessions:load-saved", () => sessionStore.getLibrary());
  ipcMain.handle("sessions:config-warnings", (_event, templateId) => {
    const template = sessionStore.getTemplate(String(templateId || ""));
    if (!template) throw new Error("会话模板不存在。");
    return [...template.ignoredCodexConfigWarnings];
  });
  ipcMain.handle("sessions:ignore-config-warning", (_event, templateId, fingerprint) => {
    const id = String(templateId || "");
    const ignored = sessionStore.ignoreCodexConfigWarning(id, fingerprint);
    windowManager.broadcast("sessions:config-warnings-changed", { templateId: id, ignored });
    return ignored;
  });
  if (codexAppServerSessionService) {
    ipcMain.handle("opencode-auth:start", (_event, id, methodId) => codexAppServerSessionService.startAcpLogin(String(id || ""), String(methodId || "")));
    ipcMain.handle("opencode-auth:cancel", (_event, id, generation) => codexAppServerSessionService.cancelAcpLogin(String(id || ""), generation));
    ipcMain.on("opencode-auth:write", (_event, id, generation, data) => codexAppServerSessionService.writeAcpLogin(String(id || ""), generation, data));
    ipcMain.on("opencode-auth:resize", (_event, id, generation, cols, rows) => codexAppServerSessionService.resizeAcpLogin(String(id || ""), generation, cols, rows));
    ipcMain.handle("codex-app-server:windows-sandbox-setup", (_event, id, mode) => codexAppServerSessionService.setupWindowsSandbox(String(id || ""), mode));
    ipcMain.handle("codex-app-server:sub-agent-view", (_event, id, expanded, threadId, rootThreadId) => codexAppServerSessionService.setSubAgentView(String(id || ""), expanded, threadId, rootThreadId));
    ipcMain.handle("codex-app-server:sub-agents-refresh", (_event, id, rootThreadId) => codexAppServerSessionService.refreshSubAgents(String(id || ""), rootThreadId));
    ipcMain.handle("codex-app-server:snapshot", (_event, id) => codexAppServerSessionService.snapshot(String(id || "")));
    ipcMain.handle("codex-app-server:model-metadata", (_event, id) => codexAppServerSessionService.listModelMetadata(String(id || "")));
    ipcMain.handle("codex-app-server:account-read", (_event, id) => codexAppServerSessionService.readAccount(String(id || "")));
    ipcMain.handle("codex-app-server:account-login", (_event, id, type) => codexAppServerSessionService.startLogin(String(id || ""), type));
    ipcMain.handle("codex-app-server:account-cancel", (_event, id) => codexAppServerSessionService.cancelLogin(String(id || "")));
    ipcMain.handle("codex-app-server:account-logout", (_event, id) => codexAppServerSessionService.logout(String(id || "")));
    ipcMain.handle("codex-app-server:account-usage", (_event, id) => codexAppServerSessionService.refreshAccountUsage(String(id || "")));
    ipcMain.handle("codex-app-server:configuration", (_event, id) => codexAppServerSessionService.readConfiguration(String(id || "")));
    ipcMain.handle("codex-app-server:permission-profile", (_event, id, profileId) => codexAppServerSessionService.setPermissionProfile(String(id || ""), profileId));
    ipcMain.handle("codex-app-server:history", (_event, id, cursor, archived, isPinned) => codexAppServerSessionService.listHistory(String(id || ""), cursor, archived, isPinned));
    ipcMain.handle("codex-app-server:initial-user-input", (_event, id, threadId) => codexAppServerSessionService.readInitialUserInput(String(id || ""), threadId));
    ipcMain.handle("codex-app-server:revert-thread", (_event, id, messageId) => codexAppServerSessionService.revertThread(String(id || ""), messageId));
    ipcMain.handle("codex-app-server:restore-thread", (_event, id) => codexAppServerSessionService.restoreThread(String(id || "")));
    ipcMain.handle("codex-app-server:rename-thread", (_event, id, threadId, name) => codexAppServerSessionService.renameThread(String(id || ""), threadId, name));
    ipcMain.handle("codex-app-server:rewind", (_event, id, messageId, scope) => codexAppServerSessionService.rewind(String(id || ""), messageId, scope));
    ipcMain.handle("codex-app-server:pin-thread", (_event, id, threadId, isPinned) => codexAppServerSessionService.pinThread(String(id || ""), threadId, isPinned));
    ipcMain.handle("codex-app-server:fork-turn-new-session", (_event, id, threadId, turnId) => agentSessionLauncher.forkTurnToNewSession(String(id || ""), threadId, turnId));
    ipcMain.handle("codex-app-server:fork-thread", (_event, id, threadId, lastTurnId) => codexAppServerSessionService.forkThread(String(id || ""), threadId, lastTurnId));
    ipcMain.handle("codex-app-server:delete-thread", (_event, id, threadId) => codexAppServerSessionService.deleteThread(String(id || ""), threadId));
    ipcMain.handle("codex-app-server:archive-thread", (_event, id, threadId) => codexAppServerSessionService.archiveThread(String(id || ""), threadId));
    ipcMain.handle("codex-app-server:unarchive-thread", (_event, id, threadId) => codexAppServerSessionService.unarchiveThread(String(id || ""), threadId));
    ipcMain.handle("codex-app-server:capabilities", (_event, id, refresh) => codexAppServerSessionService.listCapabilities(String(id || ""), refresh === true));
    ipcMain.handle("codex-app-server:skill-enable", (_event, id, path, enabled) => codexAppServerSessionService.setSkillEnabled(String(id || ""), path, enabled));
    ipcMain.handle("codex-app-server:plugin-detail", (_event, id, plugin, marketplace) => codexAppServerSessionService.readPluginDetail(String(id || ""), plugin, marketplace));
    ipcMain.handle("codex-app-server:plugin-skill", (_event, id, plugin, marketplace, skill) => codexAppServerSessionService.readPluginSkill(String(id || ""), plugin, marketplace, skill));
    ipcMain.handle("codex-app-server:app-detail", (_event, id, appId) => codexAppServerSessionService.readAppDetail(String(id || ""), appId));
    ipcMain.handle("codex-app-server:mcp-resource", (_event, id, server, uri) => codexAppServerSessionService.readMcpResource(String(id || ""), server, uri));
    ipcMain.handle("codex-app-server:mcp-login", (_event, id, name) => codexAppServerSessionService.loginMcpServer(String(id || ""), name));
    ipcMain.handle("codex-app-server:mcp-reload", (_event, id) => codexAppServerSessionService.reloadMcpServers(String(id || "")));
    ipcMain.handle("codex-app-server:resume", (_event, id, threadId) => codexAppServerSessionService.resume(String(id || ""), threadId));
    ipcMain.handle("codex-app-server:new-thread", (_event, id) => codexAppServerSessionService.newThread(String(id || "")));
    ipcMain.handle("codex-app-server:review", (_event, id, target) => codexAppServerSessionService.startReview(String(id || ""), target));
    ipcMain.handle("codex-app-server:compact", (_event, id) => codexAppServerSessionService.compactThread(String(id || "")));
    ipcMain.handle("codex-app-server:background-terminals-list", (_event, id) => codexAppServerSessionService.listBackgroundTerminals(String(id || "")));
    ipcMain.handle("codex-app-server:background-terminal-terminate", (_event, id, processId) =>
      codexAppServerSessionService.terminateBackgroundTerminal(String(id || ""), processId));
    ipcMain.handle("codex-app-server:background-terminals-clean", (_event, id) => codexAppServerSessionService.cleanBackgroundTerminals(String(id || "")));
    for (const [channel, method] of [["list", "listJobs"], ["dispatch-context", "jobDispatchContext"], ["resumable", "listResumableJobs"]])
      ipcMain.handle(`codebuddy-jobs:${channel}`, (_event, id) => codexAppServerSessionService[method](String(id || "")));
    ipcMain.handle("codebuddy-scheduled-tasks:list", (_event, id, threadId) => codexAppServerSessionService.listScheduledTasks(String(id || ""), threadId));
    ipcMain.handle("codebuddy-scheduled-tasks:create", (_event, id, threadId, input) => codexAppServerSessionService.createScheduledTask(String(id || ""), threadId, input));
    ipcMain.handle("codebuddy-scheduled-tasks:delete", (_event, id, threadId, taskId) => codexAppServerSessionService.deleteScheduledTask(String(id || ""), threadId, taskId));
    ipcMain.handle("codebuddy-jobs:dispatch", (_event, id, input) => codexAppServerSessionService.dispatchJob(String(id || ""), input));
    ipcMain.handle("codebuddy-jobs:resume", (_event, id, sessionId) => codexAppServerSessionService.resumeJob(String(id || ""), sessionId));
    ipcMain.handle("codebuddy-jobs:transcript-read", (_event, id, jobId) => codexAppServerSessionService.jobTranscript(String(id || ""), jobId));
    ipcMain.handle("codebuddy-jobs:action", (_event, id, jobId, action, input) => codexAppServerSessionService.jobAction(String(id || ""), jobId, action, input));
    ipcMain.handle("codebuddy-jobs:watch", (_event, id, jobId) => codexAppServerSessionService.watchJob(String(id || ""), jobId));
    ipcMain.handle("codebuddy-jobs:unwatch", (_event, id, jobId) => codexAppServerSessionService.unwatchJob(String(id || ""), jobId));
    ipcMain.handle("codex-app-server:goal-get", (_event, id) => codexAppServerSessionService.getGoal(String(id || "")));
    ipcMain.handle("codex-app-server:goal-set", (_event, id, changes) => codexAppServerSessionService.setGoal(String(id || ""), changes));
    ipcMain.handle("codex-app-server:goal-clear", (_event, id) => codexAppServerSessionService.clearGoal(String(id || "")));
    ipcMain.handle("codex-app-server:goal-refresh", (_event, id) => codexAppServerSessionService.refreshGoal(String(id || "")));
    ipcMain.handle("codex-app-server:mode", (_event, id, mode) => codexAppServerSessionService.setMode(String(id || ""), mode));
    ipcMain.handle("codex-app-server:native-mode", (_event, id, modeId) => codexAppServerSessionService.setNativeMode(String(id || ""), modeId));
    ipcMain.handle("codex-app-server:model", (_event, id, modelId) => codexAppServerSessionService.setModel(String(id || ""), modelId));
    ipcMain.handle("codex-app-server:main-agents", (_event, id) => codexAppServerSessionService.listMainAgents(String(id || "")));
    ipcMain.handle("codex-app-server:main-agent", (_event, id, agentName) => codexAppServerSessionService.setMainAgent(String(id || ""), agentName));
    ipcMain.handle("codex-app-server:context-window", (_event, id, value) => codexAppServerSessionService.setContextWindow(String(id || ""), value));
    ipcMain.handle("codex-app-server:effort", (_event, id, effort) => codexAppServerSessionService.setEffort(String(id || ""), effort));
    ipcMain.handle("codex-app-server:multitask", (_event, id, enabled) => codexAppServerSessionService.setMultitask(String(id || ""), enabled));
    ipcMain.handle("codex-app-server:team-message", (_event, id, teamName, memberName, text) =>
      codexAppServerSessionService.sendTeamMessage(String(id || ""), teamName, memberName, text));
    ipcMain.handle("codex-app-server:fast-mode", (_event, id, enabled) => codexAppServerSessionService.setFastMode(String(id || ""), enabled));
    ipcMain.handle("codex-app-server:execution-permission", (_event, id, permission) =>
      codexAppServerSessionService.setExecutionPermission(String(id || ""), permission));
    ipcMain.handle("codex-app-server:dismiss-plan", (_event, id, itemId) => codexAppServerSessionService.dismissPlan(String(id || ""), itemId));
    ipcMain.handle("codex-app-server:execute-plan", (_event, id, itemId) => codexAppServerSessionService.executePlan(String(id || ""), itemId));
    ipcMain.handle("codex-app-server:choose-files", async (event, id) => {
      const ownerWindow = windowManager.getWindowFromEvent(event);
      const result = await dialog.showOpenDialog(ownerWindow, { properties: ["openFile", "multiSelections"] });
      const filePaths = result.canceled ? [] : result.filePaths.slice(0, 10);
      codexAppServerSessionService.allowFiles(String(id || ""), filePaths);
      return filePaths;
    });
    ipcMain.handle("codex-app-server:preview-attachment", (_event, id, filePath) =>
      codexAppServerSessionService.previewAttachment(String(id || ""), filePath));
    ipcMain.handle("codex-app-server:paste-image", async (_event, id, image) => {
      const sessionId = String(id || "");
      codexAppServerSessionService.snapshot(sessionId);
      const session = terminalManager.getSession(sessionId);
      const localCwd = session?.type === "ssh" && session.agentLocation === "local"
        ? codexAppServerSessionService.getWorkspaceCwd(sessionId) : undefined;
      const result = await clipboardImageService.pasteImageToSession(sessionId, { localCwd, image });
      if (result.status === "saved") codexAppServerSessionService.allowPastedImage(sessionId, result.path);
      return result;
    });
    ipcMain.handle("codex-app-server:discard-image", (_event, id, filePath) =>
      codexAppServerSessionService.discardPastedImage(String(id || ""), filePath));
    ipcMain.handle("codex-app-server:ask-side-question", (_event, id, question) => codexAppServerSessionService.askSideQuestion(String(id || ""), question));
    ipcMain.handle("codex-app-server:cancel-side-question", (_event, id, requestId) => codexAppServerSessionService.cancelSideQuestion(String(id || ""), requestId));
    ipcMain.handle("codex-app-server:submit", (_event, id, text, filePaths, references, orderedContent) => codexAppServerSessionService.submit(String(id || ""), text, filePaths, references, orderedContent));
    ipcMain.handle("codex-app-server:interrupt", (_event, id) => codexAppServerSessionService.interrupt(String(id || "")));
    ipcMain.handle("codex-app-server:approval", (_event, id, requestId, decision) => {
      if (typeof decision !== "string" && typeof decision !== "boolean") throw new Error("无效的审批选择。");
      return codexAppServerSessionService.resolveApproval(String(id || ""), requestId, decision);
    });
    ipcMain.handle("codex-app-server:answer-question", (_event, id, requestId, answers) =>
      codexAppServerSessionService.answerQuestion(String(id || ""), requestId, answers));
    ipcMain.handle("codex-app-server:cancel-question", (_event, id, requestId) =>
      codexAppServerSessionService.cancelQuestion(String(id || ""), requestId));
    ipcMain.handle("codex-app-server:resolve-elicitation", (_event, id, requestId, action, content) =>
      codexAppServerSessionService.resolveElicitation(String(id || ""), requestId, action, content));
  }
  if (codexVersionService) {
    ipcMain.handle("codex-version:check", (_event, id, force) => codexVersionService.check(String(id || ""), force === true));
    ipcMain.handle("codex-version:update", (_event, id) => codexVersionService.update(String(id || "")));
  }
  if (codeBuddyVersionService) {
    ipcMain.handle("codebuddy-version:check", (_event, id, force) => codeBuddyVersionService.check(String(id || ""), force === true));
    ipcMain.handle("codebuddy-version:update", (_event, id) => codeBuddyVersionService.update(String(id || "")));
  }
  if (openCodeVersionService) {
    ipcMain.handle("opencode-version:check", (_event, id, force) => openCodeVersionService.check(String(id || ""), force === true));
    ipcMain.handle("opencode-version:update", (_event, id) => openCodeVersionService.update(String(id || "")));
  }
  if (codexPluginService) {
    ipcMain.handle("codex-plugin:list", (_event, id) => codexPluginService.list(id));
    ipcMain.handle("codex-plugin:install", (_event, id, plugin, marketplace) => codexPluginService.install(id, plugin, marketplace));
    ipcMain.handle("codex-plugin:uninstall", (_event, id, plugin, marketplace) => codexPluginService.uninstall(id, plugin, marketplace));
    ipcMain.handle("codex-plugin:marketplace-add", (_event, id, source) => codexPluginService.addMarketplace(id, source));
    ipcMain.handle("codex-plugin:marketplace-refresh", (_event, id, name) => codexPluginService.refreshMarketplace(id, name));
    ipcMain.handle("codex-plugin:marketplace-remove", (_event, id, name) => codexPluginService.removeMarketplace(id, name));
    ipcMain.handle("codex-plugin:config", (_event, id, scope) => codexPluginService.readConfig(id, scope));
    ipcMain.handle("codex-plugin:enable", (_event, id, scope, input) => codexPluginService.setEnabled(id, scope, input));
  }
  if (codexAppServerSessionService) {
    for (const [action, method] of Object.entries({ restart: "mcpRestart", images: "mcpAppImages", runtime: "mcpRuntime", load: "mcpAppLoad", read: "mcpAppRead",
      prepare: "mcpAppPrepare", resolve: "mcpAppResolve", dispose: "mcpAppDispose" }))
      ipcMain.handle(`codebuddy-mcp:${action}`, (_event, id, ...args) => codexAppServerSessionService[method](id, ...args));
  }
  if (codeBuddyPluginService) {
    for (const method of ["list", "reload", "install", "uninstall", "enable", "disable", "update", "addMarketplace", "refreshMarketplace", "removeMarketplace", "setAutoUpdate"])
      ipcMain.handle(`codebuddy-plugin:${method}`, (_event, id, ...args) => codeBuddyPluginService[method](id, ...args));
  }
  if (postgresBackupService) {
    ipcMain.handle("postgres-backup:get-config", () => postgresBackupService.publicState());
    ipcMain.handle("postgres-backup:save-config", (_event, input) => postgresBackupService.saveConfig(input));
    ipcMain.handle("postgres-backup:test", (_event, input) => postgresBackupService.testConnection(input));
    ipcMain.handle("postgres-backup:run", () => postgresBackupService.backupNow());
    ipcMain.handle("postgres-backup:devices", () => postgresBackupService.listDevices());
    ipcMain.handle("postgres-backup:dashboard", (_event, input) => postgresBackupService.getDashboard(input));
    ipcMain.handle("postgres-backup:snapshots", (_event, deviceId) => postgresBackupService.listSnapshots(deviceId));
    ipcMain.handle("postgres-backup:restore", (_event, id, passphrase) => postgresBackupService.restoreSnapshot(id, passphrase));
    ipcMain.handle("postgres-backup:conversations", (_event, deviceId, offset) => postgresBackupService.listConversations(deviceId, offset));
    ipcMain.handle("postgres-backup:messages", (_event, deviceId, sourceKey, ref, offset) => postgresBackupService.getMessages(deviceId, sourceKey, ref, offset));
    ipcMain.handle("postgres-backup:delete-device", (_event, deviceId) => postgresBackupService.deleteDevice(deviceId));
  }

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
      await fs.promises.writeFile(result.filePath, JSON.stringify(payload, null, 2), "utf-8");
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

  ipcMain.handle("sessions:launch-selected", async (_event, sessionsToLaunch, launchMode) => {
    return agentSessionLauncher.launchSessions(sessionsToLaunch, { recordUsage: launchMode === "manual" });
  });

  ipcMain.handle("launch-templates:list", () => launchTemplateStore.getAll());

  ipcMain.handle("launch-templates:create", (_event, input) => launchTemplateStore.create(input));

  ipcMain.handle("launch-templates:update", (_event, id, input) => launchTemplateStore.update(String(id || ""), input));

  ipcMain.handle("launch-templates:delete", (_event, id) => launchTemplateStore.remove(String(id || "")));

  ipcMain.handle("launch-templates:launch", (_event, id) => launchTemplateService.launch(String(id || "")));

  ipcMain.handle("sessions:delete-saved", (_event, id) => {
    return terminalManager.deleteSavedSession(id);
  });

  ipcMain.handle("sessions:duplicate", (_event, id) => {
    return terminalManager.duplicateSavedSession(id);
  });

  ipcMain.handle("sessions:duplicate-running", (_event, id) => {
    return agentSessionLauncher.duplicateRunningSession(String(id || ""));
  });

  ipcMain.handle("sessions:open-other-mode", (_event, id) => {
    return agentSessionLauncher.openOtherSessionMode(String(id || ""));
  });

  ipcMain.handle("sessions:reorder-running", (_event, orderedIds) => {
    return terminalManager.reorderRunningSessions(orderedIds);
  });

  ipcMain.handle("wsl:list-distros", () => terminalManager.listWslDistros());

  ipcMain.handle("sessions:create", async (_event, options) => {
    return agentSessionLauncher.createSession(options);
  });

  ipcMain.handle("sessions:rename", (_event, { id, title }) => {
    return terminalManager.renameSession(id, title);
  });

  ipcMain.handle("sessions:update", async (_event, input) => updateSessionFromIpc(terminalManager, input));

  ipcMain.handle("sessions:switch-agent", async (_event, { id, provider }) => {
    return agentSessionLauncher.switchAgent(String(id || ""), provider);
  });

  ipcMain.handle("sessions:switch-model-source", async (_event, { id, source, restart, modelId }) => {
    return agentSessionLauncher.switchModelSource(String(id || ""), source, restart === true, modelId);
  });

  ipcMain.handle("sessions:close", async (_event, id) => {
    const sessions = terminalManager.closeSession(id);
    if (disconnectFileSession) {
      await disconnectFileSession(id);
    }
    if (remoteSystemService) {
      await remoteSystemService.disconnect(id);
    }
    return sessions;
  });

  ipcMain.handle("sessions:reconnect", (_event, id) => {
    const sessionId = String(id || "");
    const session = terminalManager.getSession(sessionId);
    return session?.runtimeMode === "app-server" && session.type === "ssh"
      ? codexAppServerSessionService.restart(sessionId)
      : terminalManager.reconnectSession(sessionId);
  });

  ipcMain.handle("terminal:history", (_event, id) => terminalManager.getHistory(id));
  if (sessionShellService) {
    ipcMain.handle("session-shell:open", (_event, id, ownerToken) => sessionShellService.open(String(id || ""), String(ownerToken || "")));
    ipcMain.handle("session-shell:close", (_event, id, ownerToken) => sessionShellService.close(String(id || ""), String(ownerToken || "")));
    ipcMain.on("session-shell:write", (_event, { id, generation, data }) => sessionShellService.write(String(id || ""), generation, data));
    ipcMain.on("session-shell:resize", (_event, { id, generation, cols, rows }) => sessionShellService.resize(String(id || ""), generation, cols, rows));
  }

  ipcMain.handle("remote-agent:audit-list", (_event, { sessionId }) => remoteAgentBridgeService.listAudit(sessionId));
  ipcMain.handle("remote-agent:approval-list", () => remoteAgentBridgeService.listPendingApprovals());
  ipcMain.handle("remote-agent:approval-resolve", (_event, { id, decision }) => remoteAgentBridgeService.resolveApproval(id, decision));
  ipcMain.handle("codex-workspace-trust:list", () => codexWorkspaceTrustService.listPending());
  ipcMain.handle("codex-workspace-trust:project", (_event, id) => codexWorkspaceTrustService.approveProject(id));
  ipcMain.handle("codex-workspace-trust:open-hooks", (_event, id) => codexWorkspaceTrustService.openHooks(id));
  ipcMain.handle("codex-workspace-trust:write", (_event, id, data) => codexWorkspaceTrustService.writeTerminal(id, data));
  ipcMain.handle("codex-workspace-trust:resize", (_event, id, cols, rows) => codexWorkspaceTrustService.resizeTerminal(id, cols, rows));
  ipcMain.handle("codex-workspace-trust:finish", (_event, id) => codexWorkspaceTrustService.finishHooks(id));
  ipcMain.handle("codex-workspace-trust:cancel", (_event, id) => codexWorkspaceTrustService.cancel(id));

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

  ipcMain.handle("clipboard:upload-image-to-session", async (event, sessionId) => {
    const ownerWindow = windowManager.getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(ownerWindow, {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { status: "canceled" };
    }
    return clipboardImageService.uploadImageToSession(sessionId, result.filePaths[0]);
  });

  ipcMain.handle("external-link:open", async (_event, url) => {
    try {
      await openExternalHttpUrl(shellApi, url);
    } catch (err) {
      console.error("Failed to open external link:", err);
      throw err;
    }
  });

  ipcMain.on("terminal:write", (_event, { id, data }) => {
    terminalManager.write(id, data);
  });

  ipcMain.on("terminal:resize", (_event, { id, cols, rows }) => {
    // A renderer resize can arrive after the terminal has already closed.
    if (!terminalManager.getSession(id)) return;
    if (mobileRemoteService) mobileRemoteService.resizeFromDesktop(id, cols, rows);
    else terminalManager.resize(id, cols, rows);
  });

  ipcMain.on("terminal:claim-size", (_event, { id, cols, rows }) => {
    if (!terminalManager.getSession(id)) return;
    if (mobileRemoteService) mobileRemoteService.claimDesktopSize(id, cols, rows);
    else terminalManager.resize(id, cols, rows);
  });

  ipcMain.handle("remote-system:metrics", (_event, { sessionId }) => {
    return remoteSystemService.getMetrics(sessionId);
  });

  ipcMain.handle("skills:read", (_event, { provider, id, sessionId }) => skillsService.read(provider, id, sessionId));
  ipcMain.handle("skills:list", (_event, { provider, sessionId }) => skillsService.list(provider, sessionId));

  ipcMain.handle("mcp:list", (_event, request) => mcpConfigService.list(request));

  ipcMain.handle("mcp:reveal", (_event, request) => mcpConfigService.reveal(request));

  ipcMain.handle("mcp:save", (_event, request) => mcpConfigService.save(request));

  ipcMain.handle("mcp:remove", (_event, request) => mcpConfigService.remove(request));

  ipcMain.handle("mcp:copy", (_event, request) => mcpConfigService.copy(request));
  if (sessionApiService) {
    ipcMain.handle("session-api:get", () => sessionApiService.status());
    ipcMain.handle("session-api:configure", (_event, input) => sessionApiService.configure(input));
    ipcMain.handle("session-api:reveal-token", () => sessionApiService.revealToken());
    ipcMain.handle("session-api:reset-token", () => sessionApiService.resetToken());
    ipcMain.handle("session-api:invoke", (_event, input) => sessionApiService.invoke(input));
  }
  if (moduleOwnerService) {
    for (const method of ["listQuickPrompts", "mutateQuickPrompt", "list", "get", "preview", "execute", "markCompleted", "listAttempts", "getAttempt", "void", "restore", "resolveUncertain", "setFollowUp"]) {
      ipcMain.handle(`work-items:${method}`, (_event, input) => moduleOwnerService.workItems[method](input));
    }
    for (const method of ["listPromptTemplates", "savePromptTemplate", "deletePromptTemplate", "previewPromptPublish", "publishPromptTemplate"]) {
      ipcMain.handle(`module-owners:${method}`, (_event, input) => moduleOwnerService[method](input));
    }
    ipcMain.handle("module-owners:templates", () => moduleOwnerService.listTemplates());
    for (const method of ["get", "getGeneration", "preview", "generate", "mutate", "configure", "restore", "listHistory", "listTaskRuns", "getTaskRun", "deleteTaskRun", "listTasks", "runTask", "copyTask", "saveTask", "deleteTask"]) {
      ipcMain.handle(`module-owners:${method}`, (_event, id, input) => moduleOwnerService[method](id, input));
    }
  }
  ipcMain.handle("mcp-session-status:get", () => sessionStatusServer.status());
  ipcMain.handle("mcp-session-status:enable", (_event, enabled) => sessionStatusServer.setEnabled(enabled));
  ipcMain.handle("mcp-session-status:reveal-token", () => sessionStatusServer.revealToken());

  ipcMain.handle("project-search:list-directories", (_event, { sessionId, rootPath }) => {
    return projectSearchService.listDirectories(sessionId, rootPath);
  });

  ipcMain.handle("project-search:files", (_event, { sessionId, query, rootPath, options }) => {
    return projectSearchService.searchFiles(sessionId, query, rootPath, options);
  });

  ipcMain.handle("project-search:workspace-entries", (_event, { sessionId, query, rootPath, options }) => {
    return projectSearchService.searchWorkspaceEntries(sessionId, query, rootPath, options);
  });

  ipcMain.handle("project-search:text", (_event, { sessionId, query, requestId, rootPath, options }) => {
    return projectSearchService.searchText(sessionId, query, requestId, rootPath, options);
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

  ipcMain.handle("workbuddy-checkin:get-status", () => workBuddyCheckinService.getStatus());

  ipcMain.handle("workbuddy-checkin:claim", () => workBuddyCheckinService.claim());

  ipcMain.handle("agent-conversation:get-snapshot", () => agentConversationManager.getSnapshot());
  ipcMain.handle("agent-conversation:list-history", (_event, input) => agentConversationHistoryService.listHistory(input));
  ipcMain.handle("agent-conversation:get-history-messages", (_event, input) => agentConversationHistoryService.getHistoryMessages(input));
  ipcMain.on("agent-conversation:set-active-session", (_event, sessionId) => {
    agentConversationManager.setActiveSession(sessionId);
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
    windowManager.requestClose();
  });
  ipcMain.on("window:resolve-close", (_event, confirmed) => windowManager.resolveClose(Boolean(confirmed)));
  ipcMain.on("window:close-listener-ready", (event, ready) => windowManager.setCloseListenerReady(event, ready));
}

module.exports = {
  registerIpcHandlers,
  updateSessionFromIpc
};
