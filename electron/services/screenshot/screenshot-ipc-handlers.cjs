const SCREENSHOT_IPC_CHANNELS = ["screenshot:capture-region"];

function registerScreenshotIpcHandlers({ ipcMain, screenshotService, getWindowFromEvent }) {
  ipcMain.handle("screenshot:capture-region", event => screenshotService.captureRegion(getWindowFromEvent?.(event)));
  return () => {
    for (const channel of SCREENSHOT_IPC_CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { SCREENSHOT_IPC_CHANNELS, registerScreenshotIpcHandlers };
