const { createIdeaBridgeService } = require("./idea-service.cjs");
const { registerIdeaIpcHandlers } = require("./idea-ipc-handlers.cjs");

function createIdeaModule({ ipcMain, discoveryDir, broadcast }) {
  const ideaService = createIdeaBridgeService({ discoveryDir, broadcast });
  const unregisterIpcHandlers = registerIdeaIpcHandlers({ ipcMain, ideaService });
  let stopped = false;

  return {
    start() {
      return ideaService.start();
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      unregisterIpcHandlers();
      await ideaService.shutdown();
    }
  };
}

module.exports = {
  createIdeaModule
};
