// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopMascot } from "./DesktopMascot";
import type { DesktopMascotState } from "../../vite-env";

describe("DesktopMascot desktop window controls", () => {
  afterEach(() => { cleanup(); delete window.desktopMascotApi; vi.useRealTimers(); vi.restoreAllMocks(); });
  it("bounds animated pixel reads, caches static masks and cleans up polling", async () => {
    vi.useFakeTimers();
    localStorage.clear();
    let listener: (state: DesktopMascotState) => void = () => {};
    const state: DesktopMascotState = { collapsed: false, animated: false, moving: false, roaming: false, roamingDirection: "left", migrated: true, locale: "en-US", notifications: { revision: 0, notification: null, pendingCount: 0 } };
    const api = {
      getState: vi.fn().mockResolvedValue(state), onState: vi.fn(callback => { listener = callback; return vi.fn(); }),
      setPreferences: vi.fn(), migrate: vi.fn(), setInteraction: vi.fn(), setRegions: vi.fn(),
      startDrag: vi.fn(), endDrag: vi.fn(), step: vi.fn(), onNotifications: vi.fn(() => vi.fn()),
      dismissNotification: vi.fn(), setNotificationExpanded: vi.fn(), setSummaryExpanded: vi.fn(), setNotificationPresentation: vi.fn(), processNotification: vi.fn().mockResolvedValue(undefined)
    };
    window.desktopMascotApi = api;
    const pixels = new Uint8ClampedArray(192 * 192 * 4);
    for (let y = 0; y < 192; y++) for (let x = 0; x < 30; x++) pixels[(y * 192 + x) * 4 + 3] = 255;
    const context = { clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: pixels })) };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(512);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(512);
    vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 192, height: 192 } as DOMRect);
    render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    await act(async () => {});
    expect(context.getImageData).toHaveBeenCalledTimes(1);
    const sends = api.setRegions.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    fireEvent(window, new Event("resize"));
    expect(context.getImageData).toHaveBeenCalledTimes(1);
    expect(api.setRegions).toHaveBeenCalledTimes(sends);
    act(() => listener({ ...state, animated: true, roaming: true }));
    const reads = context.getImageData.mock.calls.length;
    const walkingSends = api.setRegions.mock.calls.length;
    act(() => vi.advanceTimersByTime(750));
    expect(context.getImageData).toHaveBeenCalledTimes(reads + 3);
    expect(context.getImageData).toHaveBeenLastCalledWith(0, 0, 192, 192);
    expect(api.setRegions).toHaveBeenCalledTimes(walkingSends);
    expect(api.setRegions.mock.lastCall?.[0][0].x).toBe(0);
    act(() => listener({ ...state, animated: true, roaming: true, roamingDirection: "right" }));
    expect(api.setRegions.mock.lastCall?.[0][0].x).toBe(162);
    act(() => listener(state));
    const stoppedReads = context.getImageData.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(context.getImageData).toHaveBeenCalledTimes(stoppedReads);
    act(() => listener({ ...state, animated: true, roaming: true }));
    cleanup();
    const unmountedReads = context.getImageData.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(context.getImageData).toHaveBeenCalledTimes(unmountedReads);
  });
  it("prioritizes walking until roaming ends and restarts the idle delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    localStorage.clear();
    let listener: (state: DesktopMascotState) => void = () => {};
    const state: DesktopMascotState = { collapsed: false, animated: true, moving: true, roaming: false, roamingDirection: "left", migrated: true, locale: "en-US", notifications: { revision: 0, notification: null, pendingCount: 0 } };
    window.desktopMascotApi = {
      getState: vi.fn().mockResolvedValue(state), onState: vi.fn(callback => { listener = callback; return vi.fn(); }),
      setPreferences: vi.fn(), migrate: vi.fn(), setInteraction: vi.fn(), setRegions: vi.fn(),
      startDrag: vi.fn(), endDrag: vi.fn(), step: vi.fn(), onNotifications: vi.fn(() => vi.fn()),
      dismissNotification: vi.fn(), setNotificationExpanded: vi.fn(), setSummaryExpanded: vi.fn(), setNotificationPresentation: vi.fn(), processNotification: vi.fn().mockResolvedValue(undefined)
    };
    render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    await act(async () => {});
    const image = () => screen.getByRole("complementary").querySelector("img")!;
    fireEvent.load(image());
    act(() => vi.advanceTimersByTime(8000));
    expect(image().getAttribute("src")).toContain("panna-wave.gif");
    fireEvent.keyDown(screen.getByRole("button", { name: "Move companion (arrow keys)" }), { key: "ArrowLeft" });
    expect(image().getAttribute("src")).toContain("panna-wave.gif");
    act(() => listener({ ...state, roaming: true }));
    expect(image().getAttribute("src")).toContain("panna-walk.gif");
    const walking = image(); fireEvent.load(walking);
    expect(walking.classList.contains("is-walking-right")).toBe(false);
    act(() => listener({ ...state, roaming: true, roamingDirection: "right" }));
    expect(image()).toBe(walking);
    expect(image().classList.contains("is-walking-right")).toBe(true);
    act(() => listener({ ...state, roaming: true, roamingDirection: "left" }));
    expect(image()).toBe(walking);
    expect(image().classList.contains("is-walking-right")).toBe(false);
    act(() => listener({ ...state, roaming: true, roamingDirection: "right" }));
    act(() => vi.advanceTimersByTime(30000));
    expect(image()).toBe(walking);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(image().getAttribute("src")).toContain("idle/01.png");
    expect(image().classList.contains("is-walking-right")).toBe(false);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(image().getAttribute("src")).toContain("panna-walk.gif");
    act(() => listener({ ...state, roamingDirection: "right" }));
    expect(image().getAttribute("src")).toContain("idle/01.png");
    expect(image().classList.contains("is-walking-right")).toBe(false);
    fireEvent.load(image());
    act(() => vi.advanceTimersByTime(7999));
    expect(image().getAttribute("src")).toContain("idle/01.png");
    act(() => vi.advanceTimersByTime(1));
    expect(image().getAttribute("src")).toContain("panna-working.gif");
    act(() => listener({ ...state, roaming: true, roamingDirection: "right", animated: false }));
    expect(image().getAttribute("src")).toContain("idle/01.png");
    expect(image().classList.contains("is-walking-right")).toBe(false);
    act(() => listener({ ...state, roaming: true, roamingDirection: "right" }));
    fireEvent.error(image());
    expect(image().getAttribute("src")).toContain("panel-navigator.png");
    expect(image().classList.contains("is-walking-right")).toBe(false);
    cleanup(); vi.useRealTimers();
  });
  it("subscribes to host state, toggles roaming and forwards keyboard and collapse actions", async () => {
    let listener: (state: DesktopMascotState) => void = () => {};
    const state: DesktopMascotState = { collapsed: false, animated: false, moving: true, roaming: false, roamingDirection: "left", migrated: true, locale: "en-US", notifications: { revision: 0, notification: null, pendingCount: 0 } };
    const api = {
      getState: vi.fn().mockResolvedValue(state), onState: vi.fn(callback => { listener = callback; return vi.fn(); }),
      setPreferences: vi.fn(), migrate: vi.fn(), setInteraction: vi.fn(), setRegions: vi.fn(),
      startDrag: vi.fn(), endDrag: vi.fn(), step: vi.fn(),
      onNotifications: vi.fn(() => vi.fn()), dismissNotification: vi.fn(), setNotificationExpanded: vi.fn(), setSummaryExpanded: vi.fn(), setNotificationPresentation: vi.fn(), processNotification: vi.fn().mockResolvedValue(undefined)
    };
    window.desktopMascotApi = api;
    render(<DesktopMascot locale="zh-CN" onAction={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("complementary").classList.contains("has-notification")).toBe(false);
    fireEvent.mouseEnter(screen.getByRole("complementary"));
    expect(api.setInteraction).toHaveBeenLastCalledWith(true, false);
    fireEvent.click(screen.getByRole("button", { name: "Pause roaming" }));
    expect(api.setPreferences).toHaveBeenCalledWith({ moving: false });
    act(() => listener({ ...state, moving: false }));
    expect(screen.getByRole("button", { name: "Resume roaming" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move companion (arrow keys)" }), { key: "ArrowLeft" });
    expect(api.step).toHaveBeenCalledWith("left");
    fireEvent.click(screen.getByRole("button", { name: "Minimize companion" }));
    expect(api.setPreferences).toHaveBeenCalledWith({ collapsed: true });
    act(() => listener({ ...state, collapsed: true, locale: "zh-CN" }));
    fireEvent.click(screen.getByRole("button", { name: "展开看板娘" }));
    expect(api.setPreferences).toHaveBeenCalledWith({ collapsed: false });
  });
  it("shows results while collapsed, pauses on hover or focus and dismisses through the host", async () => {
    const state: DesktopMascotState = { collapsed: true, animated: false, moving: true, roaming: false, roamingDirection: "left", migrated: true, locale: "zh-CN",
      notifications: { revision: 1, pendingCount: 2, notification: { id: "1", sessionId: "background", sessionTitle: "后台任务", status: "completed", summary: "## 已完成验证\n\n**重点**\n\n- 列表项\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 通过 |\n\n```js\nconst result = true;\n```\n\n[文档](https://example.com)\n\n" + "完整内容".repeat(60), timestamp: 1 } } };
    let notify: (value: DesktopMascotState["notifications"]) => void = () => {};
    const api = {
      getState: vi.fn().mockResolvedValue(state), onState: vi.fn(() => vi.fn()),
      onNotifications: vi.fn(callback => { notify = callback; return vi.fn(); }),
      setPreferences: vi.fn(), migrate: vi.fn(), setInteraction: vi.fn(), setRegions: vi.fn(),
      startDrag: vi.fn(), endDrag: vi.fn(), step: vi.fn(), dismissNotification: vi.fn(), setNotificationExpanded: vi.fn(), setSummaryExpanded: vi.fn(), setNotificationPresentation: vi.fn(), processNotification: vi.fn().mockResolvedValue(undefined)
    };
    window.desktopMascotApi = api;
    render(<DesktopMascot locale="zh-CN" onAction={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看消息 (2)" }));
    expect(api.setNotificationExpanded).toHaveBeenLastCalledWith("1", true);
    const bubble = screen.getByRole("status");
    expect(screen.getByRole("heading", { name: "已完成验证" })).toBeTruthy();
    expect(bubble.querySelector("strong")?.textContent).toContain("任务已完成");
    expect(bubble.querySelector("ul li")?.textContent).toBe("列表项");
    expect(bubble.querySelector("table")?.textContent).toContain("通过");
    expect(bubble.querySelector("pre code .hljs-keyword")?.textContent).toBe("const");
    expect(bubble.textContent).toContain("完整内容".repeat(60));
    const previousExternalLinkApi = window.externalLinkApi;
    window.externalLinkApi = { open: vi.fn().mockResolvedValue(undefined) };
    fireEvent.click(screen.getByRole("link", { name: "文档" }));
    expect(window.externalLinkApi.open).toHaveBeenCalledWith("https://example.com");
    expect(screen.getByRole("button", { name: "放大查看" })).toBeTruthy();
    window.externalLinkApi = previousExternalLinkApi;
    expect(bubble.textContent).toContain("任务已完成"); expect(bubble.textContent).toContain("后台任务");
    expect(bubble.textContent).toContain("已完成验证"); expect(bubble.textContent).toContain("另有 1 条");
    expect(screen.getByRole("button", { name: "展开看板娘" })).toBeTruthy();
    expect(api.setNotificationPresentation).toHaveBeenLastCalledWith("1", true);
    fireEvent.mouseEnter(bubble); expect(api.setNotificationPresentation).toHaveBeenLastCalledWith("1", true);
    fireEvent.focus(bubble); fireEvent.mouseLeave(bubble); expect(api.setNotificationPresentation).toHaveBeenLastCalledWith("1", true);
    fireEvent.blur(bubble); expect(api.setNotificationPresentation).toHaveBeenLastCalledWith("1", true);
    const summary = bubble.querySelector(".desktop-mascot-summary")!;
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected text" } as Selection);
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: "放大查看" })).toBeTruthy();
    selection.mockRestore();
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: "收起摘要" }).getAttribute("aria-expanded")).toBe("true");
    expect(api.setSummaryExpanded).toHaveBeenLastCalledWith("1", true);
    fireEvent.mouseLeave(bubble); fireEvent.blur(bubble);
    expect(api.setNotificationPresentation).toHaveBeenLastCalledWith("1", true);
    act(() => notify({ ...state.notifications, revision: 2, notification: { ...state.notifications.notification!, summary: "updated summary" } }));
    expect(screen.getByRole("button", { name: "收起摘要" })).toBeTruthy();
    expect(screen.getByText("updated summary")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.setSummaryExpanded).toHaveBeenLastCalledWith("1", false);
    expect(api.setNotificationPresentation).toHaveBeenLastCalledWith("1", true);
    fireEvent.click(screen.getByRole("button", { name: "放大查看" }));
    fireEvent.click(screen.getByRole("button", { name: "收起摘要" }));
    expect(api.setSummaryExpanded).toHaveBeenLastCalledWith("1", false);
    fireEvent.click(screen.getByRole("button", { name: "放大查看" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭任务气泡" })); expect(api.dismissNotification).toHaveBeenCalledWith("1");
    act(() => notify({ revision: 2, pendingCount: 1, notification: { ...state.notifications.notification!, id: "2", status: "failed", summary: "连接失败" } }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看消息 (1)" }));
    expect(screen.getByRole("button", { name: "放大查看" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("任务失败"); expect(screen.getByRole("status").textContent).toContain("连接失败");
    act(() => notify({ revision: 3, pendingCount: 0, notification: null })); expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("complementary").classList.contains("has-notification")).toBe(false);
    act(() => notify(state.notifications)); expect(screen.queryByRole("status")).toBeNull();
  });
  it("cycles unread actions continuously, stops after viewing and restarts for the next message", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    localStorage.clear();
    let notify: (value: DesktopMascotState["notifications"]) => void = () => {};
    const notification = { id: "1", sessionId: "a", sessionTitle: "A", status: "completed" as const, summary: "result", timestamp: 1 };
    const state: DesktopMascotState = { collapsed: false, animated: true, moving: true, roaming: false, roamingDirection: "left", migrated: true, locale: "en-US", notifications: { revision: 1, notification, pendingCount: 1 } };
    window.desktopMascotApi = {
      getState: vi.fn().mockResolvedValue(state), onState: vi.fn(() => vi.fn()),
      onNotifications: vi.fn(callback => { notify = callback; return vi.fn(); }),
      setPreferences: vi.fn(), migrate: vi.fn(), setInteraction: vi.fn(), setRegions: vi.fn(),
      startDrag: vi.fn(), endDrag: vi.fn(), step: vi.fn(), dismissNotification: vi.fn(),
      setNotificationExpanded: vi.fn(), setSummaryExpanded: vi.fn(), setNotificationPresentation: vi.fn(), processNotification: vi.fn()
    };
    const { unmount } = render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    await act(async () => {});
    const image = () => screen.getByRole("complementary").querySelector("img")!;
    expect(screen.queryByRole("status")).toBeNull();
    expect(image().getAttribute("src")).toContain("panna-wave.gif");
    fireEvent.load(image());
    act(() => vi.advanceTimersByTime(2080));
    expect(image().getAttribute("src")).toContain("panna-working.gif");
    fireEvent.load(image());
    act(() => vi.advanceTimersByTime(3000));
    expect(image().getAttribute("src")).toContain("panna-wave.gif");
    fireEvent.click(screen.getByRole("button", { name: "View message (1)" }));
    expect(image().getAttribute("src")).toContain("idle/01.png");
    fireEvent.mouseEnter(screen.getByRole("status"));
    fireEvent.focus(screen.getByRole("status"));
    fireEvent.click(screen.getByRole("button", { name: "Hide message (1)" }));
    expect(window.desktopMascotApi.setNotificationPresentation).toHaveBeenLastCalledWith("1", false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(image().getAttribute("src")).toContain("idle/01.png");
    act(() => notify({ revision: 2, notification: { ...notification, id: "2" }, pendingCount: 1 }));
    expect(image().getAttribute("src")).toContain("panna-wave.gif");
    act(() => notify({ revision: 3, notification: null, pendingCount: 0 }));
    expect(screen.queryByRole("button", { name: /View message/ })).toBeNull();
    expect(image().getAttribute("src")).toContain("idle/01.png");
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a newer notification event when the initial snapshot resolves late", async () => {
    let resolve: (value: DesktopMascotState) => void = () => {};
    let notify: (value: DesktopMascotState["notifications"]) => void = () => {};
    window.desktopMascotApi = {
      getState: vi.fn(() => new Promise<DesktopMascotState>(done => { resolve = done; })), onState: vi.fn(() => vi.fn()),
      onNotifications: vi.fn(callback => { notify = callback; return vi.fn(); }),
      setPreferences: vi.fn(), migrate: vi.fn(), setInteraction: vi.fn(), setRegions: vi.fn(), startDrag: vi.fn(), endDrag: vi.fn(), step: vi.fn(),
      dismissNotification: vi.fn(), setNotificationExpanded: vi.fn(), setSummaryExpanded: vi.fn(), setNotificationPresentation: vi.fn(), processNotification: vi.fn().mockResolvedValue(undefined)
    };
    render(<DesktopMascot locale="en-US" onAction={vi.fn()} />);
    act(() => notify({ revision: 2, pendingCount: 1, notification: { id: "2", sessionId: "a", sessionTitle: "A", status: "completed", summary: "暂无摘要", timestamp: 1 } }));
    await act(async () => resolve({ collapsed: true, animated: false, moving: true, roaming: false, roamingDirection: "left", migrated: true, locale: "en-US", notifications: { revision: 1, pendingCount: 0, notification: null } }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View message (1)" }));
    expect(screen.getByRole("status").textContent).toContain("No summary available");
  });
});

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
