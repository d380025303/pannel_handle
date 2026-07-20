type ResizeDragTarget = {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
};

type ResizeDragDocument = ResizeDragTarget & {
  body: HTMLElement;
  visibilityState?: DocumentVisibilityState;
};

type ResizeDragEnvironment = {
  document: ResizeDragDocument;
  window: ResizeDragTarget;
};

type ResizeDragOptions = {
  onMove: (event: MouseEvent) => void;
  onEnd?: () => void;
  environment?: ResizeDragEnvironment;
};

function getDefaultEnvironment(): ResizeDragEnvironment {
  return { document, window };
}

export function startResizeDrag({ onMove, onEnd, environment = getDefaultEnvironment() }: ResizeDragOptions) {
  const { document: dragDocument, window: dragWindow } = environment;
  const previousCursor = dragDocument.body.style.cursor;
  const previousUserSelect = dragDocument.body.style.userSelect;
  let active = true;

  const cleanup = () => {
    if (!active) return;
    active = false;
    dragDocument.removeEventListener("mousemove", handleMouseMove);
    dragDocument.removeEventListener("mouseup", handlePointerEnd);
    dragDocument.removeEventListener("pointerup", handlePointerEnd);
    dragDocument.removeEventListener("pointercancel", handlePointerEnd);
    dragDocument.removeEventListener("visibilitychange", handleVisibilityChange);
    dragWindow.removeEventListener("blur", handlePointerEnd);
    dragDocument.body.style.cursor = previousCursor;
    dragDocument.body.style.userSelect = previousUserSelect;
    onEnd?.();
  };

  const handleMouseMove = (event: Event) => {
    if (!active) return;
    onMove(event as MouseEvent);
  };

  const handlePointerEnd = () => {
    cleanup();
  };

  const handleVisibilityChange = () => {
    if (dragDocument.visibilityState === "hidden") {
      cleanup();
    }
  };

  dragDocument.body.style.cursor = "col-resize";
  dragDocument.body.style.userSelect = "none";
  dragDocument.addEventListener("mousemove", handleMouseMove);
  dragDocument.addEventListener("mouseup", handlePointerEnd);
  dragDocument.addEventListener("pointerup", handlePointerEnd);
  dragDocument.addEventListener("pointercancel", handlePointerEnd);
  dragDocument.addEventListener("visibilitychange", handleVisibilityChange);
  dragWindow.addEventListener("blur", handlePointerEnd);

  return cleanup;
}
