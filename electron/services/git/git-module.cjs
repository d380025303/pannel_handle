const { createGitService } = require("./git-service.cjs");
const { registerGitIpcHandlers } = require("./git-ipc-handlers.cjs");

function createGitModule({ ipcMain, terminalManager, sshGitExecutor }) {
  const gitService = createGitService({
    terminalManager,
    sshGitExecutor
  });
  const unregisterIpcHandlers = registerGitIpcHandlers({ ipcMain, gitService });
  let stopped = false;

  return {
    shutdown() {
      if (stopped) return;
      stopped = true;
      unregisterIpcHandlers();
      gitService.shutdown();
    }
  };
}

module.exports = {
  createGitModule
};
