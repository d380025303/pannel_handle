const { DEFAULT_SCREENSHOT_SHORTCUT, validateScreenshotShortcut } = require("../../shared/screenshot-shortcut.cjs");

function normalizeScreenshotShortcut(value) {
  const result = validateScreenshotShortcut(value);
  return result.ok ? result.shortcut : null;
}

module.exports = {
  DEFAULT_SCREENSHOT_SHORTCUT,
  normalizeScreenshotShortcut
};
