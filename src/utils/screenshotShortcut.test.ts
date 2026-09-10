import { describe, expect, it } from "vitest";
import { matchesScreenshotShortcut, screenshotShortcutFromKeyboardEvent, validateScreenshotShortcut } from "./screenshotShortcut";

function keyboardEvent(key: string, partial: Partial<KeyboardEvent> = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...partial } as KeyboardEvent;
}

describe("screenshot shortcuts", () => {
  it("normalizes modifier order and main keys", () => {
    expect(validateScreenshotShortcut("shift+ctrl+x")).toEqual({ ok: true, shortcut: "Ctrl+Shift+X" });
    expect(validateScreenshotShortcut("alt+f12")).toEqual({ ok: true, shortcut: "Alt+F12" });
  });

  it("records supported keyboard events and ignores modifier-only events", () => {
    expect(screenshotShortcutFromKeyboardEvent(keyboardEvent("x", { ctrlKey: true, shiftKey: true }))).toEqual({ ok: true, shortcut: "Ctrl+Shift+X" });
    expect(screenshotShortcutFromKeyboardEvent(keyboardEvent("Control", { ctrlKey: true }))).toBeNull();
  });

  it("rejects missing modifiers, unsupported keys, and reserved app shortcuts", () => {
    expect(validateScreenshotShortcut("X")).toEqual({ ok: false, reason: "modifier_required" });
    expect(validateScreenshotShortcut("Ctrl+[")).toEqual({ ok: false, reason: "unsupported" });
    expect(validateScreenshotShortcut("Ctrl+Shift+F")).toEqual({ ok: false, reason: "reserved" });
  });

  it("matches only the configured shortcut", () => {
    expect(matchesScreenshotShortcut(keyboardEvent("x", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+X")).toBe(true);
    expect(matchesScreenshotShortcut(keyboardEvent("x", { ctrlKey: true }), "Ctrl+Shift+X")).toBe(false);
  });
});
