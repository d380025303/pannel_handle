import { useCallback, useEffect, useRef, useState } from "react";
import { startResizeDrag } from "./resizeDrag";

export function useSidebarResize() {
  const [sidebarWidth, setSidebarWidth] = useState(290);
  const stopDraggingRef = useRef<(() => void) | null>(null);

  const handleSplitterMouseDown = useCallback(() => {
    stopDraggingRef.current?.();
    stopDraggingRef.current = startResizeDrag({
      onMove: (e) => {
        const newWidth = Math.min(500, Math.max(180, e.clientX));
        setSidebarWidth(newWidth);
      },
      onEnd: () => {
        stopDraggingRef.current = null;
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
