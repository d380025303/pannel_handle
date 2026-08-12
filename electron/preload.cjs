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

contextBridge.exposeInMainWorld("terminalApi", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  createSession: (options) => ipcRenderer.invoke("sessions:create", options),
  updateSession: (id, updates) => ipcRenderer.invoke("sessions:update", { id, ...updates }),
  closeSession: (id) => ipcRenderer.invoke("sessions:close", id),
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
  launchSessions: (sessions) => ipcRenderer.invoke("sessions:launch-selected", sessions),
  deleteSavedSession: (id) => ipcRenderer.invoke("sessions:delete-saved", id),
  duplicateSession: (id) => ipcRenderer.invoke("sessions:duplicate", id),
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
  pasteImageToSession: (sessionId) => ipcRenderer.invoke("clipboard:paste-image-to-session", sessionId)
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
  changeDirectory: (sessionId, cwd) => ipcRenderer.invoke("git:change-directory", { sessionId, cwd }),
  getSnapshot: (sessionId) => ipcRenderer.invoke("git:snapshot", { sessionId }),
  discoverRepository: (sessionId) => ipcRenderer.invoke("git:discover-repository", { sessionId }),
  chooseDirectory: (sessionId, currentDirectory) => ipcRenderer.invoke("git:choose-directory", { sessionId, currentDirectory }),
  getStatus: (sessionId) => ipcRenderer.invoke("git:status", { sessionId }),
  getDiff: (sessionId, request) => ipcRenderer.invoke("git:diff", { sessionId, request }),
  getBranches: (sessionId) => ipcRenderer.invoke("git:branches", { sessionId }),
  getRemotes: (sessionId) => ipcRenderer.invoke("git:remotes", { sessionId }),
  checkoutBranch: (sessionId, branch, operationId) => ipcRenderer.invoke("git:checkout-branch", { sessionId, branch, operationId }),
  createBranch: (sessionId, branchName, operationId) => ipcRenderer.invoke("git:create-branch", { sessionId, branchName, operationId }),
  getStashes: (sessionId) => ipcRenderer.invoke("git:stashes", { sessionId }),
  getHistory: (sessionId, options) => ipcRenderer.invoke("git:history", { sessionId, options }),
  stageFiles: (sessionId, paths, operationId) => ipcRenderer.invoke("git:stage-files", { sessionId, paths, operationId }),
  stageAll: (sessionId, operationId) => ipcRenderer.invoke("git:stage-all", { sessionId, operationId }),
  unstageFiles: (sessionId, paths, operationId) => ipcRenderer.invoke("git:unstage-files", { sessionId, paths, operationId }),
  unstageAll: (sessionId, operationId) => ipcRenderer.invoke("git:unstage-all", { sessionId, operationId }),
  discardWorkingTree: (sessionId, file, operationId) => ipcRenderer.invoke("git:discard-working-tree", { sessionId, file, operationId }),
  commit: (sessionId, message, operationId) => ipcRenderer.invoke("git:commit", { sessionId, message, operationId }),
  fetch: (sessionId, remote, operationId) => ipcRenderer.invoke("git:fetch", { sessionId, remote, operationId }),
  pull: (sessionId, operationId) => ipcRenderer.invoke("git:pull", { sessionId, operationId }),
  push: (sessionId, remote, operationId) => ipcRenderer.invoke("git:push", { sessionId, remote, operationId }),
  stashChanges: (sessionId, message, operationId) => ipcRenderer.invoke("git:stash-changes", { sessionId, message, operationId }),
  applyStash: (sessionId, ref, operationId) => ipcRenderer.invoke("git:apply-stash", { sessionId, ref, operationId }),
  popStash: (sessionId, ref, operationId) => ipcRenderer.invoke("git:pop-stash", { sessionId, ref, operationId }),
  dropStash: (sessionId, ref, operationId) => ipcRenderer.invoke("git:drop-stash", { sessionId, ref, operationId }),
  revertFile: (sessionId, file, operationId) => ipcRenderer.invoke("git:revert-file", { sessionId, file, operationId }),
  cancelOperation: (operationId) => ipcRenderer.invoke("git:cancel-operation", { operationId })
});

contextBridge.exposeInMainWorld("projectSearchApi", {
  searchWorkspaceEntries: (sessionId, query, rootPath, options) => ipcRenderer.invoke("project-search:workspace-entries", { sessionId, query, rootPath, options }),
  listDirectories: (sessionId, rootPath) => ipcRenderer.invoke("project-search:list-directories", { sessionId, rootPath }),
  searchFiles: (sessionId, query, rootPath, options) => ipcRenderer.invoke("project-search:files", { sessionId, query, rootPath, options }),
  searchText: (sessionId, query, requestId, rootPath, options) => ipcRenderer.invoke("project-search:text", { sessionId, query, requestId, rootPath, options }),
  cancelTextSearch: (sessionId, requestId) => ipcRenderer.invoke("project-search:cancel-text", { sessionId, requestId })
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
