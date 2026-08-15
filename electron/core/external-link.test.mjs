import { describe, expect, it, vi } from "vitest";
import { normalizeExternalHttpUrl, openExternalHttpUrl } from "./external-link.cjs";

describe("external-link", () => {
  it.each([
    ["http://example.com/path", "http://example.com/path"],
    ["https://example.com/path?q=1#section", "https://example.com/path?q=1#section"],
    ["  https://localhost:6173  ", "https://localhost:6173/"]
  ])("allows HTTP(S) URL %s", (input, expected) => {
    expect(normalizeExternalHttpUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "not a URL",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "mailto:test@example.com"
  ])("rejects unsupported external URL %s", (input) => {
    expect(() => normalizeExternalHttpUrl(input)).toThrow();
  });

  it("opens the normalized URL with the system shell", async () => {
    const shellApi = { openExternal: vi.fn(async () => undefined) };

    await openExternalHttpUrl(shellApi, " https://example.com ");

    expect(shellApi.openExternal).toHaveBeenCalledWith("https://example.com/");
  });
});
