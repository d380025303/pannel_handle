import { useEffect } from "react";

export const INPUT_RECOVERY_EVENT = "pannel-handle:input-recovery";

type InputRecoveryOptions = {
  debug?: boolean;
  document?: Document;
  resetTerminalInput?: (focus: boolean) => void;
  schedule?: (callback: () => void) => void;
  window?: Window;
};

const EDITABLE_SELECTOR = [
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[contenteditable]:not([contenteditable='false'])",
  ".cm-content"
].join(", ");

const INTERACTIVE_SELECTOR = [
  EDITABLE_SELECTOR,
  "button:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])"
].join(", ");

function findEditableTarget(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLElement>(EDITABLE_SELECTOR)
    : null;
}

function isUsableFocusTarget(target: HTMLElement | null) {
  if (!target?.isConnected || target.closest("[inert]")) {
    return false;
  }
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    if (element.hidden || element.style.display === "none" || element.style.visibility === "hidden") {
      return false;
    }
  }
  return !("disabled" in target && Boolean((target as HTMLInputElement).disabled));
}

function hasUserSelectedAnotherTarget(
  activeElement: Element | null,
  savedTarget: HTMLElement,
  dragSource: HTMLElement | null
) {
  if (!(activeElement instanceof HTMLElement) || activeElement === savedTarget) {
    return false;
  }
  if (dragSource && (activeElement === dragSource || dragSource.contains(activeElement))) {
    return false;
  }
  return Boolean(activeElement.closest(INTERACTIVE_SELECTOR));
}

function getFocusSummary(element: Element | null) {
  if (!(element instanceof HTMLElement)) return null;
  return {
    tagName: element.tagName.toLowerCase(),
    className: element.className,
    id: element.id
  };
}

