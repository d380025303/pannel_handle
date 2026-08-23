const { ipcMain } = require("electron");
const fs = require("node:fs");
const { openExternalHttpUrl } = require("./external-link.cjs");
const { VALID_LOCALES, VALID_THEME_IDS } = require("../stores/config-store.cjs");

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

function registerIpcHandlers({ terminalManager, agentSessionLauncher, sessionStore, launchTemplateStore, launchTemplateService, configStore, dingTalkConfigStore, dingTalkNotificationManager, windowManager, agentConversationManager, agentConversationHistoryService, clipboard, clipboardImageService, dialog, shellApi, disconnectFileSession, remoteSystemService, skillsService, mcpConfigService, agentUsageService, workBuddyCheckinService, workBuddyAutoCheckinService, agentTokenStatsStore, agentTokenStatsService, hookConfigManager, remoteHookConfigService, projectSearchService, mobileRemoteService, remoteAgentBridgeService }) {

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

  ipcMain.handle("sessions:update", async (_event, { id, title, cwd, preferredDiskMountPoint, initialCommand, agentProvider, agentLocation, localAgentCwd, sshConfig, quickCommands, tags }) => {
    return terminalManager.updateSession(id, { title, cwd, preferredDiskMountPoint, initialCommand, agentProvider, agentLocation, localAgentCwd, sshConfig, quickCommands, tags });
  });

  ipcMain.handle("sessions:switch-agent", async (_event, { id, provider }) => {
    return agentSessionLauncher.switchAgent(String(id || ""), provider);
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

  ipcMain.handle("terminal:history", (_event, id) => terminalManager.getHistory(id));

  ipcMain.handle("remote-agent:audit-list", (_event, { sessionId }) => remoteAgentBridgeService.listAudit(sessionId));
  ipcMain.handle("remote-agent:approval-list", () => remoteAgentBridgeService.listPendingApprovals());
  ipcMain.handle("remote-agent:approval-resolve", (_event, { id, decision }) => remoteAgentBridgeService.resolveApproval(id, decision));

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
    if (mobileRemoteService) mobileRemoteService.resizeFromDesktop(id, cols, rows);
    else terminalManager.resize(id, cols, rows);
  });

  ipcMain.on("terminal:claim-size", (_event, { id, cols, rows }) => {
    if (mobileRemoteService) mobileRemoteService.claimDesktopSize(id, cols, rows);
    else terminalManager.resize(id, cols, rows);
  });

  ipcMain.handle("mobile-access:get-state", () => mobileRemoteService.getState());
  ipcMain.handle("mobile-access:update-config", (_event, partial) => mobileRemoteService.updateConfig(partial));
  ipcMain.handle("mobile-access:create-pairing", () => mobileRemoteService.createPairing());
  ipcMain.handle("mobile-access:list-audit", () => mobileRemoteService.listAudit());
  ipcMain.handle("mobile-access:revoke-device", (_event, deviceId) => mobileRemoteService.revokeDevice(deviceId));
  ipcMain.handle("mobile-access:disconnect-device", () => mobileRemoteService.disconnectActiveDevice());

  ipcMain.handle("remote-system:metrics", (_event, { sessionId }) => {
    return remoteSystemService.getMetrics(sessionId);
  });

  ipcMain.handle("skills:list", (_event, { provider }) => skillsService.list(provider));

  ipcMain.handle("mcp:list", (_event, request) => mcpConfigService.list(request));

  ipcMain.handle("mcp:reveal", (_event, request) => mcpConfigService.reveal(request));

  ipcMain.handle("mcp:save", (_event, request) => mcpConfigService.save(request));

  ipcMain.handle("mcp:remove", (_event, request) => mcpConfigService.remove(request));

  ipcMain.handle("agent-usage:get", (_event, { sessionId, force }) => {
    return agentUsageService.getUsage(sessionId, { force: Boolean(force) });
  });

  ipcMain.handle("agent-usage:consume-reset-credit", (_event, { sessionId, creditId, idempotencyKey }) => {
    return agentUsageService.consumeResetCredit(sessionId, { creditId, idempotencyKey });
  });

  ipcMain.on("agent-usage:cancel", (_event, { sessionId }) => {
    agentUsageService.disconnect(sessionId);
  });

  ipcMain.handle("agent-token-stats:get", (_event, options) => agentTokenStatsStore.getDashboard(options));
  ipcMain.handle("agent-token-live:get", (_event, { sessionId }) => agentTokenStatsService.getLive(sessionId));
  ipcMain.handle("agent-token-stats:clear", () => {
    agentTokenStatsStore.clear();
    return true;
  });

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

  ipcMain.handle("config:get", () => configStore.getConfig());

  ipcMain.handle("config:set", (_event, partial) => {
    const updates = {};
    if (partial && typeof partial.autoRestore === "boolean") {
      updates.autoRestore = partial.autoRestore;
    }
    if (partial && typeof partial.autoWorkBuddyCheckin === "boolean") {
      updates.autoWorkBuddyCheckin = partial.autoWorkBuddyCheckin;
    }
    if (partial && typeof partial.debugMode === "boolean") {
      updates.debugMode = partial.debugMode;
    }
    if (partial && typeof partial.themeId === "string" && VALID_THEME_IDS.has(partial.themeId)) {
      updates.themeId = partial.themeId;
    }
    if (partial && typeof partial.locale === "string" && VALID_LOCALES.has(partial.locale)) {
      updates.locale = partial.locale;
    }
    if (partial && typeof partial.rightToolsWidth === "number"
      && partial.rightToolsWidth >= 280 && partial.rightToolsWidth <= 600) {
      updates.rightToolsWidth = partial.rightToolsWidth;
    }
    if (Object.keys(updates).length > 0) {
      configStore.updateConfig(updates);
    }
    const config = configStore.getConfig();
    if (Object.prototype.hasOwnProperty.call(updates, "autoWorkBuddyCheckin")) {
      workBuddyAutoCheckinService?.setEnabled(config.autoWorkBuddyCheckin);
    }
    return config;
  });

  ipcMain.handle("dingtalk:get-config", () => dingTalkConfigStore.getConfig());

  ipcMain.handle("dingtalk:set-config", (_event, input) => {
    return dingTalkNotificationManager.updateConfig(input);
  });

  ipcMain.handle("dingtalk:clear-credentials", () => {
    return dingTalkNotificationManager.clearCredentials();
  });

  ipcMain.handle("dingtalk:test", () => dingTalkNotificationManager.testConnection());

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
}

module.exports = {
  registerIpcHandlers
};
