import { useCallback, useEffect, useRef, useState } from "react";

export function useRightToolsResize(initialWidth: number, onPersist: (width: number) => void) {
  const [rightToolsWidth, setRightToolsWidth] = useState(initialWidth);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const widthRef = useRef(rightToolsWidth);

  useEffect(() => {
    widthRef.current = rightToolsWidth;
  }, [rightToolsWidth]);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startXRef.current - e.clientX;
      const newWidth = Math.min(600, Math.max(280, startWidthRef.current + delta));
      setRightToolsWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onPersist(widthRef.current);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onPersist]);

  return { rightToolsWidth, handleSplitterMouseDown };
}
