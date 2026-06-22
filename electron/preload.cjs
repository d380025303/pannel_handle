const { contextBridge, ipcRenderer, webUtils } = require("electron");

function getDroppedFilePaths(files) {
  return Array.from(files || [])
    .map((file) => webUtils.getPathForFile(file))
    .filter(Boolean);
}

contextBridge.exposeInMainWorld("terminalApi", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: (options) => ipcRenderer.invoke("sessions:create", options),
  updateSession: (id, updates) => ipcRenderer.invoke("sessions:update", { id, ...updates }),
  closeSession: (id) => ipcRenderer.invoke("sessions:close", id),
  getHistory: (id) => ipcRenderer.invoke("terminal:history", id),
  write: (id, data) => ipcRenderer.send("terminal:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
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
  launchSessions: (sessions) => ipcRenderer.invoke("sessions:launch-selected", sessions),
  deleteSavedSession: (id) => ipcRenderer.invoke("sessions:delete-saved", id),
  reorderSavedSessions: (orderedIds) => ipcRenderer.invoke("sessions:reorder", orderedIds),
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

contextBridge.exposeInMainWorld("hookConfigApi", {
  selectProjectDirectory: (defaultPath) => ipcRenderer.invoke("hooks:select-project-directory", defaultPath),
  inspect: (target, providers) => ipcRenderer.invoke("hooks:inspect", { target, providers }),
  install: (target, providers) => ipcRenderer.invoke("hooks:install", { target, providers })
});

contextBridge.exposeInMainWorld("listenerAgentApi", {
  getState: (templateId) => ipcRenderer.invoke("listener-agents:get-state", templateId),
  save: (templateId, agent) => ipcRenderer.invoke("listener-agents:save", { templateId, agent }),
  delete: (templateId, agentId) => ipcRenderer.invoke("listener-agents:delete", { templateId, agentId }),
  run: (templateId, agentId, triggerId) => ipcRenderer.invoke("listener-agents:run", { templateId, agentId, triggerId }),
  cancel: (templateId, agentId) => ipcRenderer.invoke("listener-agents:cancel", { templateId, agentId }),
  history: (templateId, agentId) => ipcRenderer.invoke("listener-agents:history", { templateId, agentId }),
  clearHistory: (templateId, agentId) => ipcRenderer.invoke("listener-agents:clear-history", { templateId, agentId }),
  onChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("listener-agents:changed", listener);
    return () => ipcRenderer.removeListener("listener-agents:changed", listener);
  },
  onOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("listener-agents:output", listener);
    return () => ipcRenderer.removeListener("listener-agents:output", listener);
  }
});

contextBridge.exposeInMainWorld("dingTalkApi", {
  getConfig: () => ipcRenderer.invoke("dingtalk:get-config"),
  setConfig: (input) => ipcRenderer.invoke("dingtalk:set-config", input),
  clearCredentials: () => ipcRenderer.invoke("dingtalk:clear-credentials"),
  test: () => ipcRenderer.invoke("dingtalk:test")
});

contextBridge.exposeInMainWorld("completionApi", {
  getConfig: () => ipcRenderer.invoke("completion:get-config"),
  setConfig: (input) => ipcRenderer.invoke("completion:set-config", input),
  clearCredentials: () => ipcRenderer.invoke("completion:clear-credentials"),
  test: () => ipcRenderer.invoke("completion:test"),
  complete: (input) => ipcRenderer.invoke("completion:complete", input),
  recordSubmission: (input) => ipcRenderer.invoke("completion:record-submission", input),
  recordFeedback: (input) => ipcRenderer.invoke("completion:record-feedback", input),
  getMetrics: () => ipcRenderer.invoke("completion:get-metrics"),
  clearMetrics: () => ipcRenderer.invoke("completion:clear-metrics"),
  onDebugEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("completion:debug", listener);
    return () => ipcRenderer.removeListener("completion:debug", listener);
  }
});

