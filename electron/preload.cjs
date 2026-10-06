const { contextBridge, ipcRenderer, webUtils } = require("electron");

function getDroppedFilePaths(files) {
  return Array.from(files || [])
    .map((file) => {
      if (typeof file === "string") {
        return file.trim();
      }
      const filePath = webUtils.getPathForFile(file);
      return filePath || file.path || "";
    })
    .filter(Boolean);
}

contextBridge.exposeInMainWorld("environmentApi", {
  list: () => ipcRenderer.invoke("environment:list"),
  save: (input) => ipcRenderer.invoke("environment:save", input),
  delete: (id) => ipcRenderer.invoke("environment:delete", id),
  preview: (input) => ipcRenderer.invoke("environment:preview", input)
});

contextBridge.exposeInMainWorld("launchTemplateApi", {
  list: () => ipcRenderer.invoke("launch-templates:list"),
  create: input => ipcRenderer.invoke("launch-templates:create", input),
  update: (id, input) => ipcRenderer.invoke("launch-templates:update", id, input),
  delete: id => ipcRenderer.invoke("launch-templates:delete", id),
  launch: id => ipcRenderer.invoke("launch-templates:launch", id)
});

contextBridge.exposeInMainWorld("agentConversationApi", {
  setActiveSession: sessionId => ipcRenderer.send("agent-conversation:set-active-session", sessionId),
  getSnapshot: () => ipcRenderer.invoke("agent-conversation:get-snapshot"),
  listHistory: input => ipcRenderer.invoke("agent-conversation:list-history", input),
  getHistoryMessages: input => ipcRenderer.invoke("agent-conversation:get-history-messages", input),
  openExternal: url => ipcRenderer.invoke("external-link:open", url).then(() => ({ ok: true })),
  onSnapshot: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("agent-conversation:snapshot", listener);
    return () => ipcRenderer.removeListener("agent-conversation:snapshot", listener);
  }
});

contextBridge.exposeInMainWorld("mobileAccessApi", {
  getState: () => ipcRenderer.invoke("mobile-access:get-state"),
  updateConfig: partial => ipcRenderer.invoke("mobile-access:update-config", partial),
  setPassword: password => ipcRenderer.invoke("mobile-access:set-password", password),
  listAudit: () => ipcRenderer.invoke("mobile-access:list-audit"),
  disconnectConnection: connectionId => ipcRenderer.invoke("mobile-access:disconnect-connection", connectionId),
  onStateChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("mobile-access:state-changed", listener);
    return () => ipcRenderer.removeListener("mobile-access:state-changed", listener);
  }
});

contextBridge.exposeInMainWorld("clipboardApi", {
  writeText: text => ipcRenderer.invoke("clipboard:write-text", text),
  readText: () => ipcRenderer.invoke("clipboard:read-text"),
  pasteImageToSession: sessionId => ipcRenderer.invoke("clipboard:paste-image-to-session", sessionId),
  uploadImageToSession: sessionId => ipcRenderer.invoke("clipboard:upload-image-to-session", sessionId)
});

contextBridge.exposeInMainWorld("externalLinkApi", {
  open: url => ipcRenderer.invoke("external-link:open", url)
});

contextBridge.exposeInMainWorld("remoteSystemApi", {
  getMetrics: sessionId => ipcRenderer.invoke("remote-system:metrics", { sessionId })
});

contextBridge.exposeInMainWorld("skillsApi", {
  list: (provider, sessionId) => ipcRenderer.invoke("skills:list", { provider, sessionId })
});

contextBridge.exposeInMainWorld("mcpApi", {
  list: request => ipcRenderer.invoke("mcp:list", request),
  reveal: request => ipcRenderer.invoke("mcp:reveal", request),
  save: request => ipcRenderer.invoke("mcp:save", request),
  remove: request => ipcRenderer.invoke("mcp:remove", request),
  copy: request => ipcRenderer.invoke("mcp:copy", request)
});

contextBridge.exposeInMainWorld("sessionStatusMcpApi", {
  get: () => ipcRenderer.invoke("mcp-session-status:get"),
  setEnabled: enabled => ipcRenderer.invoke("mcp-session-status:enable", enabled),
  revealToken: () => ipcRenderer.invoke("mcp-session-status:reveal-token"),
  onChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("mcp-session-status:changed", listener);
    return () => ipcRenderer.removeListener("mcp-session-status:changed", listener);
  }
});

contextBridge.exposeInMainWorld("hookConfigApi", {
  selectProjectDirectory: defaultPath => ipcRenderer.invoke("hooks:select-project-directory", defaultPath),
  inspect: (target, providers) => ipcRenderer.invoke("hooks:inspect", { target, providers }),
  install: (target, providers) => ipcRenderer.invoke("hooks:install", { target, providers })
});

contextBridge.exposeInMainWorld("dingTalkApi", {
  getConfig: () => ipcRenderer.invoke("dingtalk:get-config"),
  setConfig: input => ipcRenderer.invoke("dingtalk:set-config", input),
  clearCredentials: () => ipcRenderer.invoke("dingtalk:clear-credentials"),
  test: () => ipcRenderer.invoke("dingtalk:test")
});

