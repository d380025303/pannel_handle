import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createInspectorNotificationManager } = require("./notification-manager.cjs");
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const tables = new Map(["projects", "findings", "runs"].map(table => [table, new Map()]));
  const store = { get: (table, id) => tables.get(table).get(id), put: (table, value) => { tables.get(table).set(value.id, value); return value; }, list: (table, id) => [...tables.get(table).values()].filter(value => !id || value.projectId === id || value.id === id) };
  store.put("projects", { id: "p", name: "Project", settings: { notifications: true } });
  store.put("findings", { id: "f1", projectId: "p", status: "awaiting_review", severity: "P1" });
  store.put("findings", { id: "f2", projectId: "p", status: "awaiting_review", severity: "P2" });
  const notifications = [];
  class Notification extends EventEmitter { static isSupported() { return true; } constructor(options) { super(); this.options = options; this.show = vi.fn(); this.close = vi.fn(); notifications.push(this); } }
  const windowManager = { isMainWindowFocused: vi.fn(() => false), focusWindow: vi.fn() }; const onOpenProject = vi.fn();
  const create = () => createInspectorNotificationManager({ store, Notification, windowManager, onOpenProject, delayMs: 100 });
  const manager = create();
  return { store, manager, notifications, windowManager, onOpenProject, create };
}
it("merges concurrent findings into one notification and opens the matching project on click", () => {
  const f = fixture();
  f.manager.handleEvent({ type: "findings", projectId: "p", data: { notificationIds: ["f1"] } });
  f.manager.handleEvent({ type: "findings", projectId: "p", data: { notificationIds: ["f1", "f2"] } });
  vi.advanceTimersByTime(100);
  expect(f.notifications).toHaveLength(1); expect(f.notifications[0].options.body).toContain("2 个新增");
  f.notifications[0].emit("click"); expect(f.onOpenProject).toHaveBeenCalledWith("p"); expect(f.windowManager.focusWindow).toHaveBeenCalled();
  expect(f.store.get("projects", "p").pendingNotificationIds).toEqual([]); f.manager.close();
});
it("waits for outstanding role runs and suppresses findings ignored before delivery", () => {
  const f = fixture(); f.store.put("runs", { id: "r", projectId: "p", status: "running" });
  f.manager.handleEvent({ type: "findings", projectId: "p", data: { notificationIds: ["f1"] } }); vi.advanceTimersByTime(100);
  expect(f.notifications).toHaveLength(0);
  f.store.put("runs", { id: "r", projectId: "p", status: "completed" }); f.store.put("findings", { ...f.store.get("findings", "f1"), status: "ignored" });
  vi.advanceTimersByTime(100); expect(f.notifications).toHaveLength(0); f.manager.close();
});
it("recovers pending notifications after restart and does not interrupt a focused main window", () => {
  const f = fixture(); f.manager.handleEvent({ type: "findings", projectId: "p", data: { notificationIds: ["f1"] } }); f.manager.close();
  const restored = f.create(); f.windowManager.isMainWindowFocused.mockReturnValue(true); vi.advanceTimersByTime(100);
  expect(f.notifications).toHaveLength(0); expect(f.store.get("projects", "p").pendingNotificationIds).toEqual([]); restored.close();
});
