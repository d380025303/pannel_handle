import { normalizeMainKey, validateScreenshotShortcut } from "@pannel/screenshot-shortcut";
import type { ScreenshotShortcutValidation } from "@pannel/screenshot-shortcut";

export { DEFAULT_SCREENSHOT_SHORTCUT, validateScreenshotShortcut } from "@pannel/screenshot-shortcut";
export type { ScreenshotShortcutValidation } from "@pannel/screenshot-shortcut";

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