contextBridge.exposeInMainWorld("clipboardApi", {
  writeText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  readText: () => ipcRenderer.invoke("clipboard:read-text"),
  pasteImageToSession: (sessionId) => ipcRenderer.invoke("clipboard:paste-image-to-session", sessionId)
});

contextBridge.exposeInMainWorld("remoteFileApi", {
  getHome: (sessionId) => ipcRenderer.invoke("remote-files:home", { sessionId }),
  list: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:list", { sessionId, remotePath }),
  readText: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:read-text", { sessionId, remotePath }),
  previewFile: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:preview-file", { sessionId, remotePath }),
  releasePreview: (previewId) => ipcRenderer.invoke("remote-files:release-preview", { previewId }),
  writeText: (sessionId, remotePath, content, expectedVersion) => ipcRenderer.invoke("remote-files:write-text", { sessionId, remotePath, content, expectedVersion }),
  uploadFile: (sessionId, remoteDir) => ipcRenderer.invoke("remote-files:upload-file", { sessionId, remoteDir }),
  uploadDroppedFiles: (sessionId, remoteDir, files) => ipcRenderer.invoke("remote-files:upload-files", { sessionId, remoteDir, localPaths: getDroppedFilePaths(files) }),
  downloadFile: (sessionId, remotePath, fileName) => ipcRenderer.invoke("remote-files:download-file", { sessionId, remotePath, fileName }),
  startDownloadDrag: (sessionId, remotePath, fileName) => ipcRenderer.invoke("remote-files:start-download-drag", { sessionId, remotePath, fileName }),
  openInExplorer: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:open-in-explorer", { sessionId, remotePath }),
  deleteEntry: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:delete", { sessionId, remotePath })
});

contextBridge.exposeInMainWorld("remoteSystemApi", {
  getMetrics: (sessionId) => ipcRenderer.invoke("remote-system:metrics", { sessionId })
});

contextBridge.exposeInMainWorld("gitApi", {
  changeDirectory: (sessionId, cwd) => ipcRenderer.invoke("git:change-directory", { sessionId, cwd }),
  getStatus: (sessionId) => ipcRenderer.invoke("git:status", { sessionId }),
  getDiff: (sessionId, file) => ipcRenderer.invoke("git:diff", { sessionId, file }),
  getBranches: (sessionId) => ipcRenderer.invoke("git:branches", { sessionId }),
  checkoutBranch: (sessionId, branch) => ipcRenderer.invoke("git:checkout-branch", { sessionId, branch }),
  getStashes: (sessionId) => ipcRenderer.invoke("git:stashes", { sessionId }),
  stashChanges: (sessionId) => ipcRenderer.invoke("git:stash-changes", { sessionId }),
  applyStash: (sessionId, ref) => ipcRenderer.invoke("git:apply-stash", { sessionId, ref }),
  popStash: (sessionId, ref) => ipcRenderer.invoke("git:pop-stash", { sessionId, ref }),
  revertFile: (sessionId, file) => ipcRenderer.invoke("git:revert-file", { sessionId, file })
});

contextBridge.exposeInMainWorld("projectSearchApi", {
  searchWorkspaceEntries: (sessionId, query) => ipcRenderer.invoke("project-search:workspace-entries", { sessionId, query }),
  listDirectories: (sessionId, rootPath) => ipcRenderer.invoke("project-search:list-directories", { sessionId, rootPath }),
  searchFiles: (sessionId, query, rootPath) => ipcRenderer.invoke("project-search:files", { sessionId, query, rootPath }),
  searchText: (sessionId, query, requestId, rootPath) => ipcRenderer.invoke("project-search:text", { sessionId, query, requestId, rootPath }),
  cancelTextSearch: (sessionId, requestId) => ipcRenderer.invoke("project-search:cancel-text", { sessionId, requestId })
});

contextBridge.exposeInMainWorld("windowApi", {
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizedChanged: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on("window:maximized-changed", listener);
    return () => ipcRenderer.removeListener("window:maximized-changed", listener);
  }
});