contextBridge.exposeInMainWorld("remoteFileApi", {
  getHome: sessionId => ipcRenderer.invoke("remote-files:home", { sessionId }),
  list: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:list", { sessionId, remotePath }),
  readText: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:read-text", { sessionId, remotePath }),
  previewFile: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:preview-file", { sessionId, remotePath }),
  releasePreview: previewId => ipcRenderer.invoke("remote-files:release-preview", { previewId }),
  writeText: (sessionId, remotePath, content, expectedVersion, options) => ipcRenderer.invoke("remote-files:write-text", { sessionId, remotePath, content, expectedVersion, options }),
  createEntry: (sessionId, parentPath, name, kind, conflictPolicy) => ipcRenderer.invoke("remote-files:create", { sessionId, parentPath, name, kind, conflictPolicy }),
  moveEntry: (sessionId, sourcePath, targetDirectory, name, conflictPolicy) => ipcRenderer.invoke("remote-files:move", { sessionId, sourcePath, targetDirectory, name, conflictPolicy }),
  chooseRoot: (sessionId, currentRoot) => ipcRenderer.invoke("remote-files:choose-root", { sessionId, currentRoot }),
  uploadFile: (sessionId, remoteDir) => ipcRenderer.invoke("remote-files:upload-file", { sessionId, remoteDir }),
  uploadDroppedFiles: (sessionId, remoteDir, files) => ipcRenderer.invoke("remote-files:upload-files", { sessionId, remoteDir, localPaths: getDroppedFilePaths(files) }),
  downloadFile: (transferId, sessionId, remotePath, fileName) => ipcRenderer.invoke("remote-files:download-file", { transferId, sessionId, remotePath, fileName }),
  startDownloadDrag: (transferId, sessionId, remotePath, fileName) => ipcRenderer.invoke("remote-files:start-download-drag", { transferId, sessionId, remotePath, fileName }),
  cancelDownload: transferId => ipcRenderer.invoke("remote-files:cancel-download", { transferId }),
  onDownloadProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("remote-files:download-progress", listener);
    return () => ipcRenderer.removeListener("remote-files:download-progress", listener);
  },
  openInExplorer: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:open-in-explorer", { sessionId, remotePath }),
  deleteEntry: (sessionId, remotePath, options) => ipcRenderer.invoke("remote-files:delete", { sessionId, remotePath, options }),
  watchDirectories: (sessionId, directories) => ipcRenderer.invoke("remote-files:watch", { sessionId, directories }),
  unwatchDirectories: sessionId => ipcRenderer.invoke("remote-files:unwatch", { sessionId }),
  onChanged: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-files:changed", listener);
    return () => ipcRenderer.removeListener("remote-files:changed", listener);
  },
  onWatchError: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-files:watch-error", listener);
    return () => ipcRenderer.removeListener("remote-files:watch-error", listener);
  }
});

contextBridge.exposeInMainWorld("projectAssistantApi", {
  getSnapshot: () => ipcRenderer.invoke("project-assistant:snapshot"),
  start: () => ipcRenderer.invoke("project-assistant:start"),
  newConversation: () => ipcRenderer.invoke("project-assistant:new-conversation"),
  send: (text, sessionId) => ipcRenderer.invoke("project-assistant:send", text, sessionId),
  resolve: approved => ipcRenderer.invoke("project-assistant:resolve", approved),
  stop: () => ipcRenderer.invoke("project-assistant:stop"),
  readAccount: () => ipcRenderer.invoke("project-assistant:account-read"),
  startLogin: type => ipcRenderer.invoke("project-assistant:account-login", type),
  cancelLogin: () => ipcRenderer.invoke("project-assistant:account-cancel"),
  logout: () => ipcRenderer.invoke("project-assistant:account-logout"),
  refreshAccountUsage: () => ipcRenderer.invoke("project-assistant:account-usage"),
  listCodexSessions: () => ipcRenderer.invoke("project-assistant:codex-sessions"),
  getCodexScreen: sessionId => ipcRenderer.invoke("project-assistant:codex-screen", sessionId),
  getCodexDeltas: (sessionId, afterSeq) => ipcRenderer.invoke("project-assistant:codex-deltas", sessionId, afterSeq),
  writeCodex: (sessionId, data) => ipcRenderer.invoke("project-assistant:codex-write", sessionId, data),
  submitCodex: (sessionId, text) => ipcRenderer.invoke("project-assistant:codex-submit", sessionId, text),
  switchCodexMode: sessionId => ipcRenderer.invoke("project-assistant:codex-mode", sessionId),
  onChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("project-assistant:changed", listener);
    return () => ipcRenderer.removeListener("project-assistant:changed", listener);
  },
  onProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("project-assistant:progress", listener);
    return () => ipcRenderer.removeListener("project-assistant:progress", listener);
  }
});

