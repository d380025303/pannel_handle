import { describe, expect, it, vi } from "vitest";
import { startResizeDrag } from "./resizeDrag";

class FakeEventTarget {
  listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = {}) {
    this.listeners.get(type)?.forEach((listener) => listener(event as Event));
  }
}

function createEnvironment() {
  const dragDocument = new FakeEventTarget() as FakeEventTarget & {
    body: HTMLElement;
    visibilityState?: DocumentVisibilityState;
  };
  const dragWindow = new FakeEventTarget();
  dragDocument.body = {
    style: {
      cursor: "default",
      userSelect: "text"
    }
  } as unknown as HTMLElement;

  return {
    dragDocument,
    dragWindow,
    environment: {
      document: dragDocument,
      window: dragWindow
    }
  };
}

describe("startResizeDrag", () => {
  it("restores body styles after mouseup", () => {
    const { dragDocument, environment } = createEnvironment();
    const onMove = vi.fn();
    const onEnd = vi.fn();

    startResizeDrag({ onMove, onEnd, environment });

    expect(dragDocument.body.style.cursor).toBe("col-resize");
    expect(dragDocument.body.style.userSelect).toBe("none");

    dragDocument.emit("mousemove", { clientX: 240 });
    dragDocument.emit("mouseup");
    dragDocument.emit("mousemove", { clientX: 260 });

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0].clientX).toBe(240);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(dragDocument.body.style.cursor).toBe("default");
    expect(dragDocument.body.style.userSelect).toBe("text");
  });

  it("cleans up when the window loses focus", () => {
    const { dragDocument, dragWindow, environment } = createEnvironment();
    const onEnd = vi.fn();

    startResizeDrag({ onMove: vi.fn(), onEnd, environment });
    dragWindow.emit("blur");

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(dragDocument.body.style.cursor).toBe("default");
    expect(dragDocument.body.style.userSelect).toBe("text");
  });

  it("cleans up when a pointer is canceled", () => {
    const { dragDocument, environment } = createEnvironment();
    const onEnd = vi.fn();

    startResizeDrag({ onMove: vi.fn(), onEnd, environment });
    dragDocument.emit("pointercancel");

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(dragDocument.body.style.cursor).toBe("default");
    expect(dragDocument.body.style.userSelect).toBe("text");
  });

  it("restores body styles when the caller disposes an active drag", () => {
    const { dragDocument, environment } = createEnvironment();
    const onEnd = vi.fn();

    const stopDragging = startResizeDrag({ onMove: vi.fn(), onEnd, environment });
    stopDragging();
    stopDragging();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(dragDocument.body.style.cursor).toBe("default");
    expect(dragDocument.body.style.userSelect).toBe("text");
  });
});
