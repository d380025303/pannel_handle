import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { createModuleOwnerScheduler } = createRequire(import.meta.url)("./module-owner-scheduler.cjs");
afterEach(() => vi.useRealTimers());
function fixture() {
  let at = 1000000;
  let state = { records: [{ id: "owner" }], tasks: [] };
  let run; let submitted = false;
  const launch = vi.fn(async () => { run = { status: "running", startedAt: at, sessionId: "session", error: "" }; submitted = true; return { result: { status: 201 } }; });
  const service = createModuleOwnerScheduler({
    store: { get: () => structuredClone(state), tasks: (_id, tasks) => { state.tasks = structuredClone(tasks); }, templateIds: () => ["one"] },
    template: () => ({}), supported: () => true, now: () => at,
    launch, job: () => run, submitted: () => submitted, ownerBusy: () => Boolean(run && ["running", "uncertain"].includes(run.status)), revoke: vi.fn(), revokeTask: vi.fn()
  });
  const input = { ownerId: "owner", name: "task", prompt: "inspect", mode: "default", enabled: true, tools: [], schedule: { kind: "interval", minutes: 1, count: 2 } };
  return { service, launch, input, setTime: value => { at = value; }, setRun: (value, sent = false) => { run = value; submitted = sent; }, getState: () => state };
}
it("recalculates on restart, stops stale run tracking, preserves counts, and resumes without catch-up", async () => {
  vi.useFakeTimers();
  const f = fixture(); f.service.save("one", f.input);
  Object.assign(f.getState().tasks[0], { executedCount: 1, nextRunAt: 1, lastRun: { status: "running", startedAt: 1 } });
  f.service.start();
  expect(f.service.list("one")[0]).toMatchObject({ executedCount: 1, nextRunAt: 1060000, lastRun: { status: "stopped" } });
  await f.service.tick(); expect(f.launch).not.toHaveBeenCalled();
  f.service.shutdown();
});
it("keeps uncertain launches locked and counts a late confirmed submission exactly once", async () => {
  const f = fixture(); const task = f.service.save("one", f.input)[0];
  f.launch.mockImplementationOnce(async () => { f.setRun({ status: "uncertain", startedAt: 1060000, error: "timeout" }); throw new Error("timeout"); });
  f.setTime(task.nextRunAt); await f.service.tick(); await Promise.resolve(); await Promise.resolve();
  expect(f.service.list("one")[0].executedCount).toBe(0);
  f.setTime(1120000); await f.service.tick(); expect(f.launch).toHaveBeenCalledTimes(1);
  f.setRun({ status: "running", startedAt: 1060000, sessionId: "session", error: "" }, true);
  await f.service.tick(); await f.service.tick();
  expect(f.service.list("one")[0].executedCount).toBe(1);
  const updated = f.service.save("one", { ...f.input, id: task.id, name: "renamed" })[0];
  expect(updated.executedCount).toBe(1);
  expect(updated.nextRunAt).toBe(1180000);
  f.setRun({ status: "completed", startedAt: 1060000, sessionId: "session", error: "" }, true);
  f.setTime(1180000); await f.service.tick(); await Promise.resolve(); await Promise.resolve();
  expect(f.service.list("one")[0]).toMatchObject({ executedCount: 2, enabled: false, nextRunAt: null });
});

it("starts a fresh count after re-enabling an exhausted task without recounting its previous run", async () => {
  const f = fixture(); const input = { ...f.input, schedule: { kind: "interval", minutes: 1, count: 1 } };
  const task = f.service.save("one", input)[0];
  f.setTime(task.nextRunAt); await f.service.tick(); await Promise.resolve(); await Promise.resolve();
  expect(f.service.list("one")[0]).toMatchObject({ executedCount: 1, enabled: false, nextRunAt: null });
  const previousRun = { status: "completed", startedAt: task.nextRunAt, sessionId: "session", error: "" };
  f.setRun(previousRun, true);
  const restarted = f.service.save("one", { ...input, id: task.id })[0];
  expect(restarted).toMatchObject({ executedCount: 0, enabled: true, nextRunAt: 1120000, countedRunAt: task.nextRunAt, lastRun: previousRun });
  await f.service.tick(); await f.service.tick();
  expect(f.service.list("one")[0]).toMatchObject({ executedCount: 0, enabled: true });
  f.setTime(restarted.nextRunAt); await f.service.tick(); await Promise.resolve(); await Promise.resolve();
  expect(f.launch).toHaveBeenCalledTimes(2);
  expect(f.service.list("one")[0]).toMatchObject({ executedCount: 1, enabled: false, nextRunAt: null });
});

it("preserves counts when editing or disabling and resets them on manual re-enable", async () => {
  const f = fixture(); const task = f.service.save("one", f.input)[0];
  f.setTime(task.nextRunAt); await f.service.tick(); await Promise.resolve(); await Promise.resolve();
  expect(f.service.save("one", { ...f.input, id: task.id, name: "renamed" })[0]).toMatchObject({ executedCount: 1, enabled: true });
  expect(f.service.save("one", { ...f.input, id: task.id, enabled: false })[0]).toMatchObject({ executedCount: 1, enabled: false });
  expect(f.service.save("one", { ...f.input, id: task.id, enabled: false, name: "edited while disabled" })[0].executedCount).toBe(1);
  expect(f.service.save("one", { ...f.input, id: task.id })[0]).toMatchObject({ executedCount: 0, enabled: true, nextRunAt: 1120000 });
  await f.service.tick();
  expect(f.service.list("one")[0].executedCount).toBe(0);
});

