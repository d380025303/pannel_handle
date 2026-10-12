import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
const { createModuleOwnerScheduler } = require("./module-owner-scheduler.cjs");
const { createModuleOwnerStore } = require("./module-owner-store.cjs");
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");

function fixture(historyCount = 1000, options = {}) {
  const userData = path.resolve("scheduler-batch-memory");
  const file = path.join(userData, "module-owners.json");
  const dataStore = createBusinessDataStore({ userData, databaseFile: ":memory:" }).open();
  const records = Array.from({ length: 50 }, (_, i) => ({ id: `owner-${i}`, responsibilities: "x".repeat(2000) }));
  const tasks = records.map((record, i) => ({ id: `task-${i}`, ownerId: record.id, enabled: true, executedCount: 0, nextRunAt: 1000000, schedule: { kind: "interval", minutes: 1, count: 2 } }));
  const history = Array.from({ length: historyCount }, (_, i) => ({ id: `history-${i}`, kind: "owner", ownerId: records[0].id, before: records[0], after: records[0] }));
  dataStore.write(file, { schemaVersion: 1, templates: { one: { revision: 1, records, tasks, history, settings: {} } } });
  const write = vi.spyOn(dataStore, "writeModuleOwnerTaskMetadata");
  const broadcast = vi.fn();
  const store = createModuleOwnerStore({ userData, dataStore, broadcast });
  const launch = vi.fn(() => new Promise(() => {}));
  const service = createModuleOwnerScheduler({ store, template: () => ({}), supported: () => true, now: () => 1000000,
    launch, job: () => undefined, submitted: () => false, ownerBusy: () => false, revoke: vi.fn(), revokeTask: vi.fn(), ...options });
  return { dataStore, store, service, launch, write, broadcast };
}

it("persists and broadcasts 50 due tasks once before dispatch with large SQLite history", async () => {
  const f = fixture();
  try {
    f.launch.mockImplementation(() => {
      expect(f.write).toHaveBeenCalledTimes(1);
      expect(f.store.getSchedulerState("one").tasks.every(task => task.nextRunAt === 1060000)).toBe(true);
      return new Promise(() => {});
    });
    const start = performance.now();
    const delayed = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
    await f.service.tick();
    const elapsed = performance.now() - start;
    const delay = await delayed;
    console.log(JSON.stringify({ tasks: 50, history: 1000, tickMs: elapsed, timerDelayMs: delay }));
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    expect(f.launch).toHaveBeenCalledTimes(50);
    expect(new Set(f.launch.mock.calls.map(([, task]) => task.id)).size).toBe(50);
    expect(f.store.getSchedulerState("one").tasks.every(task => task.executedCount === 0)).toBe(true);
    expect(f.store.get("one").history).toHaveLength(1000);
    await f.service.tick();
    expect(f.write).toHaveBeenCalledTimes(1);
  } finally { f.service.shutdown(); f.dataStore.close(); }
});

it("batches skipped and failed checks while preserving same-owner exclusion and completion counts", async () => {
  const runs = new Map();
  const f = fixture(0, { taskUnprocessed: (_id, taskId) => {
    if (taskId === "task-0") return true;
    if (taskId === "task-1") throw new Error("check failed");
    return false;
  }, ownerBusy: (_id, ownerId) => ownerId === "owner-2", job: id => runs.get(id), submitted: id => runs.has(id) });
  try {
    const tasks = f.store.getSchedulerState("one").tasks;
    tasks[4].ownerId = tasks[3].ownerId;
    f.store.tasks("one", tasks); f.write.mockClear(); f.broadcast.mockClear();
    const completions = [];
    f.launch.mockImplementation((_id, task) => new Promise(resolve => completions.push(() => { runs.set(task.id, { status: "running", startedAt: 1000000 }); resolve(); })));
    await f.service.tick();
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.broadcast).toHaveBeenCalledTimes(1);
    expect(f.launch).toHaveBeenCalledTimes(46);
    expect(f.store.getSchedulerState("one").tasks.slice(0, 5).map(task => task.lastRun?.status)).toEqual(["skipped", "failed", "skipped", undefined, "skipped"]);
    completions.forEach(done => done());
    await new Promise(resolve => setTimeout(resolve, 0));
    await f.service.tick();
    expect(f.store.getSchedulerState("one").tasks.every(task => task.executedCount === (runs.has(task.id) ? 1 : 0))).toBe(true);
  } finally { f.service.shutdown(); f.dataStore.close(); }
});

it("does not dispatch or retain reservations when batch persistence fails", async () => {
  const f = fixture(0);
  try {
    f.write.mockImplementationOnce(() => { throw new Error("write failed"); });
    await expect(f.service.tick()).rejects.toThrow("write failed");
    expect(f.launch).not.toHaveBeenCalled();
    await f.service.tick();
    expect(f.launch).toHaveBeenCalledTimes(50);
  } finally { f.service.shutdown(); f.dataStore.close(); }
});
