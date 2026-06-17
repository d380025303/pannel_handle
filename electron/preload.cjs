const { contextBridge, ipcRenderer } = require("electron");

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

contextBridge.exposeInMainWorld("qqBotApi", {
  getConfig: () => ipcRenderer.invoke("qq-bot:get-config"),
  setConfig: (partial) => ipcRenderer.invoke("qq-bot:set-config", partial),
  getStatus: () => ipcRenderer.invoke("qq-bot:get-status"),
  testSend: () => ipcRenderer.invoke("qq-bot:test-send")
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
  downloadFile: (sessionId, remotePath, fileName) => ipcRenderer.invoke("remote-files:download-file", { sessionId, remotePath, fileName }),
  openInExplorer: (sessionId, remotePath) => ipcRenderer.invoke("remote-files:open-in-explorer", { sessionId, remotePath })
});

contextBridge.exposeInMainWorld("remoteSystemApi", {
  getMetrics: (sessionId) => ipcRenderer.invoke("remote-system:metrics", { sessionId })
});

contextBridge.exposeInMainWorld("gitApi", {
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
  searchFiles: (sessionId, query) => ipcRenderer.invoke("project-search:files", { sessionId, query }),
  searchText: (sessionId, query) => ipcRenderer.invoke("project-search:text", { sessionId, query })
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