it("skips even a short sleep crossing a due time using suspend and resume signals", async () => {
  const f = fixture(); f.service.save("one", f.input);
  f.setTime(1059000); await f.service.tick();
  f.service.suspend(); f.setTime(1061000); await f.service.tick();
  expect(f.launch).not.toHaveBeenCalled();
  f.service.resume(); await f.service.tick();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.service.list("one")[0].nextRunAt).toBe(1121000);
});

it("copies latest configuration to distinct targets without carrying runtime state or replacing tasks", () => {
  const f = fixture();
  f.getState().records.push({ id: "second" }, { id: "third" });
  const source = f.service.save("one", { ...f.input, recordHistory: true, tools: ["update_module_owner"], mode: "plan" })[0];
  f.service.save("one", { ...f.input, ownerId: "second" });
  Object.assign(f.getState().tasks[0], { prompt: "最新提示词", executedCount: 1, countedRunAt: 123, lastRun: { status: "completed", sessionId: "session", startedAt: 123 } });
  const before = structuredClone(f.getState().tasks);
  const result = f.service.copy("one", { taskId: source.id, targetOwnerIds: ["second", "third", "second"] });
  expect(result.slice(0, 2)).toEqual(before);
  expect(new Set(result.map(task => task.id)).size).toBe(4);
  for (const [index, ownerId] of ["second", "third"].entries()) {
    expect(f.getState().tasks[index + 2]).toEqual({ id: expect.any(String), ownerId, name: source.name, prompt: "最新提示词", mode: "plan", enabled: false,
      recordHistory: true, tools: ["update_module_owner"], schedule: source.schedule, executedCount: 0, nextRunAt: null });
  }
});

it("rejects invalid copy batches without writing any partial copies", () => {
  const f = fixture(); f.getState().records.push({ id: "second" });
  const source = f.service.save("one", f.input)[0];
  const before = structuredClone(f.getState());
  for (const input of [
    { taskId: source.id, targetOwnerIds: [] },
    { taskId: source.id, targetOwnerIds: ["second", "missing"] },
    { taskId: source.id, targetOwnerIds: ["owner"] },
    { taskId: "missing", targetOwnerIds: ["second"] }
  ]) {
    expect(() => f.service.copy("one", input)).toThrow();
    expect(f.getState()).toEqual(before);
  }
  f.getState().records = [{ id: "second" }];
  expect(() => f.service.copy("one", { taskId: source.id, targetOwnerIds: ["second"] })).toThrow("源任务或负责人不存在");
  expect(f.getState().tasks).toHaveLength(1);
});

it("manually executes disabled tasks without consuming scheduled quota or enabling them", async () => {
  const f = fixture(); const task = f.service.save("one", { ...f.input, enabled: false })[0];
  await f.service.runTask("one", { id: task.id });
  await f.service.tick();
  expect(f.launch).toHaveBeenCalledWith("one", expect.objectContaining({ id: task.id, prompt: "inspect" }));
  expect(f.service.list("one")[0]).toMatchObject({ enabled: false, nextRunAt: null, executedCount: 0, lastRun: { status: "running" } });
  await expect(f.service.runTask("one", { id: task.id })).rejects.toThrow("上一轮未结束");
});
it("preserves an enabled task's next schedule and rejects concurrent manual dispatch", async () => {
  const f = fixture(); const task = f.service.save("one", f.input)[0];
  let resolve;
  f.launch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = f.service.runTask("one", { id: task.id });
  await expect(f.service.runTask("one", { id: task.id })).rejects.toThrow("上一轮未结束");
  f.setRun({ status: "running", startedAt: 1000000 }, true);
  await f.service.tick();
  resolve(); await pending;
  expect(f.service.list("one")[0]).toMatchObject({ enabled: true, nextRunAt: task.nextRunAt, executedCount: 0 });
});
it("does not count a manual uncertain run after late submission confirmation and releases failed dispatch locks", async () => {
  const f = fixture(); const task = f.service.save("one", f.input)[0];
  f.launch.mockImplementationOnce(async () => { f.setRun({ status: "uncertain", startedAt: 1000000 }); throw new Error("timeout"); });
  await expect(f.service.runTask("one", { id: task.id })).rejects.toThrow("timeout");
  f.setRun({ status: "completed", startedAt: 1000000 }, true);
  await f.service.tick();
  expect(f.service.list("one")[0].executedCount).toBe(0);
  f.setTime(1001000);
  await f.service.runTask("one", { id: task.id });
  expect(f.launch).toHaveBeenCalledTimes(2);
  await expect(f.service.runTask("one", { id: "missing" })).rejects.toThrow("不存在");
});