contextBridge.exposeInMainWorld("codexAppServerApi", {
  setupWindowsSandbox: (id, mode) => ipcRenderer.invoke("codex-app-server:windows-sandbox-setup", id, mode),
  setSubAgentView: (id, expanded, threadId, rootThreadId) => ipcRenderer.invoke("codex-app-server:sub-agent-view", id, expanded, threadId, rootThreadId),
  refreshSubAgents: (id, rootThreadId) => ipcRenderer.invoke("codex-app-server:sub-agents-refresh", id, rootThreadId),
  snapshot: id => ipcRenderer.invoke("codex-app-server:snapshot", id),
  listModelMetadata: id => ipcRenderer.invoke("codex-app-server:model-metadata", id),
  readAccount: id => ipcRenderer.invoke("codex-app-server:account-read", id),
  startLogin: (id, type) => ipcRenderer.invoke("codex-app-server:account-login", id, type),
  cancelLogin: id => ipcRenderer.invoke("codex-app-server:account-cancel", id),
  logout: id => ipcRenderer.invoke("codex-app-server:account-logout", id),
  refreshAccountUsage: id => ipcRenderer.invoke("codex-app-server:account-usage", id),
  listHistory: (id, cursor, archived, isPinned) => ipcRenderer.invoke("codex-app-server:history", id, cursor, archived, isPinned),
  readInitialUserInput: (id, threadId) => ipcRenderer.invoke("codex-app-server:initial-user-input", id, threadId),
  revertThread: (id, messageId) => ipcRenderer.invoke("codex-app-server:revert-thread", id, messageId),
  restoreThread: id => ipcRenderer.invoke("codex-app-server:restore-thread", id),
  renameThread: (id, threadId, name) => ipcRenderer.invoke("codex-app-server:rename-thread", id, threadId, name),
  rewind: (id, messageId, scope) => ipcRenderer.invoke("codex-app-server:rewind", id, messageId, scope),
  pinThread: (id, threadId, isPinned) => ipcRenderer.invoke("codex-app-server:pin-thread", id, threadId, isPinned),
  forkTurnToNewSession: (id, threadId, turnId) => ipcRenderer.invoke("codex-app-server:fork-turn-new-session", id, threadId, turnId),
  forkThread: (id, threadId, lastTurnId) => ipcRenderer.invoke("codex-app-server:fork-thread", id, threadId, lastTurnId),
  deleteThread: (id, threadId) => ipcRenderer.invoke("codex-app-server:delete-thread", id, threadId),
  archiveThread: (id, threadId) => ipcRenderer.invoke("codex-app-server:archive-thread", id, threadId),
  unarchiveThread: (id, threadId) => ipcRenderer.invoke("codex-app-server:unarchive-thread", id, threadId),
  listCapabilities: (id, refresh) => ipcRenderer.invoke("codex-app-server:capabilities", id, refresh),
  readPluginDetail: (id, plugin, marketplace) => ipcRenderer.invoke("codex-app-server:plugin-detail", id, plugin, marketplace),
  readPluginSkill: (id, plugin, marketplace, skill) => ipcRenderer.invoke("codex-app-server:plugin-skill", id, plugin, marketplace, skill),
  readAppDetail: (id, appId) => ipcRenderer.invoke("codex-app-server:app-detail", id, appId),
  readMcpResource: (id, server, uri) => ipcRenderer.invoke("codex-app-server:mcp-resource", id, server, uri),
  loginMcpServer: (id, name) => ipcRenderer.invoke("codex-app-server:mcp-login", id, name),
  reloadMcpServers: id => ipcRenderer.invoke("codex-app-server:mcp-reload", id),
  resume: (id, threadId) => ipcRenderer.invoke("codex-app-server:resume", id, threadId),
  newThread: id => ipcRenderer.invoke("codex-app-server:new-thread", id),
  startReview: (id, target) => ipcRenderer.invoke("codex-app-server:review", id, target),
  compactThread: id => ipcRenderer.invoke("codex-app-server:compact", id),
  listBackgroundTerminals: id => ipcRenderer.invoke("codex-app-server:background-terminals-list", id),
  terminateBackgroundTerminal: (id, processId) => ipcRenderer.invoke("codex-app-server:background-terminal-terminate", id, processId),
  cleanBackgroundTerminals: id => ipcRenderer.invoke("codex-app-server:background-terminals-clean", id),
  listScheduledTasks: (id, threadId) => ipcRenderer.invoke("codebuddy-scheduled-tasks:list", id, threadId),
  createScheduledTask: (id, threadId, input) => ipcRenderer.invoke("codebuddy-scheduled-tasks:create", id, threadId, input),
  deleteScheduledTask: (id, threadId, taskId) => ipcRenderer.invoke("codebuddy-scheduled-tasks:delete", id, threadId, taskId),
  listJobs: id => ipcRenderer.invoke("codebuddy-jobs:list", id),
  jobDispatchContext: id => ipcRenderer.invoke("codebuddy-jobs:dispatch-context", id),
  listResumableJobs: id => ipcRenderer.invoke("codebuddy-jobs:resumable", id),
  dispatchJob: (id, input) => ipcRenderer.invoke("codebuddy-jobs:dispatch", id, input),
  resumeJob: (id, sessionId) => ipcRenderer.invoke("codebuddy-jobs:resume", id, sessionId),
  jobTranscript: (id, jobId) => ipcRenderer.invoke("codebuddy-jobs:transcript-read", id, jobId),
  jobAction: (id, jobId, action, input) => ipcRenderer.invoke("codebuddy-jobs:action", id, jobId, action, input),
  watchJob: (id, jobId) => ipcRenderer.invoke("codebuddy-jobs:watch", id, jobId),
  unwatchJob: (id, jobId) => ipcRenderer.invoke("codebuddy-jobs:unwatch", id, jobId),
  onJobsEvent: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on("codebuddy-jobs:event", listener); return () => ipcRenderer.removeListener("codebuddy-jobs:event", listener); },
  onJobTranscript: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on("codebuddy-jobs:transcript", listener); return () => ipcRenderer.removeListener("codebuddy-jobs:transcript", listener); },
  getGoal: id => ipcRenderer.invoke("codex-app-server:goal-get", id),
  setGoal: (id, changes) => ipcRenderer.invoke("codex-app-server:goal-set", id, changes),
  clearGoal: id => ipcRenderer.invoke("codex-app-server:goal-clear", id),
  refreshGoal: id => ipcRenderer.invoke("codex-app-server:goal-refresh", id),
  setMode: (id, mode) => ipcRenderer.invoke("codex-app-server:mode", id, mode),
  setNativeMode: (id, modeId) => ipcRenderer.invoke("codex-app-server:native-mode", id, modeId),
  setModel: (id, modelId) => ipcRenderer.invoke("codex-app-server:model", id, modelId),
  listMainAgents: id => ipcRenderer.invoke("codex-app-server:main-agents", id),
  setMainAgent: (id, agentName) => ipcRenderer.invoke("codex-app-server:main-agent", id, agentName),
  setContextWindow: (id, value) => ipcRenderer.invoke("codex-app-server:context-window", id, value),
  setEffort: (id, effort) => ipcRenderer.invoke("codex-app-server:effort", id, effort),
  setMultitask: (id, enabled) => ipcRenderer.invoke("codex-app-server:multitask", id, enabled),
  sendTeamMessage: (id, teamName, memberName, text) => ipcRenderer.invoke("codex-app-server:team-message", id, teamName, memberName, text),
  setFastMode: (id, enabled) => ipcRenderer.invoke("codex-app-server:fast-mode", id, enabled),
  setExecutionPermission: (id, permission) => ipcRenderer.invoke("codex-app-server:execution-permission", id, permission),
  dismissPlan: (id, itemId) => ipcRenderer.invoke("codex-app-server:dismiss-plan", id, itemId),
  executePlan: (id, itemId) => ipcRenderer.invoke("codex-app-server:execute-plan", id, itemId),
  chooseFiles: id => ipcRenderer.invoke("codex-app-server:choose-files", id),
  previewAttachment: (id, filePath) => ipcRenderer.invoke("codex-app-server:preview-attachment", id, filePath),
  pasteImage: id => ipcRenderer.invoke("codex-app-server:paste-image", id),
  discardImage: (id, filePath) => ipcRenderer.invoke("codex-app-server:discard-image", id, filePath),
  askSideQuestion: (id, question) => ipcRenderer.invoke("codex-app-server:ask-side-question", id, question),
  cancelSideQuestion: (id, requestId) => ipcRenderer.invoke("codex-app-server:cancel-side-question", id, requestId),
  submit: (id, text, filePaths, references, orderedContent) => ipcRenderer.invoke("codex-app-server:submit", id, text, filePaths, references, orderedContent),
  interrupt: id => ipcRenderer.invoke("codex-app-server:interrupt", id),
  resolveApproval: (id, requestId, decision) => ipcRenderer.invoke("codex-app-server:approval", id, requestId, decision),
  answerQuestion: (id, requestId, answers) => ipcRenderer.invoke("codex-app-server:answer-question", id, requestId, answers),
  cancelQuestion: (id, requestId) => ipcRenderer.invoke("codex-app-server:cancel-question", id, requestId),
  resolveElicitation: (id, requestId, action, content) => ipcRenderer.invoke("codex-app-server:resolve-elicitation", id, requestId, action, content),
  onChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("codex-app-server:changed", listener);
    return () => ipcRenderer.removeListener("codex-app-server:changed", listener);
  },
  onDelta: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("codex-app-server:delta", listener);
    return () => ipcRenderer.removeListener("codex-app-server:delta", listener);
  }
});

