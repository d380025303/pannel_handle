const GIT_IPC_CHANNELS = [
  "git:status",
  "git:snapshot",
  "git:workspace-snapshot",
  "git:diff",
  "git:branches",
  "git:remotes",
  "git:checkout-branch",
  "git:create-branch",
  "git:stashes",
  "git:history",
  "git:stage-files",
  "git:stage-all",
  "git:unstage-files",
  "git:unstage-all",
  "git:discard-working-tree",
  "git:commit",
  "git:fetch",
  "git:pull",
  "git:push",
  "git:stash-changes",
  "git:apply-stash",
  "git:pop-stash",
  "git:drop-stash",
  "git:revert-file",
  "git:cancel-operation"
];

function registerGitIpcHandlers({ ipcMain, gitService }) {
  ipcMain.handle("git:status", (_event, { target }) => gitService.getStatus(target));
  ipcMain.handle("git:snapshot", (_event, { target }) => gitService.getSnapshot(target));
  ipcMain.handle("git:workspace-snapshot", (_event, { sessionId }) => gitService.getWorkspaceSnapshot(sessionId));
  ipcMain.handle("git:diff", (_event, { target, request, file }) => gitService.getDiff(target, request || file));
  ipcMain.handle("git:branches", (_event, { target }) => gitService.getBranches(target));
  ipcMain.handle("git:remotes", (_event, { target }) => gitService.getRemotes(target));
  ipcMain.handle("git:checkout-branch", (_event, { target, branch, operationId }) => gitService.checkoutBranch(target, branch, operationId));
  ipcMain.handle("git:create-branch", (_event, { target, branchName, operationId }) => gitService.createBranch(target, branchName, operationId));
  ipcMain.handle("git:stashes", (_event, { target }) => gitService.getStashes(target));
  ipcMain.handle("git:history", (_event, { target, options }) => gitService.getHistory(target, options));
  ipcMain.handle("git:stage-files", (_event, { target, paths, operationId }) => gitService.stageFiles(target, paths, operationId));
  ipcMain.handle("git:stage-all", (_event, { target, operationId }) => gitService.stageAll(target, operationId));
  ipcMain.handle("git:unstage-files", (_event, { target, paths, operationId }) => gitService.unstageFiles(target, paths, operationId));
  ipcMain.handle("git:unstage-all", (_event, { target, operationId }) => gitService.unstageAll(target, operationId));
  ipcMain.handle("git:discard-working-tree", (_event, { target, file, operationId }) => gitService.discardWorkingTree(target, file, operationId));
  ipcMain.handle("git:commit", (_event, { target, message, operationId }) => gitService.commit(target, message, operationId));
  ipcMain.handle("git:fetch", (_event, { target, remote, operationId }) => gitService.fetchRemote(target, remote, operationId));
  ipcMain.handle("git:pull", (_event, { target, operationId }) => gitService.pullBranch(target, operationId));
  ipcMain.handle("git:push", (_event, { target, remote, operationId }) => gitService.pushBranch(target, remote, operationId));
  ipcMain.handle("git:stash-changes", (_event, { target, message, operationId }) => gitService.stashChanges(target, message, operationId));
  ipcMain.handle("git:apply-stash", (_event, { target, ref, operationId }) => gitService.applyStash(target, ref, operationId));
  ipcMain.handle("git:pop-stash", (_event, { target, ref, operationId }) => gitService.popStash(target, ref, operationId));
  ipcMain.handle("git:drop-stash", (_event, { target, ref, operationId }) => gitService.dropStash(target, ref, operationId));
  ipcMain.handle("git:revert-file", (_event, { target, file, operationId }) => gitService.revertFile(target, file, operationId));
  ipcMain.handle("git:cancel-operation", (_event, { operationId }) => gitService.cancelOperation(operationId));

  return () => {
    for (const channel of GIT_IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  };
}

module.exports = {
  GIT_IPC_CHANNELS,
  registerGitIpcHandlers
};
