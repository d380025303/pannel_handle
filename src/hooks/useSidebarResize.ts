import { useCallback, useEffect, useRef, useState } from "react";

export function useSidebarResize() {
  const [sidebarWidth, setSidebarWidth] = useState(290);
  const draggingRef = useRef(false);

  const handleSplitterMouseDown = useCallback(() => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (!draggingRef.current) return;
      const newWidth = Math.min(500, Math.max(180, e.clientX));
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return { sidebarWidth, handleSplitterMouseDown };
}