contextBridge.exposeInMainWorld("codexVersionApi", {
  check: (id, force) => ipcRenderer.invoke("codex-version:check", id, force === true),
  update: id => ipcRenderer.invoke("codex-version:update", id)
});

contextBridge.exposeInMainWorld("codeBuddyVersionApi", {
  check: (id, force) => ipcRenderer.invoke("codebuddy-version:check", id, force === true),
  update: id => ipcRenderer.invoke("codebuddy-version:update", id)
});

contextBridge.exposeInMainWorld("openCodeVersionApi", {
  check: (id, force) => ipcRenderer.invoke("opencode-version:check", id, force === true),
  update: id => ipcRenderer.invoke("opencode-version:update", id)
});

contextBridge.exposeInMainWorld("codexPluginApi", {
  list: id => ipcRenderer.invoke("codex-plugin:list", id),
  install: (id, plugin, marketplace) => ipcRenderer.invoke("codex-plugin:install", id, plugin, marketplace),
  uninstall: (id, plugin, marketplace) => ipcRenderer.invoke("codex-plugin:uninstall", id, plugin, marketplace),
  addMarketplace: (id, source) => ipcRenderer.invoke("codex-plugin:marketplace-add", id, source),
  refreshMarketplace: (id, name) => ipcRenderer.invoke("codex-plugin:marketplace-refresh", id, name),
  removeMarketplace: (id, name) => ipcRenderer.invoke("codex-plugin:marketplace-remove", id, name),
  readConfig: (id, scope) => ipcRenderer.invoke("codex-plugin:config", id, scope),
  setEnabled: (id, scope, input) => ipcRenderer.invoke("codex-plugin:enable", id, scope, input)
});
contextBridge.exposeInMainWorld("codeBuddyMcpApi", {
  restart: id => ipcRenderer.invoke("codebuddy-mcp:restart", id),
  images: (id, threadId, itemId, images) => ipcRenderer.invoke("codebuddy-mcp:images", id, threadId, itemId, images),
  runtime: id => ipcRenderer.invoke("codebuddy-mcp:runtime", id),
  load: (id, threadId, itemId) => ipcRenderer.invoke("codebuddy-mcp:load", id, threadId, itemId),
  read: (id, threadId, itemId, uri) => ipcRenderer.invoke("codebuddy-mcp:read", id, threadId, itemId, uri),
  prepare: (id, threadId, itemId, name, args) => ipcRenderer.invoke("codebuddy-mcp:prepare", id, threadId, itemId, name, args),
  resolve: (id, token, approved) => ipcRenderer.invoke("codebuddy-mcp:resolve", id, token, approved),
  dispose: (id, threadId, itemId) => ipcRenderer.invoke("codebuddy-mcp:dispose", id, threadId, itemId)
});
contextBridge.exposeInMainWorld("codeBuddyPluginApi", {
  list: id => ipcRenderer.invoke("codebuddy-plugin:list", id),
  reload: id => ipcRenderer.invoke("codebuddy-plugin:reload", id),
  install: (id, name, marketplace, scope) => ipcRenderer.invoke("codebuddy-plugin:install", id, name, marketplace, scope),
  uninstall: (id, name, marketplace, scope) => ipcRenderer.invoke("codebuddy-plugin:uninstall", id, name, marketplace, scope),
  enable: (id, name, marketplace, scope) => ipcRenderer.invoke("codebuddy-plugin:enable", id, name, marketplace, scope),
  disable: (id, name, marketplace, scope) => ipcRenderer.invoke("codebuddy-plugin:disable", id, name, marketplace, scope),
  update: (id, name, marketplace, scope) => ipcRenderer.invoke("codebuddy-plugin:update", id, name, marketplace, scope),
  addMarketplace: (id, source, name, autoUpdate) => ipcRenderer.invoke("codebuddy-plugin:addMarketplace", id, source, name, autoUpdate),
  refreshMarketplace: (id, name) => ipcRenderer.invoke("codebuddy-plugin:refreshMarketplace", id, name),
  removeMarketplace: (id, name) => ipcRenderer.invoke("codebuddy-plugin:removeMarketplace", id, name),
  setAutoUpdate: (id, name, enabled) => ipcRenderer.invoke("codebuddy-plugin:setAutoUpdate", id, name, enabled)
});

