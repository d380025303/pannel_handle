// @vitest-environment jsdom
import type { MouseEvent as ReactMouseEvent } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarResize } from "./useSidebarResize";
import { useRightToolsResize } from "./useRightToolsResize";

afterEach(cleanup);

const panels = [
  { name: "left", initial: 290, saved: 410, expected: 450,
    usePanel: (width: number, persist: (width: number) => void) => {
      const panel = useSidebarResize(width, persist);
      return { width: panel.sidebarWidth, start: () => panel.handleSplitterMouseDown() };
    }, moveX: 450 },
  { name: "right", initial: 380, saved: 510, expected: 430,
    usePanel: (width: number, persist: (width: number) => void) => {
      const panel = useRightToolsResize(width, persist);
      return { width: panel.rightToolsWidth, start: () => panel.handleSplitterMouseDown({ clientX: 700 } as ReactMouseEvent) };
    }, moveX: 650 }
];

for (const panel of panels) {
  describe(`${panel.name} panel`, () => {
    it("applies asynchronously loaded width without saving defaults", () => {
      const persist = vi.fn();
      const { result, rerender } = renderHook(({ width }) => panel.usePanel(width, persist), {
        initialProps: { width: panel.initial }
      });
      rerender({ width: panel.saved });
      expect(result.current.width).toBe(panel.saved);
      expect(persist).not.toHaveBeenCalled();
    });

    it.each(["mouseup", "blur"])("saves the latest movement on %s and ignores late configuration", (end) => {
      const persist = vi.fn();
      const { result, rerender, unmount } = renderHook(({ width }) => panel.usePanel(width, persist), {
        initialProps: { width: panel.initial }
      });
      act(() => {
        result.current.start();
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: panel.moveX }));
        (end === "blur" ? window : document).dispatchEvent(new Event(end));
      });
      expect(persist).toHaveBeenCalledExactlyOnceWith(panel.expected);
      rerender({ width: panel.saved });
      expect(result.current.width).toBe(panel.expected);
      unmount();
      expect(persist).toHaveBeenCalledTimes(1);
    });
  });
}
