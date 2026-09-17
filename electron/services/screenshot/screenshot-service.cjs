const WINDOW_HIDE_DELAY_MS = 100;
const SCREEN_CLIP_READY_DELAY_MS = 500;

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createScreenshotService({ shellApi, platform = process.platform, delay = wait }) {
  async function captureRegion(ownerWindow) {
    if (platform !== "win32") {
      throw new Error("区域截图仅支持 Windows。");
    }

    const shouldRestore = Boolean(ownerWindow && !ownerWindow.isDestroyed() && ownerWindow.isVisible());
    try {
      if (shouldRestore) {
        ownerWindow.hide();
        await delay(WINDOW_HIDE_DELAY_MS);
      }
      await shellApi.openExternal("ms-screenclip:");
      if (shouldRestore) {
        await delay(SCREEN_CLIP_READY_DELAY_MS);
      }
      return { status: "launched" };
    } finally {
      if (shouldRestore && !ownerWindow.isDestroyed()) {
        ownerWindow.showInactive();
      }
    }
  }

  return { captureRegion };
}

module.exports = {
  SCREEN_CLIP_READY_DELAY_MS,
  WINDOW_HIDE_DELAY_MS,
  createScreenshotService
};