contextBridge.exposeInMainWorld("terminalApi", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: (options) => ipcRenderer.invoke("sessions:create", options),
  updateSession: (id, updates) => ipcRenderer.invoke("sessions:update", { id, ...updates }),
  switchAgent: (id, provider) => ipcRenderer.invoke("sessions:switch-agent", { id, provider }),
  switchModelSource: (id, source, restart = false, modelId) => ipcRenderer.invoke("sessions:switch-model-source", { id, source, restart, modelId }),
  closeSession: (id) => ipcRenderer.invoke("sessions:close", id),
  reconnectSession: (id) => ipcRenderer.invoke("sessions:reconnect", id),
  getHistory: (id) => ipcRenderer.invoke("terminal:history", id),
  write: (id, data) => ipcRenderer.send("terminal:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  claimSize: (id, cols, rows) => ipcRenderer.send("terminal:claim-size", { id, cols, rows }),
  onData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  onSizeOwner: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:size-owner", listener);
    return () => ipcRenderer.removeListener("terminal:size-owner", listener);
  },
  onAgentStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:status", listener);
    return () => ipcRenderer.removeListener("agent:status", listener);
  },
  onAgentHookDebug: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:hook-debug", listener);
    return () => ipcRenderer.removeListener("agent:hook-debug", listener);
  },
  listWslDistros: () => ipcRenderer.invoke("wsl:list-distros"),
  loadSavedSessions: () => ipcRenderer.invoke("sessions:load-saved"),
  exportSavedSessions: () => ipcRenderer.invoke("sessions:export-library"),
  importSavedSessions: () => ipcRenderer.invoke("sessions:import-library"),
  launchSessions: (sessions, launchMode) => ipcRenderer.invoke("sessions:launch-selected", sessions, launchMode),
  deleteSavedSession: (id) => ipcRenderer.invoke("sessions:delete-saved", id),
  duplicateSession: (id) => ipcRenderer.invoke("sessions:duplicate", id),
  duplicateRunningSession: (id) => ipcRenderer.invoke("sessions:duplicate-running", id),
  openOtherSessionMode: (id) => ipcRenderer.invoke("sessions:open-other-mode", id),
  reorderRunningSessions: (orderedIds) => ipcRenderer.invoke("sessions:reorder-running", orderedIds),
  onSessionsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("sessions:changed", listener);
    return () => ipcRenderer.removeListener("sessions:changed", listener);
  },
  onSessionSelectRequested: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("sessions:select-requested", listener);
    return () => ipcRenderer.removeListener("sessions:select-requested", listener);
  },
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial),
  chooseTerminalBackgroundImage: () => ipcRenderer.invoke("terminal-background:choose-image")
});

