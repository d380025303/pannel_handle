import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createModuleOwnerStore } = require("./module-owner-store.cjs");
const { createModuleOwnerScheduler } = require("./module-owner-scheduler.cjs");
function fixture(tasks = []) {
  const value = { records: [{ id: "owner", responsibilities: "large", directories: ["src"] }], history: [], tasks };
  const write = vi.fn();
  const store = createModuleOwnerStore({ userData: ".", dataStore: { read: () => ({ schemaVersion: 1, templates: { one: value } }), write } });
  return { value, store, write };
}
it("returns only owner IDs and isolated tasks, preserving full get and template isolation", () => {
  const f = fixture([{ id: "task", tools: ["tool"], schedule: { kind: "interval", minutes: 1, count: 2 }, lastRun: { status: "completed" } }]);
  const full = f.store.get("one");
  const projected = f.store.getSchedulerState("one");
  expect(projected).toEqual({ records: [{ id: "owner" }], tasks: full.tasks });
  projected.records[0].id = "changed";
  projected.tasks[0].tools.push("changed");
  projected.tasks[0].schedule.count = 100;
  projected.tasks[0].lastRun.status = "failed";
  expect(f.store.get("one")).toEqual(full);
  expect(f.store.getSchedulerState("missing")).toEqual({ records: [], tasks: [] });
  expect(f.store.templateIds()).toEqual(["one"]);
});
it("idle ticks never access owner payloads or history and never write", async () => {
  const f = fixture();
  Object.defineProperty(f.value, "history", { get: () => { throw new Error("history accessed"); } });
  Object.defineProperty(f.value.records[0], "responsibilities", { get: () => { throw new Error("owner payload accessed"); } });
  const fullRead = vi.spyOn(f.store, "get");
  const read = vi.spyOn(f.store, "getSchedulerState");
  const scheduler = createModuleOwnerScheduler({ store: f.store, template: () => ({}), supported: () => true, job: () => null });
  await scheduler.tick(); await scheduler.tick();
  expect(fullRead).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(6);
  expect(f.write).not.toHaveBeenCalled();
});
it("scheduler reads propagate corrupt-store errors", () => {
  const store = createModuleOwnerStore({ userData: ".", dataStore: { read: () => { throw new Error("corrupt"); } } });
  expect(() => store.getSchedulerState("one")).toThrow("负责人数据读取失败");
});

it("disables deleted owners' tasks without changing counts or relaunching on later ticks", async () => {
  const f = fixture([{ id: "task", ownerId: "owner", enabled: true, executedCount: 1, nextRunAt: 1, schedule: { kind: "interval", minutes: 1, count: 2 } }]);
  f.value.records = [];
  const revoke = vi.fn(); const launch = vi.fn();
  const scheduler = createModuleOwnerScheduler({ store: f.store, template: () => ({}), supported: () => true, job: () => null, revoke, launch, now: () => 1000 });
  await scheduler.tick();
  expect(revoke).toHaveBeenCalledWith("owner");
  expect(f.store.getSchedulerState("one").tasks[0]).toMatchObject({ enabled: false, nextRunAt: null, executedCount: 1, lastRun: { status: "stopped", error: "负责人已删除。" } });
  expect(f.write).toHaveBeenCalledTimes(1);
  await scheduler.tick();
  expect(launch).not.toHaveBeenCalled();
  expect(f.store.getSchedulerState("one").tasks[0].enabled).toBe(false);
});
