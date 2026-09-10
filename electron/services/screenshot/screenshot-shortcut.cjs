const DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+X";
const RESERVED_SCREENSHOT_SHORTCUTS = new Set([
  "Ctrl+Shift+D",
  "Ctrl+Shift+F",
  "Ctrl+Shift+G",
  "Ctrl+Shift+I"
]);

function normalizeMainKey(value) {
  if (typeof value !== "string") return null;
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  if (/^f(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
  return null;
}

function normalizeScreenshotShortcut(value) {
  if (typeof value !== "string") return null;
  const tokens = value.split("+").map(token => token.trim()).filter(Boolean);
  const modifiers = new Set();
  let mainKey = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const modifier = lower === "ctrl" ? "Ctrl" : lower === "alt" ? "Alt" : lower === "shift" ? "Shift" : null;
    if (modifier) {
      if (modifiers.has(modifier)) return null;
      modifiers.add(modifier);
      continue;
    }
    if (mainKey) return null;
    mainKey = normalizeMainKey(token);
    if (!mainKey) return null;
  }
  if (!mainKey || modifiers.size === 0) return null;
  const shortcut = ["Ctrl", "Alt", "Shift"].filter(modifier => modifiers.has(modifier)).concat(mainKey).join("+");
  return RESERVED_SCREENSHOT_SHORTCUTS.has(shortcut) ? null : shortcut;
}

module.exports = {
  DEFAULT_SCREENSHOT_SHORTCUT,
  normalizeScreenshotShortcut
};
