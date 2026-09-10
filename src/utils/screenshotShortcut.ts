export const DEFAULT_SCREENSHOT_SHORTCUT = "Ctrl+Shift+X";

export type ScreenshotShortcutValidation =
  | { ok: true; shortcut: string }
  | { ok: false; reason: "modifier_required" | "unsupported" | "reserved" };

const RESERVED_SCREENSHOT_SHORTCUTS = new Set([
  "Ctrl+Shift+D",
  "Ctrl+Shift+F",
  "Ctrl+Shift+G",
  "Ctrl+Shift+I"
]);

function normalizeMainKey(value: string) {
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  if (/^f(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
  return null;
}

export function validateScreenshotShortcut(value: string): ScreenshotShortcutValidation {
  if (typeof value !== "string") return { ok: false, reason: "unsupported" };
  const tokens = value.split("+").map(token => token.trim()).filter(Boolean);
  const modifiers = new Set<string>();
  let mainKey: string | null = null;

  for (const token of tokens) {
    const normalizedModifier = token.toLowerCase() === "ctrl"
      ? "Ctrl"
      : token.toLowerCase() === "alt"
        ? "Alt"
        : token.toLowerCase() === "shift"
          ? "Shift"
          : null;
    if (normalizedModifier) {
      if (modifiers.has(normalizedModifier)) return { ok: false, reason: "unsupported" };
      modifiers.add(normalizedModifier);
      continue;
    }
    if (mainKey) return { ok: false, reason: "unsupported" };
    mainKey = normalizeMainKey(token);
    if (!mainKey) return { ok: false, reason: "unsupported" };
  }

  if (!mainKey) return { ok: false, reason: "unsupported" };
  if (modifiers.size === 0) return { ok: false, reason: "modifier_required" };
  const shortcut = ["Ctrl", "Alt", "Shift"].filter(modifier => modifiers.has(modifier)).concat(mainKey).join("+");
  if (RESERVED_SCREENSHOT_SHORTCUTS.has(shortcut)) return { ok: false, reason: "reserved" };
  return { ok: true, shortcut };
}

export function screenshotShortcutFromKeyboardEvent(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">): ScreenshotShortcutValidation | null {
  if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return null;
  if (event.metaKey) return { ok: false, reason: "unsupported" };
  const mainKey = normalizeMainKey(event.key);
  if (!mainKey) return { ok: false, reason: "unsupported" };
  const shortcut = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    mainKey
  ].filter(Boolean).join("+");
  return validateScreenshotShortcut(shortcut);
}

export function matchesScreenshotShortcut(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">, shortcut: string) {
  const candidate = screenshotShortcutFromKeyboardEvent(event);
  if (!candidate?.ok) return false;
  const configured = validateScreenshotShortcut(shortcut);
  return configured.ok && candidate.shortcut === configured.shortcut;
}
