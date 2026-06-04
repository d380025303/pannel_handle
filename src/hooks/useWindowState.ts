import { useEffect, useState } from "react";

export function useWindowState() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let isDisposed = false;

    window.windowApi.isMaximized().then((nextIsMaximized) => {
      if (!isDisposed) {
        setIsMaximized(nextIsMaximized);
      }
    });

    const removeMaximizedListener = window.windowApi.onMaximizedChanged(setIsMaximized);

    return () => {
      isDisposed = true;
      removeMaximizedListener();
    };
  }, []);

  return { isMaximized };
}
