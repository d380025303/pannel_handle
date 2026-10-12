const { randomUUID } = require("node:crypto");
const { taskSchema, nextRun } = require("./task-schedule.cjs");
const active = job => job && ["creating", "running", "uncertain"].includes(job.status);

function createModuleOwnerScheduler({ store, template, supported, launch, job, submitted, revoke, revokeTask, ownerBusy, now = () => Date.now() }) {
  let timer; let ticking = false; let stopped = false; let suspended = false; let lastTick = now();
  const pending = new Set();
  function visibleRun(task, run = job(task.id)) {
    const saved = task.lastRun;
    if (saved && run && saved.startedAt >= run.startedAt && ((saved.status === "stopped" && !task.enabled) || (saved.status === "skipped" && active(run)))) return saved;
    return run || saved;
  }
  function list(id) {
    template(id);
    return (store.get(id).tasks || []).map(task => ({ ...task, lastRun: visibleRun(task) }));
  }
  function write(id, tasks) { store.tasks(id, tasks); return list(id); }
  function save(id, input) {
    const parsed = taskSchema.parse(input);
    if (!store.get(id).records.some(record => record.id === parsed.ownerId)) throw new Error("负责人不存在。");
    const tasks = list(id); const old = tasks.find(task => task.id === parsed.id);
    if (parsed.id && (!old || old.ownerId !== parsed.ownerId)) throw new Error("任务不存在或不属于此负责人。");
    if (parsed.enabled && !supported(template(id))) throw new Error("仅支持本机 Windows Codex 图形模板且须配置项目目录。");
    const next = nextRun(parsed.schedule, now());
    const task = { ...old, ...parsed, id: old?.id || randomUUID(), executedCount: old?.executedCount || 0 };
    if (task.schedule.kind === "interval" && task.executedCount >= task.schedule.count) task.enabled = false;
    const changed = !old || old.enabled !== task.enabled || JSON.stringify(old.schedule) !== JSON.stringify(task.schedule);
    task.nextRunAt = task.enabled ? (changed ? next : old.nextRunAt) : null;
    if (old) tasks[tasks.findIndex(value => value.id === old.id)] = task; else tasks.push(task);
    return write(id, tasks);
  }
  function remove(id, input) {
    const tasks = list(id); const task = tasks.find(value => value.id === input?.id);
    if (!task) throw new Error("任务不存在。");
    revokeTask(task.id);
    return write(id, tasks.filter(value => value.id !== task.id));
  }
  function reconcile(id) {
    const state = store.get(id); let changed = false;
    const tasks = (state.tasks || []).map(task => {
      if (state.records.some(record => record.id === task.ownerId)) return task;
      revoke(task.ownerId);
      if (!task.enabled && task.nextRunAt === null) return task;
      changed = true; return { ...task, enabled: false, nextRunAt: null, lastRun: { status: "stopped", error: "负责人已删除。", startedAt: now() } };
    });
    if (changed) store.tasks(id, tasks);
  }
  async function tick() {
    if (ticking || stopped || suspended) return;
    ticking = true;
    const at = now(); const resumed = at - lastTick > 60000; lastTick = at;
    try {
      for (const id of store.templateIds()) {
        reconcile(id);
        const saved = store.get(id).tasks || [];
        let lifecycleChanged = false;
        const synced = saved.map(task => {
          const run = job(task.id);
          if (!run) return task;
          const shown = visibleRun(task, run);
          const counted = submitted(task.id) && task.countedRunAt !== run.startedAt;
          if (!counted && JSON.stringify(task.lastRun) === JSON.stringify(shown)) return task;
          lifecycleChanged = true;
          const executedCount = task.executedCount + (counted ? 1 : 0);
          const exhausted = task.schedule.kind === "interval" && executedCount >= task.schedule.count;
          return { ...task, lastRun: shown, executedCount, ...(counted ? { countedRunAt: run.startedAt } : {}), ...(exhausted ? { enabled: false, nextRunAt: null } : {}) };
        });
        if (lifecycleChanged) store.tasks(id, synced);
        let value;
        try { value = template(id); } catch { value = null; }
        for (const task of store.get(id).tasks || []) {
          if (!task.enabled) continue;
          const update = patch => {
            if (stopped) return;
            const current = store.get(id).tasks || [];
            if (current.some(t => t.id === task.id)) store.tasks(id, current.map(t => t.id === task.id ? { ...t, ...patch } : t));
          };
          if (!value || !supported(value)) { revoke(task.ownerId); update({ enabled: false, nextRunAt: null, lastRun: { status: "stopped", error: "模板不存在或不支持。", startedAt: at } }); continue; }
          if (!task.nextRunAt || resumed) { update({ nextRunAt: nextRun(task.schedule, at) }); continue; }
          if (task.nextRunAt > at) continue;
          update({ nextRunAt: nextRun(task.schedule, at) });
          const key = `${id}:${task.ownerId}`;
          if (pending.has(key) || ownerBusy(id, task.ownerId)) {
            update({ lastRun: { status: "skipped", error: "上一轮未结束，已跳过本周期。", startedAt: at } }); continue;
          }
          pending.add(key);
          // Dispatch independently so one slow HTTP launch cannot delay other owners.
          void launch(id, task).then(() => {
            if (stopped) return;
            const run = job(task.id);
            const current = (store.get(id).tasks || []).find(t => t.id === task.id);
            if (!current) return;
            const counted = submitted(task.id) && current.countedRunAt !== run?.startedAt;
            const count = current.executedCount + (counted ? 1 : 0);
            const exhausted = current.schedule.kind === "interval" && count >= current.schedule.count;
            update({ executedCount: count, lastRun: run, ...(counted ? { countedRunAt: run.startedAt } : {}), ...(exhausted ? { enabled: false, nextRunAt: null } : {}) });
          }).catch(error => update({ lastRun: job(task.id) || { status: "failed", error: error.message, startedAt: at } }))
            .finally(() => pending.delete(key));
        }
      }
    } finally { ticking = false; }
  }
  function start() {
    if (timer) return;
    stopped = false; lastTick = now();
    for (const id of store.templateIds()) {
      const tasks = store.get(id).tasks || [];
      if (tasks.length) store.tasks(id, tasks.map(task => ({ ...task, nextRunAt: task.enabled ? nextRun(task.schedule, now()) : null,
        lastRun: active(task.lastRun) ? { ...task.lastRun, status: "stopped", error: "应用重启，上一轮状态不再跟踪。" } : task.lastRun })));
    }
    timer = setInterval(() => { void tick().catch(error => console.error("Module owner scheduler failed:", error.message)); }, 1000);
    timer.unref?.();
  }
  return { list, save, remove, reconcile, tick, start, suspend: () => { suspended = true; }, resume: () => { suspended = false; lastTick = -Infinity; }, shutdown: () => { stopped = true; clearInterval(timer); timer = null; } };
}
module.exports = { createModuleOwnerScheduler };
