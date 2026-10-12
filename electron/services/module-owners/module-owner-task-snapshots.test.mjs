import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createModuleOwnerStore } = require("./module-owner-store.cjs");
const { createModuleOwnerScheduler } = require("./module-owner-scheduler.cjs");

function fixture(historyCount, metadata = true) {
  const owner = { id: "owner", responsibilities: "x".repeat(20000), recentActivity: "" };
  const value = { revision: 1, records: [owner], history: Array.from({ length: historyCount }, (_, id) => ({ id, before: { ...owner }, after: { ...owner } })), settings: {} };
  const write = vi.fn(); const broadcast = vi.fn();
  const store = createModuleOwnerStore({ userData: "unused", broadcast, dataStore: {
    read: () => ({ schemaVersion: 1, templates: { one: value } }), write,
    ...(metadata ? { writeModuleOwnerTaskMetadata: write } : {})
  } });
  return { store, value, write, broadcast };
}

it.each([true, false])("keeps default snapshots isolated and supports snapshot-free writes (metadata=%s)", metadata => {
  const f = fixture(2, metadata);
  const tasks = [{ id: "task", enabled: true }];
  const snapshot = f.store.tasks("one", tasks);
  expect(snapshot).toEqual({ ...f.value, tasks });
  snapshot.history[0].before.responsibilities = "changed";
  snapshot.tasks[0].enabled = false;
  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    expect(f.store.tasks("one", tasks, { returnSnapshot: false })).toBeUndefined();
    expect(clone.mock.calls.map(([input]) => input)).toEqual([tasks]);
  } finally { clone.mockRestore(); }
  tasks[0].enabled = false;
  expect(f.store.get("one").history[0].before.responsibilities).toHaveLength(20000);
  expect(f.store.getSchedulerState("one").tasks[0].enabled).toBe(true);
  expect(f.broadcast).toHaveBeenCalledTimes(2);
});

it.each([0, 1000, 5000])("persists a busy-owner skip without cloning records or %s history entries", async historyCount => {
  const f = fixture(historyCount);
  let at = 1000000;
  const launch = vi.fn();
  const scheduler = createModuleOwnerScheduler({ store: f.store, template: () => ({}), supported: () => true,
    launch, job: () => undefined, submitted: () => false, ownerBusy: () => true, revoke: vi.fn(), revokeTask: vi.fn(), now: () => at });
  const task = scheduler.save("one", { ownerId: "owner", name: "task", prompt: "inspect", mode: "default", enabled: true,
    tools: [], schedule: { kind: "interval", minutes: 1, count: 2 } })[0];
  f.write.mockClear(); f.broadcast.mockClear();
  at = task.nextRunAt;
  const clone = vi.spyOn(globalThis, "structuredClone");
  try {
    await scheduler.tick();
    expect(clone.mock.calls).toHaveLength(2);
    for (const [input] of clone.mock.calls) {
      expect(Array.isArray(input)).toBe(true);
      expect(input).toHaveLength(1);
      expect(input[0].id).toBe(task.id);
    }
  } finally { clone.mockRestore(); }
  expect(launch).not.toHaveBeenCalled();
  expect(f.write).toHaveBeenCalledTimes(1);
  const [id, metadata] = f.write.mock.calls[0];
  expect(id).toBe("one");
  expect(metadata).not.toHaveProperty("records");
  expect(metadata).not.toHaveProperty("history");
  expect(metadata.tasks[0]).toMatchObject({ enabled: true, executedCount: 0, nextRunAt: at + 60000,
    lastRun: { status: "skipped", startedAt: at, error: expect.stringContaining("上一轮未结束") } });
  expect(f.store.getSchedulerState("one").tasks).toEqual(metadata.tasks);
  expect(f.value.history).toHaveLength(historyCount);
  expect(f.broadcast).toHaveBeenCalledOnce();
});
