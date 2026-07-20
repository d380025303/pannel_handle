import { useCallback, useEffect, useRef, useState } from "react";
import { startResizeDrag } from "./resizeDrag";

export function useRightToolsResize(initialWidth: number, onPersist: (width: number) => void) {
  const [rightToolsWidth, setRightToolsWidth] = useState(initialWidth);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const widthRef = useRef(rightToolsWidth);
  const stopDraggingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    widthRef.current = rightToolsWidth;
  }, [rightToolsWidth]);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    stopDraggingRef.current?.();
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
    stopDraggingRef.current = startResizeDrag({
      onMove: (event) => {
        const delta = startXRef.current - event.clientX;
        const newWidth = Math.min(600, Math.max(280, startWidthRef.current + delta));
        setRightToolsWidth(newWidth);
      },
      onEnd: () => {
        stopDraggingRef.current = null;
        onPersist(widthRef.current);
      }
    });
  }, [onPersist]);

  useEffect(() => {
    return () => {
      stopDraggingRef.current?.();
      stopDraggingRef.current = null;
    };
  }, []);

  return { rightToolsWidth, handleSplitterMouseDown };
}
