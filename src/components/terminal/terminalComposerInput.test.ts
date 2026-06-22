import { describe, expect, it, vi } from "vitest";
import { submitTerminalInput } from "./terminalComposerInput";

describe("terminal composer input", () => {
  it("sends Enter separately after the draft", () => {
    const write = vi.fn();
    const schedule = vi.fn((callback: () => void) => callback());

    submitTerminalInput("session-1", "review this", write, schedule);

    expect(write.mock.calls).toEqual([
      ["session-1", "review this"],
      ["session-1", "\r"]
    ]);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 30);
  });
});
