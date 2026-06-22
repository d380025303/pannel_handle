import { describe, expect, it } from "vitest";
import { applyCompletion, editDistance, getCompletionTrigger, isCurrentCompletion } from "./composerCompletion";

describe("composer completion helpers", () => {
  it("inserts a completion at an arbitrary cursor", () => {
    expect(applyCompletion("hello world", 5, ", brave")).toEqual({ value: "hello, brave world", cursor: 12 });
  });

  it("only accepts a candidate for the exact draft and cursor", () => {
    const candidate = { candidateId: "c1", completion: " world", mode: "agent" as const, source: "model" as const, draft: "hello", cursor: 5 };
    expect(isCurrentCompletion(candidate, "hello", 5)).toBe(true);
    expect(isCurrentCompletion(candidate, "hello!", 5)).toBe(false);
    expect(isCurrentCompletion(candidate, "hello", 4)).toBe(false);
  });

  it("calculates edits without exposing draft text to metrics", () => {
    expect(editDistance("hello world", "hello brave world")).toBe(6);
    expect(editDistance("same", "same")).toBe(0);
  });

  it("uses separate Agent and Shell completion triggers", () => {
    expect(getCompletionTrigger("agent", "abc")).toBeNull();
    expect(getCompletionTrigger("agent", "优化补全")).toEqual({ modelDelayMs: 700, checkLocalHistory: false });
    expect(getCompletionTrigger("shell", "g")).toEqual({ modelDelayMs: 500, checkLocalHistory: true });
  });
});
