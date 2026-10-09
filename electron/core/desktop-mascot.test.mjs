import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopMascot, clampPosition } from "./desktop-mascot.cjs";

describe("desktop mascot window", () => {
  let directory, service, window, ipc, screen, cursor, area, random, graphical, snapshot;
  beforeEach(() => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ph-mascot-"));
    ipc = new EventEmitter();
    ipc.handle = vi.fn();
    area = { x: -1000, y: 0, width: 1000, height: 800 };
    cursor = { x: -500, y: 300 };
    random = vi.fn(() => 0);
    screen = Object.assign(new EventEmitter(), {
      getDisplayMatching: () => ({ workArea: area }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getCursorScreenPoint: () => cursor
    });
    class Window extends EventEmitter {
      constructor(options) {
        super(); window = this; this.options = options; this.bounds = { ...options };
        this.webContents = Object.assign(new EventEmitter(), { send: vi.fn(), mainFrame: {}, setWindowOpenHandler: vi.fn() });
      }
      getBounds() { return { ...this.bounds }; }
      setBounds(bounds) { Object.assign(this.bounds, bounds); }
      setPosition(x, y) { this.setBounds({ x, y }); }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; this.emit("closed"); }
      setIgnoreMouseEvents = vi.fn();
      showInactive = vi.fn();
      loadFile = vi.fn();
    }
    snapshot = { items: [], provider: "codex", threadId: "thread" };
    graphical = { snapshot: () => snapshot, executePlan: vi.fn(async () => { snapshot.pendingPlan = null; }) };
    service = createDesktopMascot({ app: { isPackaged: true, getPath: () => directory }, BrowserWindow: Window, ipcMain: ipc, screen, random,
      terminalManager: { getSession: id => ({ id, title: "后台任务", runtimeMode: "app-server" }) }, graphicalService: graphical });
    service.open({ getBounds: () => area });
  });
  afterEach(() => { service.close(); fs.rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
  function command(payload, sender = window.webContents) {
    ipc.emit("desktop-mascot:command", { sender, senderFrame: sender.mainFrame }, payload);
  }
  function hostState() {
    const handler = ipc.handle.mock.calls.find(call => call[0] === "desktop-mascot:state")[1];
    return handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  }
  async function beginRoaming() {
    command({ type: "interaction", paused: true, reduced: false });
    command({ type: "interaction", paused: false, reduced: false });
    await vi.advanceTimersByTimeAsync(8100);
    expect(hostState().roaming).toBe(true);
  }
  it("restricts direct actions to the mascot main frame and resizes interactive bubbles", async () => {
    snapshot.pendingPlan = { itemId: "plan" }; snapshot.items = [{ id: "plan", type: "plan", text: "完整计划" }];
    service.handleDesktopEvent("codex-app-server:changed", { id: "one" });
    const notification = hostState().notifications.notification;
    expect(window.bounds.height).toBe(620);
    const handler = ipc.handle.mock.calls.find(call => call[0] === "desktop-mascot:action")[1];
    expect(() => handler({ sender: {} }, notification.id, { type: "execute" })).toThrow("无权");
    expect(() => handler({ sender: window.webContents, senderFrame: {} }, notification.id, { type: "execute" })).toThrow("无权");
    expect(graphical.executePlan).not.toHaveBeenCalled();
    await handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, notification.id, { type: "execute" });
    expect(graphical.executePlan).toHaveBeenCalledWith("one", "plan");
    expect(hostState().notifications.notification).toBeNull(); expect(window.bounds.height).toBe(232);
  });
  it("disables immediately, cleans timers and restores position and preferences", async () => {
    command({ type: "preferences", moving: false, collapsed: true });
    window.setPosition(-700, 200);
    const previous = window;
    service.setEnabled(false);
    expect(previous.isDestroyed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.listenerCount("display-removed")).toBe(0);
    service.setEnabled(false);
    service.setEnabled(true, null);
    expect(window).toBe(previous);
    service.setEnabled(true, { getBounds: () => area, isDestroyed: () => true });
    expect(window).toBe(previous);
    service.setEnabled(true, { getBounds: () => area });
    expect(window).not.toBe(previous);
    expect(window.bounds).toMatchObject({ x: -700, y: 200, width: 52, height: 52 });
    expect(hostState()).toMatchObject({ collapsed: true, moving: false });
    const current = window;
    service.setEnabled(true, { getBounds: () => area });
    expect(window).toBe(current);
    expect(screen.listenerCount("display-removed")).toBe(1);
  });

  it("publishes roaming only at transitions and never persists it", async () => {
    await beginRoaming();
    const count = window.webContents.send.mock.calls.filter(call => call[0] === "desktop-mascot:state").length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(window.webContents.send.mock.calls.filter(call => call[0] === "desktop-mascot:state")).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(16000);
    expect(hostState().roaming).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "desktop-mascot.json")));
    expect(saved).not.toHaveProperty("roaming");
    expect(saved).not.toHaveProperty("roamingDirection");
  });
  it.each([[0, "left"], [1, "right"]])("publishes direction with the start of a journey: %s", async (targetX, direction) => {
    expect(hostState().roamingDirection).toBe("left");
    command({ type: "interaction", paused: true, reduced: false });
    random.mockReturnValueOnce(0).mockReturnValueOnce(targetX).mockReturnValueOnce(0);
    command({ type: "interaction", paused: false, reduced: false });
    await vi.advanceTimersByTimeAsync(8100);
    const last = window.webContents.send.mock.calls.filter(call => call[0] === "desktop-mascot:state").at(-1)[1];
    expect(last).toMatchObject({ roaming: true, roamingDirection: direction });
    command({ type: "interaction", paused: true, reduced: false });
    expect(hostState()).toMatchObject({ roaming: false, roamingDirection: direction });
    // A vertical journey must retain the last horizontal facing direction.
    window.setPosition(area.x, area.y + 200);
    random.mockReturnValue(0);
    command({ type: "interaction", paused: false, reduced: false });
    await vi.advanceTimersByTimeAsync(8100);
    expect(hostState()).toMatchObject({ roaming: true, roamingDirection: direction });
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "desktop-mascot.json")));
    expect(saved).not.toHaveProperty("roamingDirection");
  });
  it.each([
    { type: "interaction", paused: true, reduced: false },
    { type: "interaction", paused: false, reduced: true },
    { type: "preferences", moving: false },
    { type: "preferences", collapsed: true },
    { type: "drag-start" },
    { type: "step", direction: "left" }
  ])("ends roaming for %j", async payload => {
    await beginRoaming(); command(payload);
    expect(hostState().roaming).toBe(false);
  });
  it.each(["display-removed", "display-metrics-changed"])("ends roaming on %s", async event => {
    await beginRoaming(); screen.emit(event);
    expect(hostState().roaming).toBe(false);
  });
  it("ends roaming when a result is shown", async () => {
    await beginRoaming();
    service.handleDesktopEvent("agent:status", { id: "a", status: "running", timestamp: 1 });
    service.handleDesktopEvent("agent:status", { id: "a", status: "completed", timestamp: 2, activitySummary: "done" });
    await vi.advanceTimersByTimeAsync(200);
    expect(hostState().roaming).toBe(false);
  });
  it("publishes stopped before closing the window", async () => {
    await beginRoaming(); service.close();
    const last = window.webContents.send.mock.calls.filter(call => call[0] === "desktop-mascot:state").at(-1)[1];
    expect(last.roaming).toBe(false);
  });
  it("does not animate a zero distance journey", async () => {
    window.setPosition(area.x, area.y);
    command({ type: "interaction", paused: true, reduced: false });
    command({ type: "interaction", paused: false, reduced: false });
    await vi.advanceTimersByTimeAsync(25000);
    expect(hostState().roaming).toBe(false);
  });
  it("fits a result bubble within the work area, pauses roaming and preserves click-through margins", async () => {
    service.handleDesktopEvent("agent:status", { id: "a", status: "running", timestamp: 1 });
    service.handleDesktopEvent("agent:status", { id: "a", status: "completed", timestamp: 2, activitySummary: "完成摘要" });
    await vi.advanceTimersByTimeAsync(200);
    expect(window.bounds.width).toBe(320); expect(window.bounds.height).toBe(420);
    expect(window.bounds.x).toBeGreaterThanOrEqual(area.x);
    expect(window.bounds.x + window.bounds.width).toBeLessThanOrEqual(area.x + area.width);
    expect(window.bounds.y + window.bounds.height).toBeLessThanOrEqual(area.y + area.height);
    const snapshot = window.webContents.send.mock.calls.filter(call => call[0] === "desktop-mascot:notifications").at(-1)[1];
    command({ type: "notification-presentation", id: snapshot.notification.id, paused: true });
    const bounds = window.getBounds(); await vi.advanceTimersByTimeAsync(30000);
    expect(window.bounds.x).toBe(bounds.x); expect(window.bounds.y).toBe(bounds.y);
    cursor = { x: bounds.x + 20, y: bounds.y + 20 };
    command({ type: "regions", regions: [{ x: 8, y: 0, width: 304, height: 176 }] });
    await vi.advanceTimersByTimeAsync(33); expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    cursor = { x: bounds.x + 2, y: bounds.y + 180 };
    await vi.advanceTimersByTimeAsync(33); expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    command({ type: "notification-dismiss", id: snapshot.notification.id }, { mainFrame: {} }); expect(window.bounds.width).toBe(320);
    command({ type: "notification-dismiss", id: snapshot.notification.id }); expect(window.bounds.width).toBe(192);
  });
  it("keeps collapsed result bubbles and restores the queue after window recreation", async () => {
    command({ type: "preferences", collapsed: true });
    service.handleDesktopEvent("agent:status", { id: "a", status: "running", timestamp: 1 });
    service.handleDesktopEvent("agent:status", { id: "a", status: "failed", timestamp: 2, message: "失败原因" });
    await vi.advanceTimersByTimeAsync(200);
    expect(window.bounds.height).toBe(240);
    const stateHandler = ipc.handle.mock.calls.find(call => call[0] === "desktop-mascot:state")[1];
    const readState = () => stateHandler({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    expect(readState().notifications.notification.summary).toBe("失败原因");
    service.close(); service.open({ getBounds: () => area });
    expect(readState().notifications.notification.summary).toBe("失败原因");
    const stored = JSON.parse(fs.readFileSync(path.join(directory, "desktop-mascot.json"), "utf8"));
    expect(stored.notifications).toBeUndefined();
    service.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses a secure independent transparent window and moves at 60 DIP per second", () => {
    expect(window.options).toMatchObject({ frame: false, thickFrame: false, transparent: true, focusable: process.platform !== "win32", alwaysOnTop: true, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    window.emit("ready-to-show");
    expect(window.showInactive).toHaveBeenCalled();
    command({ type: "preferences", collapsed: false });
    const start = window.getBounds();
    vi.advanceTimersByTime(9000);
    expect(Math.hypot(window.bounds.x - start.x, window.bounds.y - start.y)).toBeGreaterThan(57);
    expect(Math.hypot(window.bounds.x - start.x, window.bounds.y - start.y)).toBeLessThan(62);
    vi.advanceTimersByTime(25000);
    expect(window.bounds.x).toBeGreaterThanOrEqual(-1000);
    expect(window.bounds.y + window.bounds.height).toBeLessThanOrEqual(800);
  });
  it("pauses for interaction, reduced motion and collapse, then waits afresh", () => {
    command({ type: "preferences", collapsed: false });
    vi.advanceTimersByTime(9000);
    command({ type: "interaction", paused: true, reduced: false });
    const bounds = window.getBounds();
    vi.advanceTimersByTime(30000);
    expect(window.getBounds()).toEqual(bounds);
    command({ type: "interaction", paused: false, reduced: true });
    vi.advanceTimersByTime(30000);
    expect(window.getBounds()).toEqual(bounds);
    command({ type: "interaction", paused: false, reduced: false });
    vi.advanceTimersByTime(7000);
    expect(window.getBounds()).toEqual(bounds);
    command({ type: "preferences", collapsed: true });
    expect(window.bounds.width).toBe(52);
    vi.advanceTimersByTime(30000);
    expect(window.bounds.x).toBe(bounds.x);
  });
  it("drags into another screen, persists only completed movement and corrects unplugged displays", () => {
    command({ type: "drag-start" });
    const before = window.getBounds();
    area = { x: 0, y: 0, width: 1200, height: 900 };
    cursor = { x: 600, y: 400 };
    vi.advanceTimersByTime(66);
    expect(window.bounds.x).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(path.join(directory, "desktop-mascot.json"))).toBe(false);
    command({ type: "drag-end" });
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "desktop-mascot.json")));
    expect(saved.x).toBe(window.bounds.x);
    expect(saved.x).not.toBe(before.x);
    area = { x: -1000, y: 0, width: 1000, height: 800 };
    screen.emit("display-removed");
    expect(window.bounds.x + window.bounds.width).toBeLessThanOrEqual(0);
  });
  it("validates senders, migrates once, and removes timers and display listeners", () => {
    command({ type: "preferences", collapsed: true }, { mainFrame: {} });
    expect(window.bounds.width).toBe(192);
    command({ type: "migrate", collapsed: true, animated: false });
    command({ type: "migrate", collapsed: false, animated: true });
    expect(window.bounds.width).toBe(52);
    service.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.listenerCount("display-removed")).toBe(0);
  });
  it("clamps negative coordinates and undersized work areas", () => {
    expect(clampPosition({ x: -2000, y: 2000 }, area, { width: 192, height: 232 })).toEqual({ x: -1000, y: 568 });
    expect(clampPosition({ x: 10, y: 10 }, { x: 0, y: 0, width: 50, height: 50 }, { width: 192, height: 232 })).toEqual({ x: 0, y: 0 });
  });
});