contextBridge.exposeInMainWorld("openCodeAuthApi", {
  start: (id, methodId) => ipcRenderer.invoke("opencode-auth:start", id, methodId),
  cancel: (id, generation) => ipcRenderer.invoke("opencode-auth:cancel", id, generation),
  write: (id, generation, data) => ipcRenderer.send("opencode-auth:write", id, generation, data),
  resize: (id, generation, cols, rows) => ipcRenderer.send("opencode-auth:resize", id, generation, cols, rows),
  onData: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("opencode-auth:data", listener);
    return () => ipcRenderer.removeListener("opencode-auth:data", listener);
  },
  onState: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("opencode-auth:state", listener);
    return () => ipcRenderer.removeListener("opencode-auth:state", listener);
  }
});

contextBridge.exposeInMainWorld("sessionShellApi", {
  open: (id, ownerToken) => ipcRenderer.invoke("session-shell:open", id, ownerToken),
  close: (id, ownerToken) => ipcRenderer.invoke("session-shell:close", id, ownerToken),
  write: (id, generation, data) => ipcRenderer.send("session-shell:write", { id, generation, data }),
  resize: (id, generation, cols, rows) => ipcRenderer.send("session-shell:resize", { id, generation, cols, rows }),
  onData: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("session-shell:data", listener);
    return () => ipcRenderer.removeListener("session-shell:data", listener);
  },
  onExit: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("session-shell:exit", listener);
    return () => ipcRenderer.removeListener("session-shell:exit", listener);
  }
});

contextBridge.exposeInMainWorld("screenshotApi", {
  captureRegion: () => ipcRenderer.invoke("screenshot:capture-region")
});

contextBridge.exposeInMainWorld("openRouterApi", {
  getConfig: () => ipcRenderer.invoke("openrouter:get-config"),
  listModels: () => ipcRenderer.invoke("openrouter:list-models"),
  refreshModels: () => ipcRenderer.invoke("openrouter:refresh-models"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("openrouter:save-api-key", apiKey),
  clearApiKey: () => ipcRenderer.invoke("openrouter:clear-api-key"),
  test: () => ipcRenderer.invoke("openrouter:test"),
  verifyModels: (input) => ipcRenderer.invoke("openrouter:verify-models", input),
  verifyAgentModels: (input) => ipcRenderer.invoke("openrouter:verify-agent-models", input),
});

contextBridge.exposeInMainWorld("naraRouterApi", {
  getConfig: () => ipcRenderer.invoke("nararouter:get-config"),
  listModels: () => ipcRenderer.invoke("nararouter:list-models"),
  refreshModels: () => ipcRenderer.invoke("nararouter:refresh-models"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("nararouter:save-api-key", apiKey),
  clearApiKey: () => ipcRenderer.invoke("nararouter:clear-api-key"),
  test: () => ipcRenderer.invoke("nararouter:test"),
  verifyModels: (input) => ipcRenderer.invoke("nararouter:verify-models", input),
  verifyAgentModels: (input) => ipcRenderer.invoke("nararouter:verify-agent-models", input),
});

contextBridge.exposeInMainWorld("miniMaxApi", {
  getConfig: () => ipcRenderer.invoke("minimax:get-config"),
  listModels: () => ipcRenderer.invoke("minimax:list-models"),
  refreshModels: () => ipcRenderer.invoke("minimax:refresh-models"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("minimax:save-api-key", apiKey),
  clearApiKey: () => ipcRenderer.invoke("minimax:clear-api-key"),
  test: () => ipcRenderer.invoke("minimax:test"),
  verifyModels: (input) => ipcRenderer.invoke("minimax:verify-models", input),
  verifyAgentModels: (input) => ipcRenderer.invoke("minimax:verify-agent-models", input),
  getUsage: (options) => ipcRenderer.invoke("minimax:get-usage", options)
});

contextBridge.exposeInMainWorld("agentUsageApi", {
  getUsage: (sessionId, options) => ipcRenderer.invoke("agent-usage:get", {
    sessionId,
    force: Boolean(options?.force)
  }),
  getCodeBuddyUsage: (options) => ipcRenderer.invoke("agent-usage:get-codebuddy", {
    force: Boolean(options?.force)
  }),
  getCodexUsage: (options) => ipcRenderer.invoke("agent-usage:get-codex", {
    force: Boolean(options?.force)
  }),
  consumeResetCredit: (sessionId, creditId, idempotencyKey) => ipcRenderer.invoke("agent-usage:consume-reset-credit", {
    sessionId,
    creditId,
    idempotencyKey
  }),
  cancel: (sessionId) => ipcRenderer.send("agent-usage:cancel", { sessionId }),
  cancelCodeBuddyUsage: () => ipcRenderer.send("agent-usage:cancel-codebuddy"),
  cancelCodexUsage: () => ipcRenderer.send("agent-usage:cancel-codex")
});

contextBridge.exposeInMainWorld("workBuddyCheckinApi", {
  getStatus: () => ipcRenderer.invoke("workbuddy-checkin:get-status"),
  claim: () => ipcRenderer.invoke("workbuddy-checkin:claim")
});

contextBridge.exposeInMainWorld("agentTokenStatsApi", {
  getDashboard: (options) => ipcRenderer.invoke("agent-token-stats:get", options),
  getLive: (sessionId) => ipcRenderer.invoke("agent-token-live:get", { sessionId }),
  clear: () => ipcRenderer.invoke("agent-token-stats:clear"),
  onChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent-token-stats:changed", listener);
    return () => ipcRenderer.removeListener("agent-token-stats:changed", listener);
  },
  onLiveChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent-token-live:changed", listener);
    return () => ipcRenderer.removeListener("agent-token-live:changed", listener);
  }
});

contextBridge.exposeInMainWorld("postgresBackupApi", {
  getConfig: () => ipcRenderer.invoke("postgres-backup:get-config"),
  saveConfig: input => ipcRenderer.invoke("postgres-backup:save-config", input),
  testConnection: input => ipcRenderer.invoke("postgres-backup:test", input),
  run: () => ipcRenderer.invoke("postgres-backup:run"),
  listDevices: () => ipcRenderer.invoke("postgres-backup:devices"),
  getDashboard: input => ipcRenderer.invoke("postgres-backup:dashboard", input),
  listSnapshots: deviceId => ipcRenderer.invoke("postgres-backup:snapshots", deviceId),
  restore: (id, passphrase) => ipcRenderer.invoke("postgres-backup:restore", id, passphrase),
  listConversations: (deviceId, offset) => ipcRenderer.invoke("postgres-backup:conversations", deviceId, offset),
  getMessages: (deviceId, sourceKey, ref, offset) => ipcRenderer.invoke("postgres-backup:messages", deviceId, sourceKey, ref, offset),
  deleteDevice: deviceId => ipcRenderer.invoke("postgres-backup:delete-device", deviceId),
  onChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("postgres-backup:changed", listener);
    return () => ipcRenderer.removeListener("postgres-backup:changed", listener);
  }
});

