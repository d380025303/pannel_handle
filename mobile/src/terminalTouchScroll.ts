export type TouchCoordinates = {
  clientX: number;
  clientY: number;
};

type TouchCollection = ArrayLike<TouchCoordinates>;

type TerminalTouchScrollerOptions = {
  getLineHeight: () => number;
  scrollLines: (lines: number) => void;
  directionLockThreshold?: number;
};

export function createTerminalTouchScroller({
  getLineHeight,
  scrollLines,
  directionLockThreshold = 6
}: TerminalTouchScrollerOptions) {
  let startX: number | null = null;
  let startY: number | null = null;
  let lastY: number | null = null;
  let pendingLines = 0;
  let direction: "horizontal" | "vertical" | null = null;

  const reset = () => {
    startX = null;
    startY = null;
    lastY = null;
    pendingLines = 0;
    direction = null;
  };

  return {
    start(touches: TouchCollection) {
      reset();
      if (touches.length !== 1) return;
      startX = touches[0].clientX;
      startY = touches[0].clientY;
      lastY = touches[0].clientY;
    },
    move(touches: TouchCollection) {
      if (touches.length !== 1 || startX === null || startY === null || lastY === null) {
        reset();
        return false;
      }

      const touch = touches[0];
      if (direction === null) {
        const deltaX = touch.clientX - startX;
        const deltaY = touch.clientY - startY;
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < directionLockThreshold) return false;
        direction = Math.abs(deltaY) >= Math.abs(deltaX) ? "vertical" : "horizontal";
      }

      if (direction === "horizontal") return false;

      const lineHeight = getLineHeight();
      const deltaY = lastY - touch.clientY;
      lastY = touch.clientY;
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return true;

      pendingLines += deltaY / lineHeight;
      const wholeLines = Math.trunc(pendingLines);
      if (wholeLines !== 0) {
        scrollLines(wholeLines);
        pendingLines -= wholeLines;
      }
      return true;
    },
    end: reset
  };
}
