import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopMascot, clampPosition } from "./desktop-mascot.cjs";

describe("desktop mascot window", () => {
  let directory, service, window, ipc, screen, cursor, area, random, graphical, snapshot, app, clockOffset;
  beforeEach(() => {
    vi.useFakeTimers();
    clockOffset = 0;
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
      setMaximizable = vi.fn();
      hookWindowMessage = vi.fn();
      loadFile = vi.fn();
    }
    snapshot = { items: [], provider: "codex", threadId: "thread" };
    graphical = { snapshot: () => snapshot, executePlan: vi.fn(async () => { snapshot.pendingPlan = null; }) };
    app = Object.assign(new EventEmitter(), { isPackaged: true, getPath: () => directory });
    service = createDesktopMascot({ app, BrowserWindow: Window, ipcMain: ipc, screen, random, now: () => performance.now() + clockOffset,
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
  function reopenHost(focused = true) {
    service.close();
    const host = Object.assign(new EventEmitter(), { getBounds: () => area, isFocused: () => focused });
    service.open(host);
    return host;
  }
  function pendingPlan() {
    snapshot.pendingPlan = { itemId: "plan" };
    snapshot.items = [{ id: "plan", type: "plan", text: "完整计划" }];
    service.handleDesktopEvent("codex-app-server:changed", { id: "one" });
  }
  it("only updates mouse passthrough on transitions and resets it on reopen", async () => {
    command({ type: "preferences", moving: false });
    await vi.advanceTimersByTimeAsync(330);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
    const bounds = window.getBounds();
    command({ type: "regions", regions: [{ x: 0, y: 0, width: 192, height: 232 }] });
    cursor = { x: bounds.x + 20, y: bounds.y + 20 };
    await vi.advanceTimersByTimeAsync(330);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledTimes(2);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    cursor = { x: area.x, y: area.y };
    await vi.advanceTimersByTimeAsync(330);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledTimes(3);
    const closed = window;
    service.close();
    await vi.advanceTimersByTimeAsync(330);
    expect(closed.setIgnoreMouseEvents).toHaveBeenCalledTimes(3);
    service.open({ getBounds: () => area });
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledTimes(1);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
  });
  it("skips native moves when clamping leaves the position unchanged", () => {
    command({ type: "preferences", moving: false });
    window.setBounds({ x: area.x, y: area.y });
    const move = vi.spyOn(window, "setPosition");
    command({ type: "step", direction: "left" });
    command({ type: "step", direction: "up" });
    expect(move).not.toHaveBeenCalled();
    command({ type: "step", direction: "right" });
    expect(move).toHaveBeenCalledWith(area.x + 20, area.y);
  });
  it("suppresses foreground requests in initial state and pushes, then restores valid requests", () => {
    const host = reopenHost();
    pendingPlan();
    expect(hostState().notifications).toMatchObject({ notification: null, pendingCount: 1 });
    expect(window.bounds).toMatchObject({ width: 192, height: 232 });
    expect(window.webContents.send.mock.calls.filter(([channel]) => channel === "desktop-mascot:notifications").at(-1)[1].notification).toBeNull();
    const revision = hostState().notifications.revision;
    host.emit("blur");
    expect(hostState().notifications.notification.action.kind).toBe("plan");
    expect(hostState().notifications.revision).toBeGreaterThan(revision);
    expect(window.bounds.height).toBe(272);
    command({ type: "notification-expanded", id: hostState().notifications.notification.id, expanded: true });
    expect(window.bounds.height).toBe(660);
    host.emit("focus");
    snapshot.pendingPlan = null;
    service.handleDesktopEvent("codex-app-server:changed", { id: "one" });
    host.emit("blur");
    expect(hostState().notifications.notification).toBeNull();
  });
  it("hides expanded summaries, preserves the character anchor and pauses remaining lifetime", async () => {
    const host = reopenHost(false);
    command({ type: "preferences", moving: false });
    service.handleDesktopEvent("agent:status", { id: "one", status: "running", timestamp: 1 });
    snapshot.items = [{ id: "reply", type: "agentMessage", text: "完成" }];
    service.handleDesktopEvent("agent:status", { id: "one", status: "completed", timestamp: 2 });
    await vi.advanceTimersByTimeAsync(200);
    const notification = hostState().notifications.notification;
    expect(notification).not.toBeNull();
    command({ type: "notification-presentation", id: notification.id, paused: false });
    await vi.advanceTimersByTimeAsync(5000);
    command({ type: "notification-expanded", id: notification.id, expanded: true });
    command({ type: "summary-expanded", id: notification.id, expanded: true });
    const anchor = { x: window.bounds.x + window.bounds.width / 2, y: window.bounds.y + window.bounds.height };
    host.emit("focus");
    expect(window.bounds).toMatchObject({ width: 192, height: 232 });
    expect(window.bounds.x + window.bounds.width / 2).toBe(anchor.x);
    expect(window.bounds.y + window.bounds.height).toBe(anchor.y - 40);
    command({ type: "notification-presentation", id: notification.id, paused: false });
    await vi.advanceTimersByTimeAsync(20000);
    host.emit("blur");
    expect(hostState().notifications.notification.id).toBe(notification.id);
    expect(window.bounds).toMatchObject({ width: 192, height: 272 });
    command({ type: "notification-presentation", id: notification.id, paused: false });
    await vi.advanceTimersByTimeAsync(54999);
    expect(hostState().notifications.notification.id).toBe(notification.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(hostState().notifications.notification).toBeNull();
  });
  it("removes host listeners on close and initializes focus again on reopen", () => {
    const host = reopenHost(false);
    pendingPlan();
    service.close();
    expect(host.listenerCount("focus")).toBe(0);
    expect(host.listenerCount("blur")).toBe(0);
    host.isFocused = () => true;
    service.open(host);
    expect(host.listenerCount("focus")).toBe(1);
    expect(hostState().notifications.notification).toBeNull();
    host.emit("blur");
    expect(hostState().notifications.notification.action.kind).toBe("plan");
  });
  it.skipIf(process.platform !== "win32")("refreshes native frame after app blur or native activation and cleans up", () => {
    const activate = window.hookWindowMessage.mock.calls.find(([message]) => message === 0x0086)[1];
    app.emit("browser-window-blur", {}, {});
    activate();
    expect(window.setMaximizable).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(window.setMaximizable).toHaveBeenCalledExactlyOnceWith(false);
    activate();
    service.close();
    vi.advanceTimersByTime(0);
    expect(window.setMaximizable).toHaveBeenCalledTimes(1);
    expect(app.listenerCount("browser-window-blur")).toBe(0);
    service.open({ getBounds: () => area });
    expect(app.listenerCount("browser-window-blur")).toBe(1);
    app.emit("browser-window-blur", {}, {});
    vi.advanceTimersByTime(0);
    expect(window.setMaximizable).toHaveBeenCalledExactlyOnceWith(false);
  });
  async function beginRoaming() {
    command({ type: "interaction", paused: true, reduced: false });
    command({ type: "interaction", paused: false, reduced: false });
    await vi.advanceTimersByTimeAsync(8100);
    expect(hostState().roaming).toBe(true);
  }
  it.each([-86400000, 86400000])("ignores wall clock changes during roaming: %s", async jump => {
    await beginRoaming();
    const before = window.getBounds();
    vi.setSystemTime(Date.now() + jump);
    await vi.advanceTimersByTimeAsync(1000);
    const after = window.getBounds();
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(57);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(63);
  });
  it("clamps negative elapsed time and completes after a long suspension", async () => {
    await beginRoaming();
    clockOffset = -86400000;
    await vi.advanceTimersByTimeAsync(33);
    expect(window.bounds).toMatchObject({ x: -216, y: 560 });
    clockOffset = 86400000;
    await vi.advanceTimersByTimeAsync(33);
    expect(window.bounds).toMatchObject({ x: -1000, y: 0 });
    expect(hostState().roaming).toBe(false);
  });
  it("recovers a failed position update and waits before roaming again", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await beginRoaming();
    const move = vi.spyOn(window, "setPosition").mockImplementationOnce(() => { throw new TypeError("conversion failure"); });
    await vi.advanceTimersByTimeAsync(33);
    expect(hostState().roaming).toBe(false);
    expect(window.isDestroyed()).toBeFalsy();
    await vi.advanceTimersByTimeAsync(7000);
    expect(move).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(hostState().roaming).toBe(true);
    expect(log.mock.calls[0][1]).toMatchObject({ operation: "movement", position: { x: expect.any(Number), y: expect.any(Number) }, progress: expect.any(Number) });
    log.mockRestore();
  });
  it("stops retries when recovery fails and still accepts notifications", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await beginRoaming();
    const move = vi.spyOn(window, "setPosition").mockImplementation(() => { throw new Error("move failed"); });
    const resize = vi.spyOn(window, "setBounds").mockImplementationOnce(() => { throw new Error("recovery failed"); });
    await vi.advanceTimersByTimeAsync(30000);
    expect(move).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    pendingPlan();
    expect(hostState().notifications.notification.action.kind).toBe("plan");
    log.mockRestore();
  });
  it("rejects invalid drag coordinates without moving or persisting them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    command({ type: "drag-start" });
    cursor = { x: NaN, y: Infinity };
    const move = vi.spyOn(window, "setPosition");
    await vi.advanceTimersByTimeAsync(33);
    expect(move).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(directory, "desktop-mascot.json")))).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    log.mockRestore();
  });
  it("recovers errors while starting movement", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    command({ type: "interaction", paused: true, reduced: false });
    random.mockReturnValueOnce(0).mockReturnValueOnce(NaN);
    command({ type: "interaction", paused: false, reduced: false });
    await vi.advanceTimersByTimeAsync(8000);
    expect(log.mock.calls[0][1].operation).toBe("movement-start");
    expect(hostState().roaming).toBe(false);
    log.mockRestore();
  });
  it("stops repeated polling errors and leaves notification controls clickable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const poll = vi.spyOn(screen, "getCursorScreenPoint").mockImplementation(() => { throw new Error("cursor unavailable"); });
    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    pendingPlan();
    expect(hostState().notifications.notification.action.kind).toBe("plan");
    log.mockRestore();
  });
  it("guards manual step failures", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window, "setPosition").mockImplementationOnce(() => { throw new Error("step failed"); });
    expect(() => command({ type: "step", direction: "left" })).not.toThrow();
    expect(log.mock.calls[0][1].operation).toBe("step");
    expect(window.isDestroyed()).toBeFalsy();
    log.mockRestore();
  });
  it("ignores saved positions outside Electron's integer range", () => {
    service.close();
    fs.writeFileSync(path.join(directory, "desktop-mascot.json"), JSON.stringify({ x: 3e9, y: 3e9 }));
    // Recreate to reload persisted data, rather than reusing its in-memory copy.
    const previous = service;
    service = createDesktopMascot({ app, BrowserWindow: window.constructor, ipcMain: ipc, screen,
      terminalManager: { getSession: () => null }, graphicalService: graphical });
    service.open({ getBounds: () => area });
    expect(window.bounds).toMatchObject({ x: -216, y: 560 });
    previous.shutdown();
  });
  it.each([NaN, Infinity])("rejects non-finite geometry: %s", value => {
    expect(() => clampPosition({ x: value, y: 0 }, area, { width: 192, height: 232 })).toThrow("geometry");
  });
  it("rejects work areas outside Electron's integer range", () => {
    expect(() => clampPosition({ x: 3e9, y: 0 }, { x: 3e9, y: 0, width: 1000, height: 800 }, { width: 192, height: 232 })).toThrow("integer range");
  });
  it("keeps unread messages compact, rejects invalid expansion and expires after sixty seconds", async () => {
    pendingPlan();
    const id = hostState().notifications.notification.id;
    const compact = window.getBounds();
    expect(compact).toMatchObject({ width: 192, height: 272 });
    command({ type: "notification-expanded", id: "stale", expanded: true });
    command({ type: "notification-expanded", id, expanded: true }, { mainFrame: {} });
    command({ type: "notification-expanded", id, expanded: "true" });
    expect(window.bounds).toEqual(compact);
    command({ type: "regions", regions: [{ x: 36, y: 236, width: 120, height: 32 }] });
    cursor = { x: compact.x + 50, y: compact.y + 250 };
    await vi.advanceTimersByTimeAsync(33);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    await vi.advanceTimersByTimeAsync(59966);
    expect(hostState().notifications.notification.id).toBe(id);
    expect(window.bounds.x).toBe(compact.x);
    await vi.advanceTimersByTimeAsync(1);
    expect(hostState().notifications.notification).toBeNull();
    command({ type: "notification-expanded", id, expanded: true });
    expect(window.bounds).toMatchObject({ width: 192, height: 232 });
  });
  it("restricts direct actions to the mascot main frame and resizes interactive bubbles", async () => {
    snapshot.pendingPlan = { itemId: "plan" }; snapshot.items = [{ id: "plan", type: "plan", text: "完整计划" }];
    service.handleDesktopEvent("codex-app-server:changed", { id: "one" });
    const notification = hostState().notifications.notification;
    command({ type: "notification-expanded", id: notification.id, expanded: true });
    expect(window.bounds.height).toBe(660);
    command({ type: "summary-expanded", id: notification.id, expanded: true });
    command({ type: "notification-expanded", id: notification.id, expanded: true });
    expect(window.bounds.height).toBe(660);
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
    expect(window.bounds).toMatchObject({ width: 192, height: 272 });
    command({ type: "notification-expanded", id: hostState().notifications.notification.id, expanded: true });
    expect(window.bounds.width).toBe(320); expect(window.bounds.height).toBe(460);
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
  it("expands only the current summary, keeps it alive and fits smaller displays", async () => {
    window.setPosition(-700, 568);
    service.handleDesktopEvent("agent:status", { id: "a", status: "running", timestamp: 1 });
    service.handleDesktopEvent("agent:status", { id: "a", status: "completed", timestamp: 2, activitySummary: "result" });
    await vi.advanceTimersByTimeAsync(200);
    const id = hostState().notifications.notification.id;
    command({ type: "notification-presentation", id, paused: false });
    await vi.advanceTimersByTimeAsync(5000);
    command({ type: "notification-expanded", id, expanded: true });
    const original = window.getBounds();
    command({ type: "summary-expanded", id: "stale", expanded: true });
    command({ type: "summary-expanded", id, expanded: true }, { mainFrame: {} });
    expect(window.bounds).toEqual(original);
    command({ type: "summary-expanded", id, expanded: true });
    expect(window.bounds).toMatchObject({ width: 656, height: 770 });
    expect(window.bounds.x + window.bounds.width / 2).toBe(original.x + original.width / 2);
    expect(window.bounds.y + window.bounds.height).toBe(original.y + original.height);
    command({ type: "notification-presentation", id, paused: false });
    await vi.advanceTimersByTimeAsync(30000);
    expect(hostState().notifications.notification.id).toBe(id);
    area = { x: -1000, y: 0, width: 500, height: 600 };
    screen.emit("display-metrics-changed");
    expect(window.bounds).toMatchObject({ x: -1000, y: 0, width: 500, height: 600 });
    command({ type: "summary-expanded", id, expanded: false });
    expect(window.bounds).toMatchObject({ width: 320, height: 460 });
    command({ type: "notification-expanded", id, expanded: false });
    await vi.advanceTimersByTimeAsync(55001);
    expect(hostState().notifications.notification).toBeNull();
    expect(window.bounds).toMatchObject({ width: 192, height: 232 });
  });
  it("keeps collapsed result bubbles and restores the queue after window recreation", async () => {
    command({ type: "preferences", collapsed: true });
    service.handleDesktopEvent("agent:status", { id: "a", status: "running", timestamp: 1 });
    service.handleDesktopEvent("agent:status", { id: "a", status: "failed", timestamp: 2, message: "失败原因" });
    await vi.advanceTimersByTimeAsync(200);
    expect(window.bounds).toMatchObject({ width: 120, height: 92 });
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
    expect(window.options).toMatchObject({ frame: false, thickFrame: false, transparent: true, focusable: true, alwaysOnTop: true, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
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