contextBridge.exposeInMainWorld("remoteAgentApi", {
  listAudit: (sessionId) => ipcRenderer.invoke("remote-agent:audit-list", { sessionId }),
  listPendingApprovals: () => ipcRenderer.invoke("remote-agent:approval-list"),
  resolveApproval: (id, decision) => ipcRenderer.invoke("remote-agent:approval-resolve", { id, decision }),
  onAudit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-agent:audit", listener);
    return () => ipcRenderer.removeListener("remote-agent:audit", listener);
  },
  onApprovalRequested: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-agent:approval-requested", listener);
    return () => ipcRenderer.removeListener("remote-agent:approval-requested", listener);
  },
  onApprovalResolved: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-agent:approval-resolved", listener);
    return () => ipcRenderer.removeListener("remote-agent:approval-resolved", listener);
  }
});

contextBridge.exposeInMainWorld("codexWorkspaceTrustApi", {
  listPending: () => ipcRenderer.invoke("codex-workspace-trust:list"),
  trustProject: id => ipcRenderer.invoke("codex-workspace-trust:project", id),
  openHooks: id => ipcRenderer.invoke("codex-workspace-trust:open-hooks", id),
  write: (id, data) => ipcRenderer.invoke("codex-workspace-trust:write", id, data),
  resize: (id, cols, rows) => ipcRenderer.invoke("codex-workspace-trust:resize", id, cols, rows),
  finish: id => ipcRenderer.invoke("codex-workspace-trust:finish", id),
  cancel: id => ipcRenderer.invoke("codex-workspace-trust:cancel", id),
  onChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("codex-workspace-trust:changed", listener);
    return () => ipcRenderer.removeListener("codex-workspace-trust:changed", listener);
  },
  onOutput: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("codex-workspace-trust:output", listener);
    return () => ipcRenderer.removeListener("codex-workspace-trust:output", listener);
  },
  onResolved: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("codex-workspace-trust:resolved", listener);
    return () => ipcRenderer.removeListener("codex-workspace-trust:resolved", listener);
  }
});

contextBridge.exposeInMainWorld("fileTransferApi", {
  list: () => ipcRenderer.invoke("file-transfers:list"),
  chooseUpload: (sessionId, remoteDir) => ipcRenderer.invoke("file-transfers:choose-upload", { sessionId, remoteDir }),
  uploadDroppedFiles: (sessionId, remoteDir, files) => ipcRenderer.invoke("file-transfers:upload-paths", { sessionId, remoteDir, localPaths: getDroppedFilePaths(files) }),
  chooseDownload: (sessionId, remotePath, fileName) => ipcRenderer.invoke("file-transfers:choose-download", { sessionId, remotePath, fileName }),
  chooseDownloadBatch: (sessionId, entries) => ipcRenderer.invoke("file-transfers:choose-download-batch", { sessionId, entries }),
  cancel: (id) => ipcRenderer.invoke("file-transfers:cancel", { id }),
  retry: (id) => ipcRenderer.invoke("file-transfers:retry", { id }),
  resolveConflict: (id, policy) => ipcRenderer.invoke("file-transfers:resolve-conflict", { id, policy }),
  clear: (id) => ipcRenderer.invoke("file-transfers:clear", { id }),
  onChanged: (callback) => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on("file-transfers:changed", listener);
    return () => ipcRenderer.removeListener("file-transfers:changed", listener);
  }
});

