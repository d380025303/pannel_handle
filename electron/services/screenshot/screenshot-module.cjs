const { createScreenshotService } = require("./screenshot-service.cjs");
const { registerScreenshotIpcHandlers } = require("./screenshot-ipc-handlers.cjs");

function createScreenshotModule({ ipcMain, shellApi, getWindowFromEvent, platform = process.platform, createService = createScreenshotService }) {
  const screenshotService = createService({ shellApi, platform });
  const unregister = registerScreenshotIpcHandlers({ ipcMain, screenshotService, getWindowFromEvent });
  let stopped = false;
  return {
    screenshotService,
    shutdown() {
      if (stopped) return;
      stopped = true;
      unregister();
    }
  };
}

module.exports = { createScreenshotModule };
