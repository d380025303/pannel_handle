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

contextBridge.exposeInMainWorld("terminalApi", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: (options) => ipcRenderer.invoke("sessions:create", options),
  updateSession: (id, updates) => ipcRenderer.invoke("sessions:update", { id, ...updates }),
  switchAgent: (id, provider) => ipcRenderer.invoke("sessions:switch-agent", { id, provider }),
  switchCodexBackend: (id, backend) => ipcRenderer.invoke("sessions:switch-codex-backend", { id, backend }),
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
  setConfig: (partial) => ipcRenderer.invoke("config:set", partial)
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
  setFavorites: (input) => ipcRenderer.invoke("openrouter:set-favorites", input)
});

contextBridge.exposeInMainWorld("naraRouterApi", {
  getConfig: () => ipcRenderer.invoke("nararouter:get-config"),
  listModels: () => ipcRenderer.invoke("nararouter:list-models"),
  refreshModels: () => ipcRenderer.invoke("nararouter:refresh-models"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("nararouter:save-api-key", apiKey),
  clearApiKey: () => ipcRenderer.invoke("nararouter:clear-api-key"),
  test: () => ipcRenderer.invoke("nararouter:test"),
  verifyModels: (input) => ipcRenderer.invoke("nararouter:verify-models", input),
  setFavorites: (input) => ipcRenderer.invoke("nararouter:set-favorites", input)
});

contextBridge.exposeInMainWorld("miniMaxApi", {
  getConfig: () => ipcRenderer.invoke("minimax:get-config"),
  listModels: () => ipcRenderer.invoke("minimax:list-models"),
  refreshModels: () => ipcRenderer.invoke("minimax:refresh-models"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("minimax:save-api-key", apiKey),
  clearApiKey: () => ipcRenderer.invoke("minimax:clear-api-key"),
  test: () => ipcRenderer.invoke("minimax:test"),
  verifyModels: (input) => ipcRenderer.invoke("minimax:verify-models", input),
  setFavorites: (input) => ipcRenderer.invoke("minimax:set-favorites", input)
});

contextBridge.exposeInMainWorld("codeBuddyCodexApi", {
  getConfig: () => ipcRenderer.invoke("codebuddy-codex:get-config"),
  getStatus: () => ipcRenderer.invoke("codebuddy-codex:get-status"),
  listModels: () => ipcRenderer.invoke("codebuddy-codex:list-models"),
  refreshModels: () => ipcRenderer.invoke("codebuddy-codex:refresh-models"),
  verifyModel: (input) => ipcRenderer.invoke("codebuddy-codex:verify-model", input),
  setFavorites: (input) => ipcRenderer.invoke("codebuddy-codex:set-favorites", input),
  setExperimentalAcknowledged: (input) => ipcRenderer.invoke("codebuddy-codex:set-experimental-acknowledged", input)
});

contextBridge.exposeInMainWorld("agentConversationApi", {
  setActiveSession: (sessionId) => ipcRenderer.send("agent-conversation:set-active-session", sessionId),
  getSnapshot: () => ipcRenderer.invoke("agent-conversation:get-snapshot"),
  listHistory: (input) => ipcRenderer.invoke("agent-conversation:list-history", input),
  getHistoryMessages: (input) => ipcRenderer.invoke("agent-conversation:get-history-messages", input),
  openExternal: (url) => ipcRenderer.invoke("external-link:open", url),
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("agent-conversation:snapshot", listener);
    return () => ipcRenderer.removeListener("agent-conversation:snapshot", listener);
  }
});

contextBridge.exposeInMainWorld("launchTemplateApi", {
  list: () => ipcRenderer.invoke("launch-templates:list"),
  create: (input) => ipcRenderer.invoke("launch-templates:create", input),
  update: (id, input) => ipcRenderer.invoke("launch-templates:update", id, input),
  delete: (id) => ipcRenderer.invoke("launch-templates:delete", id),
  launch: (id) => ipcRenderer.invoke("launch-templates:launch", id)
});

contextBridge.exposeInMainWorld("mobileAccessApi", {
  getState: () => ipcRenderer.invoke("mobile-access:get-state"),
  updateConfig: (partial) => ipcRenderer.invoke("mobile-access:update-config", partial),
  createPairing: () => ipcRenderer.invoke("mobile-access:create-pairing"),
  listAudit: () => ipcRenderer.invoke("mobile-access:list-audit"),
  revokeDevice: (deviceId) => ipcRenderer.invoke("mobile-access:revoke-device", deviceId),
  disconnectDevice: () => ipcRenderer.invoke("mobile-access:disconnect-device"),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("mobile-access:state-changed", listener);
    return () => ipcRenderer.removeListener("mobile-access:state-changed", listener);
  }
});

contextBridge.exposeInMainWorld("hookConfigApi", {
  selectProjectDirectory: (defaultPath) => ipcRenderer.invoke("hooks:select-project-directory", defaultPath),
  inspect: (target, providers) => ipcRenderer.invoke("hooks:inspect", { target, providers }),
  install: (target, providers) => ipcRenderer.invoke("hooks:install", { target, providers })
});

contextBridge.exposeInMainWorld("dingTalkApi", {
  getConfig: () => ipcRenderer.invoke("dingtalk:get-config"),
  setConfig: (input) => ipcRenderer.invoke("dingtalk:set-config", input),
  clearCredentials: () => ipcRenderer.invoke("dingtalk:clear-credentials"),
  test: () => ipcRenderer.invoke("dingtalk:test")
});

