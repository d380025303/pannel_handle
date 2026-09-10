function createScreenshotService({ shellApi, platform = process.platform }) {
  async function captureRegion() {
    if (platform !== "win32") {
      throw new Error("区域截图仅支持 Windows。");
    }
    await shellApi.openExternal("ms-screenclip:");
    return { status: "launched" };
  }

  return { captureRegion };
}

module.exports = { createScreenshotService };
