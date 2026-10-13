import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { matchesScreenshotShortcut, screenshotShortcutFromKeyboardEvent, validateScreenshotShortcut } from "./screenshotShortcut";

const { normalizeScreenshotShortcut, DEFAULT_SCREENSHOT_SHORTCUT } = createRequire(import.meta.url)("../../electron/services/screenshot/screenshot-shortcut.cjs");

function keyboardEvent(key: string, partial: Partial<KeyboardEvent> = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...partial } as KeyboardEvent;
}

describe("screenshot shortcuts", () => {
  it.each([
    ["Ctrl+ctrl+X", "unsupported"],
    ["Alt+Shift+alt+F1", "unsupported"],
    ["X", "modifier_required"],
    ["F12", "modifier_required"],
    ["Ctrl+[", "unsupported"],
    ["Ctrl+F13", "unsupported"],
    ["Ctrl+X+Y", "unsupported"],
    ["Ctrl", "unsupported"],
    ["", "unsupported"],
    [null, "unsupported"],
    ...["D", "F", "G", "I"].map(key => [`shift+ctrl+${key.toLowerCase()}`, "reserved"] as const)
  ] as const)("preserves validation reasons and main-process rejection for %s", (value, reason) => {
    expect(validateScreenshotShortcut(value)).toEqual({ ok: false, reason });
    expect(normalizeScreenshotShortcut(value)).toBeNull();
  });

  it("keeps saving, recording, and matching consistent across all 336 supported combinations", () => {
    expect(DEFAULT_SCREENSHOT_SHORTCUT).toBe("Ctrl+Shift+X");
    const keys = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)];
    for (let mask = 1; mask < 8; mask += 1) {
      for (const key of keys) {
        const modifiers = [mask & 1 ? "Ctrl" : "", mask & 2 ? "Alt" : "", mask & 4 ? "Shift" : ""].filter(Boolean);
        const canonical = [...modifiers, key].join("+");
        const input = [...modifiers.reverse(), key.toLowerCase()].join(" + ");
        const event = keyboardEvent(key.toLowerCase(), { ctrlKey: Boolean(mask & 1), altKey: Boolean(mask & 2), shiftKey: Boolean(mask & 4) });
        const reserved = ["Ctrl+Shift+D", "Ctrl+Shift+F", "Ctrl+Shift+G", "Ctrl+Shift+I"].includes(canonical);
        const expected = reserved ? { ok: false, reason: "reserved" } : { ok: true, shortcut: canonical };
        expect(validateScreenshotShortcut(input)).toEqual(expected);
        expect(normalizeScreenshotShortcut(input)).toBe(reserved ? null : canonical);
        expect(screenshotShortcutFromKeyboardEvent(event)).toEqual(expected);
        expect(matchesScreenshotShortcut(event, input)).toBe(!reserved);
      }
    }
  });
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