contextBridge.exposeInMainWorld("clipboardApi", {
  writeText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  readText: () => ipcRenderer.invoke("clipboard:read-text"),
  pasteImageToSession: (sessionId) => ipcRenderer.invoke("clipboard:paste-image-to-session", sessionId),
  uploadImageToSession: (sessionId) => ipcRenderer.invoke("clipboard:upload-image-to-session", sessionId)
});

contextBridge.exposeInMainWorld("externalLinkApi", {
  open: (url) => ipcRenderer.invoke("external-link:open", url)
});

contextBridge.exposeInMainWorld("remoteFileApi", {
  getHome: (sessionId) => ipcRenderer.invoke("remote-files:home", { sessionId }),
  list: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:list", { sessionId, remotePath }),
  readText: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:read-text", { sessionId, remotePath }),
  previewFile: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:preview-file", { sessionId, remotePath }),
  releasePreview: (previewId) => ipcRenderer.invoke("remote-files:release-preview", { previewId }),
  writeText: (sessionId, remotePath, content, expectedVersion, options) => ipcRenderer.invoke("remote-files:write-text", { sessionId, remotePath, content, expectedVersion, options }),
  createEntry: (sessionId, parentPath, name, kind, conflictPolicy) => ipcRenderer.invoke("remote-files:create", { sessionId, parentPath, name, kind, conflictPolicy }),
  moveEntry: (sessionId, sourcePath, targetDirectory, name, conflictPolicy) => ipcRenderer.invoke("remote-files:move", { sessionId, sourcePath, targetDirectory, name, conflictPolicy }),
  chooseRoot: (sessionId, currentRoot) => ipcRenderer.invoke("remote-files:choose-root", { sessionId, currentRoot }),
  uploadFile: (sessionId, remoteDir) => ipcRenderer.invoke("remote-files:upload-file", { sessionId, remoteDir }),
  uploadDroppedFiles: (sessionId, remoteDir, files) => ipcRenderer.invoke("remote-files:upload-files", { sessionId, remoteDir, localPaths: getDroppedFilePaths(files) }),
  downloadFile: (transferId, sessionId, remotePath, fileName) => ipcRenderer.invoke("remote-files:download-file", { transferId, sessionId, remotePath, fileName }),
  startDownloadDrag: (transferId, sessionId, remotePath, fileName) => ipcRenderer.invoke("remote-files:start-download-drag", { transferId, sessionId, remotePath, fileName }),
  cancelDownload: (transferId) => ipcRenderer.invoke("remote-files:cancel-download", { transferId }),
  onDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-files:download-progress", listener);
    return () => ipcRenderer.removeListener("remote-files:download-progress", listener);
  },
  openInExplorer: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:open-in-explorer", { sessionId, remotePath }),
  deleteEntry: (sessionId, remotePath, options) => ipcRenderer.invoke("remote-files:delete", { sessionId, remotePath, options })
  , watchDirectories: (sessionId, directories) => ipcRenderer.invoke("remote-files:watch", { sessionId, directories })
  , unwatchDirectories: (sessionId) => ipcRenderer.invoke("remote-files:unwatch", { sessionId })
  , onChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-files:changed", listener);
    return () => ipcRenderer.removeListener("remote-files:changed", listener);
  }
  , onWatchError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-files:watch-error", listener);
    return () => ipcRenderer.removeListener("remote-files:watch-error", listener);
  }
});

contextBridge.exposeInMainWorld("remoteSystemApi", {
  getMetrics: (sessionId) => ipcRenderer.invoke("remote-system:metrics", { sessionId })
});

contextBridge.exposeInMainWorld("skillsApi", {
  list: (provider) => ipcRenderer.invoke("skills:list", { provider })
});

contextBridge.exposeInMainWorld("mcpApi", {
  list: (request) => ipcRenderer.invoke("mcp:list", request),
  reveal: (request) => ipcRenderer.invoke("mcp:reveal", request),
  save: (request) => ipcRenderer.invoke("mcp:save", request),
  remove: (request) => ipcRenderer.invoke("mcp:remove", request)
});

contextBridge.exposeInMainWorld("agentUsageApi", {
  getUsage: (sessionId, options) => ipcRenderer.invoke("agent-usage:get", {
    sessionId,
    force: Boolean(options?.force)
  }),
  getCodeBuddyUsage: (options) => ipcRenderer.invoke("agent-usage:get-codebuddy", {
    force: Boolean(options?.force)
  }),
  consumeResetCredit: (sessionId, creditId, idempotencyKey) => ipcRenderer.invoke("agent-usage:consume-reset-credit", {
    sessionId,
    creditId,
    idempotencyKey
  }),
  cancel: (sessionId) => ipcRenderer.send("agent-usage:cancel", { sessionId }),
  cancelCodeBuddyUsage: () => ipcRenderer.send("agent-usage:cancel-codebuddy")
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

contextBridge.exposeInMainWorld("fileTransferApi", {
  list: () => ipcRenderer.invoke("file-transfers:list"),
  chooseUpload: (sessionId, remoteDir) => ipcRenderer.invoke("file-transfers:choose-upload", { sessionId, remoteDir }),
  uploadDroppedFiles: (sessionId, remoteDir, files) => ipcRenderer.invoke("file-transfers:upload-paths", { sessionId, remoteDir, localPaths: getDroppedFilePaths(files) }),
  chooseDownload: (sessionId, remotePath, fileName) => ipcRenderer.invoke("file-transfers:choose-download", { sessionId, remotePath, fileName }),
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
