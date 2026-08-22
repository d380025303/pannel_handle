import { describe, expect, it, vi } from "vitest";
import { createTerminalTouchScroller, type TouchCoordinates } from "./terminalTouchScroll";

const touches = (...points: TouchCoordinates[]) => points;

describe("terminal touch scrolling", () => {
  it("scrolls terminal history in both vertical directions", () => {
    const scrollLines = vi.fn();
    const scroller = createTerminalTouchScroller({ getLineHeight: () => 10, scrollLines });

    scroller.start(touches({ clientX: 20, clientY: 100 }));
    expect(scroller.move(touches({ clientX: 20, clientY: 74 }))).toBe(true);
    expect(scrollLines).toHaveBeenLastCalledWith(2);

    scroller.end();
    scroller.start(touches({ clientX: 20, clientY: 50 }));
    expect(scroller.move(touches({ clientX: 20, clientY: 72 }))).toBe(true);
    expect(scrollLines).toHaveBeenLastCalledWith(-2);
  });

  it("accumulates movement smaller than one terminal row", () => {
    const scrollLines = vi.fn();
    const scroller = createTerminalTouchScroller({
      directionLockThreshold: 0,
      getLineHeight: () => 10,
      scrollLines
    });

    scroller.start(touches({ clientX: 20, clientY: 100 }));
    scroller.move(touches({ clientX: 20, clientY: 96 }));
    scroller.move(touches({ clientX: 20, clientY: 92 }));
    expect(scrollLines).not.toHaveBeenCalled();
    scroller.move(touches({ clientX: 20, clientY: 88 }));
    expect(scrollLines).toHaveBeenCalledWith(1);
  });

  it("ignores horizontal and multi-touch gestures and resets after the gesture", () => {
    const scrollLines = vi.fn();
    const scroller = createTerminalTouchScroller({ getLineHeight: () => 10, scrollLines });

    scroller.start(touches({ clientX: 10, clientY: 20 }));
    expect(scroller.move(touches({ clientX: 30, clientY: 22 }))).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();

    scroller.end();
    expect(scroller.move(touches({ clientX: 10, clientY: 0 }))).toBe(false);

    scroller.start(touches({ clientX: 10, clientY: 20 }, { clientX: 20, clientY: 20 }));
    expect(scroller.move(touches({ clientX: 10, clientY: 0 }, { clientX: 20, clientY: 0 }))).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();
  });
});
