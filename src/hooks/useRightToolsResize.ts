import { useCallback, useEffect, useRef, useState } from "react";
import { startResizeDrag } from "./resizeDrag";

export function useRightToolsResize(initialWidth: number, onPersist: (width: number) => void) {
  const [rightToolsWidth, setRightToolsWidth] = useState(initialWidth);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const widthRef = useRef(rightToolsWidth);
  const stopDraggingRef = useRef<(() => void) | null>(null);

  const userResizedRef = useRef(false);
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;

  useEffect(() => {
    if (!userResizedRef.current && Number.isFinite(initialWidth)
      && initialWidth >= 280 && initialWidth <= 600) {
      widthRef.current = initialWidth;
      setRightToolsWidth(initialWidth);
    }
  }, [initialWidth]);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    stopDraggingRef.current?.();
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
    stopDraggingRef.current = startResizeDrag({
      onMove: (event) => {
        const delta = startXRef.current - event.clientX;
        const newWidth = Math.min(600, Math.max(280, startWidthRef.current + delta));
        userResizedRef.current = true;
        widthRef.current = newWidth;
        setRightToolsWidth(newWidth);
      },
      onEnd: () => {
        stopDraggingRef.current = null;
        if (userResizedRef.current) persistRef.current(widthRef.current);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      stopDraggingRef.current?.();
      stopDraggingRef.current = null;
    };
  }, []);

  return { rightToolsWidth, handleSplitterMouseDown };
}