contextBridge.exposeInMainWorld("gitApi", {
  getWorkspaceSnapshot: (sessionId) => ipcRenderer.invoke("git:workspace-snapshot", { sessionId }),
  getSnapshot: (target) => ipcRenderer.invoke("git:snapshot", { target }),
  getStatus: (target) => ipcRenderer.invoke("git:status", { target }),
  getDiff: (target, request) => ipcRenderer.invoke("git:diff", { target, request }),
  getBranches: (target) => ipcRenderer.invoke("git:branches", { target }),
  getRemotes: (target) => ipcRenderer.invoke("git:remotes", { target }),
  checkoutBranch: (target, branch, operationId) => ipcRenderer.invoke("git:checkout-branch", { target, branch, operationId }),
  createBranch: (target, branchName, operationId) => ipcRenderer.invoke("git:create-branch", { target, branchName, operationId }),
  getStashes: (target) => ipcRenderer.invoke("git:stashes", { target }),
  getHistory: (target, options) => ipcRenderer.invoke("git:history", { target, options }),
  stageFiles: (target, paths, operationId) => ipcRenderer.invoke("git:stage-files", { target, paths, operationId }),
  stageAll: (target, operationId) => ipcRenderer.invoke("git:stage-all", { target, operationId }),
  unstageFiles: (target, paths, operationId) => ipcRenderer.invoke("git:unstage-files", { target, paths, operationId }),
  unstageAll: (target, operationId) => ipcRenderer.invoke("git:unstage-all", { target, operationId }),
  discardWorkingTree: (target, file, operationId) => ipcRenderer.invoke("git:discard-working-tree", { target, file, operationId }),
  commit: (target, message, operationId) => ipcRenderer.invoke("git:commit", { target, message, operationId }),
  fetch: (target, remote, operationId) => ipcRenderer.invoke("git:fetch", { target, remote, operationId }),
  pull: (target, remote, operationId) => ipcRenderer.invoke("git:pull", { target, remote, operationId }),
  push: (target, remote, operationId) => ipcRenderer.invoke("git:push", { target, remote, operationId }),
  stashChanges: (target, message, operationId) => ipcRenderer.invoke("git:stash-changes", { target, message, operationId }),
  applyStash: (target, ref, operationId) => ipcRenderer.invoke("git:apply-stash", { target, ref, operationId }),
  popStash: (target, ref, operationId) => ipcRenderer.invoke("git:pop-stash", { target, ref, operationId }),
  dropStash: (target, ref, operationId) => ipcRenderer.invoke("git:drop-stash", { target, ref, operationId }),
  revertFile: (target, file, operationId) => ipcRenderer.invoke("git:revert-file", { target, file, operationId }),
  cancelOperation: (operationId) => ipcRenderer.invoke("git:cancel-operation", { operationId })
});

contextBridge.exposeInMainWorld("projectSearchApi", {
  searchWorkspaceEntries: (sessionId, query, rootPath, options) => ipcRenderer.invoke("project-search:workspace-entries", { sessionId, query, rootPath, options }),
  listDirectories: (sessionId, rootPath) => ipcRenderer.invoke("project-search:list-directories", { sessionId, rootPath }),
  searchFiles: (sessionId, query, rootPath, options) => ipcRenderer.invoke("project-search:files", { sessionId, query, rootPath, options }),
  searchText: (sessionId, query, requestId, rootPath, options) => ipcRenderer.invoke("project-search:text", { sessionId, query, requestId, rootPath, options }),
  cancelTextSearch: (sessionId, requestId) => ipcRenderer.invoke("project-search:cancel-text", { sessionId, requestId })
});

contextBridge.exposeInMainWorld("ideaBridgeApi", {
  getSnapshot: () => ipcRenderer.invoke("idea-bridge:snapshot"),
  start: (bridgeId, projectId, configurationId, mode) => ipcRenderer.invoke("idea-bridge:start", { bridgeId, projectId, configurationId, mode }),
  stop: (bridgeId, instanceId) => ipcRenderer.invoke("idea-bridge:stop", { bridgeId, instanceId }),
  stopAll: (bridgeId, projectId, configurationId) => ipcRenderer.invoke("idea-bridge:stop-all", { bridgeId, projectId, configurationId }),
  restart: (bridgeId, instanceId) => ipcRenderer.invoke("idea-bridge:restart", { bridgeId, instanceId }),
  onChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("idea-bridge:changed", listener);
    return () => ipcRenderer.removeListener("idea-bridge:changed", listener);
  }
});

contextBridge.exposeInMainWorld("windowApi", {
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  resolveClose: (confirmed) => ipcRenderer.send("window:resolve-close", confirmed),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("window:close-requested", listener);
    return () => ipcRenderer.removeListener("window:close-requested", listener);
  },
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizedChanged: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on("window:maximized-changed", listener);
    return () => ipcRenderer.removeListener("window:maximized-changed", listener);
  }
});

async function invokeQoderCheckin(channel, accountId) {
  const result = await ipcRenderer.invoke(channel, { accountId });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, retryable: result.error.retryable });
  return result.value;
}
contextBridge.exposeInMainWorld("qoderCheckinApi", {
  getStatus: accountId => invokeQoderCheckin("qoder-checkin:get-status", accountId),
  claim: accountId => invokeQoderCheckin("qoder-checkin:claim", accountId)
});
