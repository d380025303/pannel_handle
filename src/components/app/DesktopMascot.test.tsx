// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopMascot } from "./DesktopMascot";

describe("DesktopMascot", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clicks without opening chat or showing a badge", () => {
    const onAction = vi.fn();
    render(<DesktopMascot locale="en-US" onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Move companion (arrow keys)" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("complementary").querySelector(".desktop-mascot-badge")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("reveals minimize on hover or focus and persists collapse and keyboard position", () => {
    localStorage.setItem("pannel-handle.desktop-mascot.v1", JSON.stringify({ animated: false }));
    const props = { locale: "en-US" as const, onAction: vi.fn() };
    const { unmount } = render(<DesktopMascot {...props} />);
    const companion = screen.getByRole("complementary");
    expect(screen.queryByRole("button", { name: "Minimize companion" })).toBeNull();
    fireEvent.mouseEnter(companion);
    const minimize = screen.getByRole("button", { name: "Minimize companion" });
    fireEvent.mouseEnter(minimize);
    expect(screen.getByRole("button", { name: "Minimize companion" })).toBe(minimize);
    fireEvent.mouseLeave(companion);
    expect(screen.queryByRole("button", { name: "Minimize companion" })).toBeNull();
    const button = screen.getByRole("button", { name: "Move companion (arrow keys)" });
    fireEvent.focus(button);
    expect(screen.getByRole("button", { name: "Minimize companion" })).toBeTruthy();
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    const saved = JSON.parse(localStorage.getItem("pannel-handle.desktop-mascot.v1")!);
    expect(saved.animated).toBe(false);
    expect(Number.isFinite(saved.x)).toBe(true);
    fireEvent.click(minimize);
    unmount();
    render(<DesktopMascot {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand companion" }));
    expect(screen.getByRole("button", { name: "Move companion (arrow keys)" }).querySelector("img")?.getAttribute("src")).toContain("frames/idle/01.png");
  });

  it("hides minimize after mouse focus leaves the hover area", () => {
    const { button, companion } = setupDrag();
    fireEvent.mouseEnter(companion);
    fireEvent.pointerDown(button, pointer);
    fireEvent.focus(button);
    fireEvent.pointerUp(button, pointer);
    fireEvent.mouseLeave(companion);
    expect(screen.queryByRole("button", { name: "Minimize companion" })).toBeNull();
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Minimize companion" })).toBeTruthy();
    fireEvent.blur(button, { relatedTarget: document.body });
    expect(screen.queryByRole("button", { name: "Minimize companion" })).toBeNull();
  });

  function setupDrag(collapsed = false) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    localStorage.setItem("pannel-handle.desktop-mascot.v1", JSON.stringify({ x: 200, y: 200, collapsed }));
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    const result = render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    const button = screen.getByRole("button", { name: collapsed ? "Expand companion" : "Move companion (arrow keys)" });
    button.setPointerCapture = vi.fn();
    button.hasPointerCapture = vi.fn(() => true);
    button.releasePointerCapture = vi.fn();
    return { ...result, button, companion: screen.getByRole("complementary") };
  }
  const pointer = { pointerId: 1, button: 0, isPrimary: true, clientX: 250, clientY: 250 };

  it("waits 50ms and drags from the latest pointer position within bounds", () => {
    const { button, companion, unmount } = setupDrag();
    fireEvent.pointerDown(button, pointer);
    advance(49);
    fireEvent.pointerMove(button, { ...pointer, clientX: 280 });
    expect(companion.style.left).toBe("200px");
    advance(1);
    fireEvent.pointerMove(button, { ...pointer, clientX: 300 });
    expect(companion.style.left).toBe("220px");
    fireEvent.pointerMove(button, { ...pointer, clientX: 1e6, clientY: -1e6 });
    expect(companion.style.left).toBe(`${window.innerWidth - 152}px`);
    expect(companion.style.top).toBe("44px");
    fireEvent.pointerUp(button, pointer);
    expect(button.releasePointerCapture).toHaveBeenCalledWith(1);
    unmount();
    render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    expect(screen.getByRole("complementary").style.top).toBe("44px");
  });

  it.each(["pointerUp", "pointerCancel", "lostPointerCapture"] as const)("cleans up early %s", event => {
    const { button, companion } = setupDrag();
    fireEvent.pointerDown(button, pointer);
    advance(25);
    fireEvent[event](button, pointer);
    advance(50);
    fireEvent.pointerMove(button, { ...pointer, clientX: 400 });
    expect(companion.style.left).toBe("200px");
    expect(companion.className).not.toContain("is-dragging");
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)("stops active movement on %s", event => {
    const { button, companion } = setupDrag();
    fireEvent.pointerDown(button, pointer);
    advance(50);
    fireEvent.pointerMove(button, { ...pointer, clientX: 270 });
    fireEvent[event](button, pointer);
    fireEvent.pointerMove(button, { ...pointer, clientX: 400 });
    expect(companion.style.left).toBe("220px");
    expect(companion.className).not.toContain("is-dragging");
  });

  it("suppresses expansion after dragging but permits a subsequent short click", () => {
    const { button } = setupDrag(true);
    fireEvent.pointerDown(button, pointer);
    advance(50);
    fireEvent.pointerMove(button, { ...pointer, clientX: 270 });
    fireEvent.pointerUp(button, pointer);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Expand companion" })).toBeTruthy();
    fireEvent.pointerDown(button, pointer);
    fireEvent.pointerUp(button, pointer);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Move companion (arrow keys)" })).toBeTruthy();
  });

  it("ignores secondary pointers and clears pending capture and timers on unmount", () => {
    const { button, unmount } = setupDrag();
    fireEvent.pointerDown(button, { ...pointer, isPrimary: false });
    fireEvent.pointerDown(button, { ...pointer, button: 2 });
    expect(button.setPointerCapture).not.toHaveBeenCalled();
    fireEvent.pointerDown(button, pointer);
    unmount();
    expect(button.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(timerCount()).toBe(0);
  });

  it("recovers from malformed or out-of-bounds stored preferences", () => {
    localStorage.setItem("pannel-handle.desktop-mascot.v1", JSON.stringify({ x: 1e9, y: -1000 }));
    const { unmount } = render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    const companion = screen.getByRole("complementary");
    expect(companion.style.top).toBe("44px");
    expect(parseFloat(companion.style.left)).toBeLessThan(window.innerWidth);
    unmount();
    localStorage.setItem("pannel-handle.desktop-mascot.v1", "invalid JSON");
    render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Move companion (arrow keys)" })).toBeTruthy();
  });

  function character() {
    return screen.getByRole("button", { name: "拖动看板娘（方向键移动）" }).querySelector("img")!;
  }
  function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms); }); }
  function timerCount() {
    // jsdom dispatches localStorage events on zero-delay timers.
    advance(0);
    return vi.getTimerCount();
  }
  function startAnimation() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    return render(<DesktopMascot locale="zh-CN" onAction={vi.fn()} />);
  }

  it.each([false, true])("plays a complete blink, with optional second blink: %s", double => {
    startAnimation();
    vi.mocked(Math.random).mockReturnValue(0.5).mockReturnValueOnce(0).mockReturnValueOnce(0);
    fireEvent.load(character());
    advance(2499);
    expect(character().getAttribute("src")).toContain("idle/01.png");
    vi.mocked(Math.random).mockReturnValueOnce(double ? 0 : 0.5);
    advance(1);
    expect(character().getAttribute("src")).toContain("idle/03.png");
    advance(60);
    expect(character().getAttribute("src")).toContain("idle/04.png");
    advance(80);
    expect(character().getAttribute("src")).toContain("idle/03.png");
    advance(80);
    expect(character().getAttribute("src")).toContain("idle/01.png");
    advance(170);
    expect(character().getAttribute("src")).toContain(double ? "idle/03.png" : "idle/01.png");
    advance(220);
    expect(character().getAttribute("src")).toContain("idle/01.png");
    advance(5110);
    expect(character().getAttribute("src")).toContain("panna-working.gif");
  });

  it.each([
    [0, "wave", 2080],
    [0.4, "working", 3000],
    [0.9, "celebrate", 2080]
  ] as const)("plays random action %s for one full cycle after image load", (random, name, duration) => {
    const { rerender } = startAnimation();
    vi.mocked(Math.random).mockReturnValueOnce(0);
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    advance(20000);
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    fireEvent.load(character());
    advance(7999);
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    vi.mocked(Math.random).mockReturnValueOnce(random);
    advance(1);
    const actionImage = character();
    expect(actionImage.getAttribute("src")).toContain(`panna-${name}.gif`);
    advance(4000);
    expect(character()).toBe(actionImage);
    fireEvent.load(actionImage);
    rerender(<DesktopMascot locale="zh-CN" status="completed" sessionTitle="Completed session" onAction={vi.fn()} />);
    // Session updates and clicking the character must not restart the action.
    fireEvent.click(screen.getByRole("button", { name: "拖动看板娘（方向键移动）" }));
    expect(screen.queryByRole("status")).toBeNull();
    advance(duration - 1);
    expect(character()).toBe(actionImage);
    advance(1);
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
  });

  it("waits up to fifteen seconds and avoids repeating the previous random action", () => {
    startAnimation();
    vi.mocked(Math.random).mockReturnValueOnce(0.9999).mockReturnValueOnce(1);
    fireEvent.load(character());
    advance(5999);
    expect(character().getAttribute("src")).toContain("idle/01.png");
    advance(1);
    expect(character().getAttribute("src")).toContain("idle/03.png");
    advance(8998);
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    advance(2);
    expect(character().getAttribute("src")).toContain("panna-wave.gif");
    fireEvent.load(character());
    advance(2080);
    fireEvent.load(character());
    advance(8000);
    expect(character().getAttribute("src")).toContain("panna-working.gif");
  });

  it("uses a still frame for persisted paused preferences", () => {
    localStorage.setItem("pannel-handle.desktop-mascot.v1", JSON.stringify({ animated: false }));
    startAnimation();
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    expect(timerCount()).toBe(0);
  });

  it("cleans up scheduling when collapsed or unmounted", () => {
    const { unmount } = startAnimation();
    fireEvent.load(character());
    fireEvent.mouseEnter(screen.getByRole("complementary"));
    fireEvent.click(screen.getByRole("button", { name: "收起看板娘" }));
    expect(screen.getByRole("complementary").querySelector("img")).toBeNull();
    expect(timerCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "展开看板娘" }));
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    fireEvent.load(character());
    expect(timerCount()).toBe(2);
    unmount();
    expect(timerCount()).toBe(0);
  });

  it("stops motion in the background and starts idle again when visible", () => {
    startAnimation();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    fireEvent.load(character());
    advance(8000);
    fireEvent.load(character());
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    expect(timerCount()).toBe(0);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
  });

  it("respects reduced motion initially and when the system preference changes", () => {
    const media = new EventTarget();
    let reduced = true;
    const matchMedia = Object.defineProperty(media, "matches", { get: () => reduced });
    vi.stubGlobal("matchMedia", vi.fn(() => matchMedia));
    const { unmount } = startAnimation();
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    expect(timerCount()).toBe(0);
    reduced = false;
    act(() => { media.dispatchEvent(new Event("change")); });
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    fireEvent.load(character());
    reduced = true;
    act(() => { media.dispatchEvent(new Event("change")); });
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    expect(timerCount()).toBe(0);
    unmount();
    reduced = false;
    act(() => { media.dispatchEvent(new Event("change")); });
    expect(timerCount()).toBe(0);
  });

  it("falls back to the original image after a load failure without retrying motion", () => {
    startAnimation();
    fireEvent.load(character());
    advance(8000);
    fireEvent.error(character());
    expect(character().getAttribute("src")).toContain("panel-navigator.png");
    expect(timerCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "拖动看板娘（方向键移动）" }));
    fireEvent.load(character());
    advance(30000);
    expect(character().getAttribute("src")).toContain("panel-navigator.png");
    expect(timerCount()).toBe(0);
  });
});
