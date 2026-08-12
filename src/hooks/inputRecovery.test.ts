// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installInputRecovery } from "./inputRecovery";

function appendInput(className?: string) {
  const input = document.createElement("textarea");
  if (className) input.className = className;
  document.body.appendChild(input);
  return input;
}

describe("installInputRecovery", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("restores the focused input when a native drag loses its normal dragend", () => {
    const input = appendInput();
    const resetTerminalInput = vi.fn();
    input.focus();
    const dispose = installInputRecovery({
      resetTerminalInput,
      schedule: (callback) => callback()
    });

    input.dispatchEvent(new Event("dragstart", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    input.blur();
    window.dispatchEvent(new Event("focus"));

    expect(document.activeElement).toBe(input);
    expect(resetTerminalInput).toHaveBeenCalledWith(false);
    dispose();
  });

  it("does not steal focus selected by the user after a drag", () => {
    const original = appendInput();
    const next = appendInput();
    original.focus();
    const dispose = installInputRecovery({ schedule: (callback) => callback() });

    original.dispatchEvent(new Event("dragstart", { bubbles: true }));
    next.focus();
    document.dispatchEvent(new Event("dragend", { bubbles: true }));

    expect(document.activeElement).toBe(next);
    dispose();
  });

  it("remembers the last editable target when a draggable control takes focus first", () => {
    const input = appendInput();
    const draggable = document.createElement("button");
    draggable.draggable = true;
    document.body.appendChild(draggable);
    input.focus();
    const dispose = installInputRecovery({ schedule: (callback) => callback() });
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    draggable.focus();
    draggable.dispatchEvent(new Event("dragstart", { bubbles: true }));
    document.dispatchEvent(new Event("dragend", { bubbles: true }));

    expect(document.activeElement).toBe(input);
    dispose();
  });

  it("recovers on pointer cancellation and clears stale drag classes", () => {
    const input = appendInput();
    const draggable = document.createElement("button");
    draggable.className = "dragging";
    document.body.appendChild(draggable);
    input.focus();
    const dispose = installInputRecovery({ schedule: (callback) => callback() });
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    draggable.dispatchEvent(new Event("dragstart", { bubbles: true }));
    input.blur();

    document.dispatchEvent(new Event("pointercancel", { bubbles: true }));

    expect(document.activeElement).toBe(input);
    expect(draggable.classList.contains("dragging")).toBe(false);
    dispose();
  });

  it("resets terminal state and clears drag classes when disposed mid-drag", () => {
    const input = appendInput();
    const draggable = document.createElement("button");
    draggable.className = "dragging";
    document.body.appendChild(draggable);
    const resetTerminalInput = vi.fn();
    input.focus();
    const dispose = installInputRecovery({ resetTerminalInput });
    draggable.dispatchEvent(new Event("dragstart", { bubbles: true }));

    dispose();

    expect(resetTerminalInput).toHaveBeenCalledWith(false);
    expect(draggable.classList.contains("dragging")).toBe(false);
  });

  it("resets the terminal IME guard and restores terminal focus once", () => {
    const host = document.createElement("div");
    host.className = "terminal-host";
    const textarea = appendInput("xterm-helper-textarea");
    host.appendChild(textarea);
    document.body.appendChild(host);
    const resetTerminalInput = vi.fn();
    textarea.focus();
    const dispose = installInputRecovery({
      resetTerminalInput,
      schedule: (callback) => callback()
    });

    textarea.dispatchEvent(new Event("dragstart", { bubbles: true }));
    textarea.blur();
    document.dispatchEvent(new Event("drop", { bubbles: true }));
    document.dispatchEvent(new Event("dragend", { bubbles: true }));

    expect(resetTerminalInput).toHaveBeenCalledTimes(1);
    expect(resetTerminalInput).toHaveBeenCalledWith(true);
    expect(document.activeElement).toBe(textarea);
    dispose();
  });

  it("focuses an enabled editable control when pointer focus transfer is missed", () => {
    const input = appendInput();
    const dispose = installInputRecovery({ schedule: (callback) => callback() });

    input.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(document.activeElement).toBe(input);
    dispose();
  });
});
