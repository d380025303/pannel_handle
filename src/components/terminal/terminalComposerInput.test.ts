import { describe, expect, it, vi } from "vitest";
import { submitTerminalInput } from "./terminalComposerInput";

describe("terminal composer input", () => {
  it("waits for Codex's paste window before sending Enter", () => {
    vi.useFakeTimers();
    const write = vi.fn();

    try {
      submitTerminalInput("session-1", "review this", write, setTimeout);

      expect(write.mock.calls).toEqual([["session-1", "review this"]]);
      vi.advanceTimersByTime(120);
      expect(write).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(80);
      expect(write.mock.calls).toEqual([
        ["session-1", "review this"],
        ["session-1", "\r"]
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