export function installInputRecovery(options: InputRecoveryOptions = {}) {
  const recoveryDocument = options.document ?? document;
  const recoveryWindow = options.window ?? window;
  const schedule = options.schedule ?? ((callback) => recoveryWindow.requestAnimationFrame(callback));
  let savedTarget: HTMLElement | null = null;
  let lastEditableTarget: HTMLElement | null = null;
  let dragSource: HTMLElement | null = null;
  let dragActive = false;
  let recoveryScheduled = false;
  let disposed = false;

  const captureActiveTarget = () => {
    const activeElement = recoveryDocument.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      isUsableFocusTarget(activeElement) &&
      Boolean(activeElement.closest(EDITABLE_SELECTOR))
    ) {
      savedTarget = activeElement;
      lastEditableTarget = activeElement;
    } else if (isUsableFocusTarget(lastEditableTarget)) {
      savedTarget = lastEditableTarget;
    }
  };

  const handleFocusIn = (event: Event) => {
    const target = findEditableTarget(event.target);
    if (target && isUsableFocusTarget(target)) {
      lastEditableTarget = target;
    }
  };

  const emitRecovery = (reason: string, restored: boolean) => {
    recoveryDocument.dispatchEvent(new CustomEvent(INPUT_RECOVERY_EVENT, {
      detail: { reason, restored }
    }));
  };

  const recover = (reason: string) => {
    recoveryScheduled = false;
    if (disposed || !savedTarget) return;

    const target = savedTarget;
    savedTarget = null;
    const activeElement = recoveryDocument.activeElement;
    const terminalTarget = Boolean(target.closest(".terminal-host"));
    let restored = false;

    if (isUsableFocusTarget(target) && !hasUserSelectedAnotherTarget(activeElement, target, dragSource)) {
      options.resetTerminalInput?.(terminalTarget);
      target.focus({ preventScroll: true });
      restored = recoveryDocument.activeElement === target;
    } else {
      options.resetTerminalInput?.(false);
    }

    recoveryDocument.querySelectorAll<HTMLElement>(".dragging").forEach((element) => {
      element.classList.remove("dragging");
    });
    dragSource = null;
    emitRecovery(reason, restored);

    if (options.debug) {
      console.debug("[pannel-handle] input focus recovered", {
        reason,
        restored,
        terminalTarget,
        activeElement: getFocusSummary(recoveryDocument.activeElement),
        bodyCursor: recoveryDocument.body.style.cursor,
        bodyUserSelect: recoveryDocument.body.style.userSelect
      });
    }
  };

  const scheduleRecovery = (reason: string) => {
    if (!savedTarget || recoveryScheduled) return;
    recoveryScheduled = true;
    schedule(() => recover(reason));
  };

  const handleDragStart = (event: Event) => {
    captureActiveTarget();
    dragSource = event.target instanceof HTMLElement ? event.target : null;
    dragActive = true;
  };

  const handleDragFinished = (event: Event) => {
    if (!dragActive && !savedTarget) return;
    dragActive = false;
    scheduleRecovery(event.type);
  };

  const handleWindowBlur = () => {
    captureActiveTarget();
    options.resetTerminalInput?.(false);
  };

  const handleWindowFocus = () => {
    dragActive = false;
    scheduleRecovery("focus");
  };

  const handleVisibilityChange = () => {
    if (recoveryDocument.visibilityState === "hidden") {
      captureActiveTarget();
      options.resetTerminalInput?.(false);
      return;
    }
    dragActive = false;
    scheduleRecovery("visibilitychange");
  };

  const handlePointerDown = (event: Event) => {
    if (dragActive) return;
    const target = findEditableTarget(event.target);
    if (!target || !isUsableFocusTarget(target)) return;

    schedule(() => {
      if (disposed || !isUsableFocusTarget(target) || recoveryDocument.activeElement === target) return;
      const terminalTarget = Boolean(target.closest(".terminal-host"));
      options.resetTerminalInput?.(terminalTarget);
      target.focus({ preventScroll: true });
    });
  };

  recoveryDocument.addEventListener("dragstart", handleDragStart, true);
  recoveryDocument.addEventListener("dragend", handleDragFinished, true);
  recoveryDocument.addEventListener("drop", handleDragFinished, true);
  recoveryDocument.addEventListener("pointercancel", handleDragFinished, true);
  recoveryDocument.addEventListener("pointerdown", handlePointerDown, true);
  recoveryDocument.addEventListener("visibilitychange", handleVisibilityChange);
  recoveryDocument.addEventListener("focusin", handleFocusIn, true);
  recoveryWindow.addEventListener("blur", handleWindowBlur);
  recoveryWindow.addEventListener("focus", handleWindowFocus);

  return () => {
    if (disposed) return;
    savedTarget = null;
    dragSource = null;
    options.resetTerminalInput?.(false);
    recoveryDocument.querySelectorAll<HTMLElement>(".dragging").forEach((element) => {
      element.classList.remove("dragging");
    });
    disposed = true;
    recoveryDocument.removeEventListener("dragstart", handleDragStart, true);
    recoveryDocument.removeEventListener("dragend", handleDragFinished, true);
    recoveryDocument.removeEventListener("drop", handleDragFinished, true);
    recoveryDocument.removeEventListener("pointercancel", handleDragFinished, true);
    recoveryDocument.removeEventListener("pointerdown", handlePointerDown, true);
    recoveryDocument.removeEventListener("visibilitychange", handleVisibilityChange);
    recoveryDocument.removeEventListener("focusin", handleFocusIn, true);
    recoveryWindow.removeEventListener("blur", handleWindowBlur);
    recoveryWindow.removeEventListener("focus", handleWindowFocus);
  };
}

type UseInputRecoveryOptions = Pick<InputRecoveryOptions, "debug" | "resetTerminalInput">;

export function useInputRecovery(options: UseInputRecoveryOptions) {
  useEffect(() => installInputRecovery(options), [options.debug, options.resetTerminalInput]);
}
