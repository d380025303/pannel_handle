import { describe, expect, it } from "vitest";
import { applyCompletion, isCurrentCompletion } from "./composerCompletion";

describe("composer completion helpers", () => {
  it("inserts a completion at an arbitrary cursor", () => {
    expect(applyCompletion("hello world", 5, ", brave")).toEqual({ value: "hello, brave world", cursor: 12 });
  });

  it("only accepts a candidate for the exact draft and cursor", () => {
    const candidate = { completion: " world", draft: "hello", cursor: 5 };
    expect(isCurrentCompletion(candidate, "hello", 5)).toBe(true);
    expect(isCurrentCompletion(candidate, "hello!", 5)).toBe(false);
    expect(isCurrentCompletion(candidate, "hello", 4)).toBe(false);
  });
});
