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

  it("reflects the current session status without stealing input focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const { rerender } = render(<DesktopMascot locale="zh-CN" status="running" sessionTitle="Session A" onAction={vi.fn()} />);
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    expect(screen.getByText("Session A")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("正在工作");
    rerender(<DesktopMascot locale="zh-CN" status="waiting_for_permission" sessionTitle="Session B" onAction={vi.fn()} />);
    expect(screen.getByText("Session B")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("需要你的回应");
    input.remove();
  });

  it("routes shortcuts only after a click and closes the conversation", () => {
    const onAction = vi.fn();
    render(<DesktopMascot locale="zh-CN" onAction={onAction} />);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(onAction).toHaveBeenCalledWith("skills");
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("provides local guidance without triggering actions or rendering user HTML", () => {
    const onAction = vi.fn();
    render(<DesktopMascot locale="zh-CN" onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SSH <script>alert(1)</script>" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByText(/点击「新建会话」选择 SSH/)).toBeTruthy();
    expect(screen.getByRole("log").querySelector("script")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    expect(localStorage.getItem("pannel-handle.desktop-mascot.v1")).not.toContain("script");
  });

  it("persists collapse, animation and keyboard positioning across remounts", () => {
    const props = { locale: "en-US" as const, onAction: vi.fn() };
    const { unmount } = render(<DesktopMascot {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Talk to Panna" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Move companion (arrow keys)" }), { key: "ArrowLeft" });
    const saved = JSON.parse(localStorage.getItem("pannel-handle.desktop-mascot.v1")!);
    expect(saved.animated).toBe(false);
    expect(Number.isFinite(saved.x)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Minimize companion" }));
    unmount();
    render(<DesktopMascot {...props} />);
    expect(screen.getByRole("button", { name: "Expand companion" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand companion" }));
    expect(screen.getByRole("button", { name: "Talk to Panna" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Talk to Panna" }).querySelector("img")?.getAttribute("src")).toContain("frames/idle/01.png");
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
    expect(screen.getByRole("button", { name: "Talk to Panna" })).toBeTruthy();
  });

  function character() {
    return screen.getByRole("button", { name: "和小帕聊聊" }).querySelector("img")!;
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

  it.each([
    [0, "wave", 2080],
    [0.4, "working", 3000],
    [0.9, "celebrate", 2080]
  ] as const)("plays random action %s for one full cycle after image load", (random, name, duration) => {
    const { rerender } = startAnimation();
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(random);
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
    advance(20000);
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
    fireEvent.load(character());
    advance(7999);
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
    advance(1);
    const actionImage = character();
    expect(actionImage.getAttribute("src")).toContain(`panna-${name}.gif`);
    advance(4000);
    expect(character()).toBe(actionImage);
    fireEvent.load(actionImage);
    rerender(<DesktopMascot locale="zh-CN" status="completed" sessionTitle="Completed session" onAction={vi.fn()} />);
    // Session updates and opening the conversation must not restart the action.
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    expect(screen.getByRole("status").textContent).toContain("本轮任务已完成");
    advance(duration - 1);
    expect(character()).toBe(actionImage);
    advance(1);
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
  });

  it("waits up to fifteen seconds and avoids repeating the previous random action", () => {
    startAnimation();
    vi.mocked(Math.random).mockReturnValueOnce(0.9999).mockReturnValueOnce(0);
    fireEvent.load(character());
    advance(14998);
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
    advance(2);
    expect(character().getAttribute("src")).toContain("panna-wave.gif");
    fireEvent.load(character());
    advance(2080);
    fireEvent.load(character());
    advance(8000);
    expect(character().getAttribute("src")).toContain("panna-working.gif");
  });

  it("uses a still frame when paused and resumes with a fresh idle image", () => {
    startAnimation();
    fireEvent.load(character());
    advance(8000);
    fireEvent.load(character());
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停动画" }));
    expect(character().getAttribute("src")).toContain("frames/idle/01.png");
    expect(timerCount()).toBe(0);
    advance(30000);
    fireEvent.click(screen.getByRole("button", { name: "开启动画" }));
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
    fireEvent.load(character());
    advance(7999);
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
  });

  it("cleans up scheduling when collapsed or unmounted", () => {
    const { unmount } = startAnimation();
    fireEvent.load(character());
    fireEvent.click(screen.getByRole("button", { name: "收起看板娘" }));
    expect(screen.getByRole("complementary").querySelector("img")).toBeNull();
    expect(timerCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "展开看板娘" }));
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
    fireEvent.load(character());
    expect(timerCount()).toBe(1);
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
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
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
    expect(character().getAttribute("src")).toContain("panna-idle.gif");
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
    fireEvent.click(screen.getByRole("button", { name: "和小帕聊聊" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停动画" }));
    fireEvent.click(screen.getByRole("button", { name: "开启动画" }));
    fireEvent.load(character());
    advance(30000);
    expect(character().getAttribute("src")).toContain("panel-navigator.png");
    expect(timerCount()).toBe(0);
  });
});
