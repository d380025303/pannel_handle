import { useEffect } from "react";

export const INPUT_RECOVERY_EVENT = "pannel-handle:input-recovery";
export const INPUT_INTERRUPTION_START_EVENT = "pannel-handle:input-interruption-start";
export const INPUT_INTERRUPTION_END_EVENT = "pannel-handle:input-interruption-end";

type InputInterruptionDetail = {
  id: string;
};

function dispatchInputInterruption(type: string, id: string, targetDocument = document) {
  targetDocument.dispatchEvent(new CustomEvent<InputInterruptionDetail>(type, {
    detail: { id }
  }));
}

export function beginInputInterruption(id: string, targetDocument?: Document) {
  dispatchInputInterruption(INPUT_INTERRUPTION_START_EVENT, id, targetDocument);
}

export function endInputInterruption(id: string, targetDocument?: Document) {
  dispatchInputInterruption(INPUT_INTERRUPTION_END_EVENT, id, targetDocument);
}

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
  const activeInterruptions = new Set<string>();

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
    if (disposed) return;

    const target = savedTarget;
    const activeElement = recoveryDocument.activeElement;
    const terminalTarget = Boolean(target?.closest(".terminal-host"));
    let restored = false;

    if (target && isUsableFocusTarget(target) && !hasUserSelectedAnotherTarget(activeElement, target, dragSource)) {
      options.resetTerminalInput?.(terminalTarget);
      target.focus({ preventScroll: true });
      restored = recoveryDocument.activeElement === target;
      if (restored) {
        savedTarget = null;
      }
    } else if (target) {
      savedTarget = null;
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

  const scheduleRecovery = (reason: string, force = false) => {
    if ((!savedTarget && !force) || recoveryScheduled) return;
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
    if (activeInterruptions.size > 0) return;
    dragActive = false;
    scheduleRecovery(event.type);
  };

  const getInterruptionId = (event: Event) => {
    const id = (event as CustomEvent<Partial<InputInterruptionDetail>>).detail?.id;
    return typeof id === "string" && id ? id : null;
  };

  const handleInterruptionStart = (event: Event) => {
    const id = getInterruptionId(event);
    if (!id) return;
    captureActiveTarget();
    activeInterruptions.add(id);
    dragActive = true;
  };

  const handleInterruptionEnd = (event: Event) => {
    const id = getInterruptionId(event);
    if (!id || !activeInterruptions.delete(id) || activeInterruptions.size > 0) return;
    dragActive = false;
    scheduleRecovery(`input-interruption:${id}`, true);
  };

  const handleWindowBlur = () => {
    captureActiveTarget();
    options.resetTerminalInput?.(false);
  };

  const handleWindowFocus = () => {
    if (activeInterruptions.size > 0) return;
    dragActive = false;
    scheduleRecovery("focus");
  };

  const handleVisibilityChange = () => {
    if (recoveryDocument.visibilityState === "hidden") {
      captureActiveTarget();
      options.resetTerminalInput?.(false);
      return;
    }
    if (activeInterruptions.size > 0) return;
    dragActive = false;
    scheduleRecovery("visibilitychange");
  };

  const handlePointerDown = (event: Event) => {
    const target = findEditableTarget(event.target);
    if (!target || !isUsableFocusTarget(target)) return;
    lastEditableTarget = target;

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
  recoveryDocument.addEventListener(INPUT_INTERRUPTION_START_EVENT, handleInterruptionStart);
  recoveryDocument.addEventListener(INPUT_INTERRUPTION_END_EVENT, handleInterruptionEnd);
  recoveryWindow.addEventListener("blur", handleWindowBlur);
  recoveryWindow.addEventListener("focus", handleWindowFocus);

  return () => {
    if (disposed) return;
    savedTarget = null;
    dragSource = null;
    activeInterruptions.clear();
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
    recoveryDocument.removeEventListener(INPUT_INTERRUPTION_START_EVENT, handleInterruptionStart);
    recoveryDocument.removeEventListener(INPUT_INTERRUPTION_END_EVENT, handleInterruptionEnd);
    recoveryWindow.removeEventListener("blur", handleWindowBlur);
    recoveryWindow.removeEventListener("focus", handleWindowFocus);
  };
}

type UseInputRecoveryOptions = Pick<InputRecoveryOptions, "debug" | "resetTerminalInput">;

export function useInputRecovery(options: UseInputRecoveryOptions) {
  useEffect(() => installInputRecovery(options), [options.debug, options.resetTerminalInput]);
}
