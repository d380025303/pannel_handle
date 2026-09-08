import { useCallback, useEffect, useRef, useState } from "react";
import { startResizeDrag } from "./resizeDrag";

export function useSidebarResize(initialWidth: number, onPersist: (width: number) => void) {
  const [sidebarWidth, setSidebarWidth] = useState(initialWidth);
  const widthRef = useRef(sidebarWidth);
  const stopDraggingRef = useRef<(() => void) | null>(null);

  const userResizedRef = useRef(false);
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;

  useEffect(() => {
    if (!userResizedRef.current && Number.isFinite(initialWidth)
      && initialWidth >= 180 && initialWidth <= 500) {
      widthRef.current = initialWidth;
      setSidebarWidth(initialWidth);
    }
  }, [initialWidth]);

  const handleSplitterMouseDown = useCallback(() => {
    stopDraggingRef.current?.();
    stopDraggingRef.current = startResizeDrag({
      onMove: (e) => {
        const newWidth = Math.min(500, Math.max(180, e.clientX));
        userResizedRef.current = true;
        widthRef.current = newWidth;
        setSidebarWidth(newWidth);
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

  return { sidebarWidth, handleSplitterMouseDown };
}
