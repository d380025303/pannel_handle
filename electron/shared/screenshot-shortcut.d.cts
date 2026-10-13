export const DEFAULT_SCREENSHOT_SHORTCUT: string;
export type ScreenshotShortcutValidation =
  | { ok: true; shortcut: string }
  | { ok: false; reason: "modifier_required" | "unsupported" | "reserved" };
export function normalizeMainKey(value: string): string | null;
export function validateScreenshotShortcut(value: unknown): ScreenshotShortcutValidation;
