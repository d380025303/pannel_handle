const SCREENSHOT_IPC_CHANNELS = ["screenshot:capture-region"];

function registerScreenshotIpcHandlers({ ipcMain, screenshotService }) {
  ipcMain.handle("screenshot:capture-region", () => screenshotService.captureRegion());
  return () => {
    for (const channel of SCREENSHOT_IPC_CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { SCREENSHOT_IPC_CHANNELS, registerScreenshotIpcHandlers };
