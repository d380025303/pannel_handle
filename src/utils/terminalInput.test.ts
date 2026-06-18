import { describe, expect, it } from "vitest";
import { createImeInputGuard } from "./terminalInput";

describe("createImeInputGuard", () => {
  it("drops duplicate terminal data from one IME composition commit", () => {
    let time = 0;
    const guard = createImeInputGuard({ now: () => time });

    guard.handleCompositionStart();
    guard.handleCompositionEnd();

    expect(guard.shouldForwardData("，")).toBe(true);
    time = 40;
    expect(guard.shouldForwardData("，")).toBe(false);
  });

  it("allows the same text from a later IME composition", () => {
    let time = 0;
    const guard = createImeInputGuard({ now: () => time });

    guard.handleCompositionStart();
    guard.handleCompositionEnd();
    expect(guard.shouldForwardData("，")).toBe(true);
    time = 40;

    guard.handleCompositionStart();
    guard.handleCompositionEnd();
    expect(guard.shouldForwardData("，")).toBe(true);
  });

  it("does not filter ordinary non-IME terminal data", () => {
    const guard = createImeInputGuard();

    expect(guard.shouldForwardData("a")).toBe(true);
    expect(guard.shouldForwardData("a")).toBe(true);
    expect(guard.shouldForwardData("\r")).toBe(true);
  });

  it("stops filtering after the IME duplicate window expires", () => {
    let time = 0;
    const guard = createImeInputGuard({ now: () => time, duplicateWindowMs: 100 });

    guard.handleCompositionStart();
    guard.handleCompositionEnd();
    expect(guard.shouldForwardData("，")).toBe(true);

    time = 150;
    expect(guard.shouldForwardData("，")).toBe(true);
    time = 160;
    expect(guard.shouldForwardData("，")).toBe(true);
  });

  it("allows different payloads during the IME commit window", () => {
    let time = 0;
    const guard = createImeInputGuard({ now: () => time });

    guard.handleCompositionStart();
    guard.handleCompositionEnd();

    expect(guard.shouldForwardData("，")).toBe(true);
    time = 20;
    expect(guard.shouldForwardData("。")).toBe(true);
  });

  it("supports beforeinput/input composition events", () => {
    let time = 0;
    const guard = createImeInputGuard({ now: () => time });

    guard.handleBeforeInput({ inputType: "insertCompositionText", isComposing: true });
    guard.handleInput({ inputType: "insertFromComposition", data: "，" });

    expect(guard.shouldForwardData("，")).toBe(true);
    time = 20;
    expect(guard.shouldForwardData("，")).toBe(false);
  });

  it("drops duplicates when xterm forwards data before compositionend", () => {
    let time = 0;
    const guard = createImeInputGuard({ now: () => time });

    guard.handleCompositionStart();
    expect(guard.shouldForwardData("，")).toBe(true);

    time = 20;
    guard.handleCompositionEnd();
    expect(guard.shouldForwardData("，")).toBe(false);
  });
});
