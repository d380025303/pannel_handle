const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { taskSchema, nextRun } = require("./task-schedule.cjs");
const active = job => job && ["creating", "running", "uncertain"].includes(job.status);

function createModuleOwnerScheduler({ store, template, supported, launch, job, submitted, revoke, revokeTask, ownerBusy, taskUnprocessed = () => false, now = () => Date.now() }) {
  let timer; let ticking = false; let stopped = false; let suspended = false; let lastTick = now();
  const pending = new Set();
  const manualPending = new Set();
  function visibleRun(task, run = job(task.id)) {
    const saved = task.lastRun;
    if (saved && run && saved.startedAt >= run.startedAt && ((saved.status === "stopped" && !task.enabled) || saved.status === "skipped" || (saved.status === "failed" && saved.error?.startsWith("未处理任务检查失败：")))) return saved;
    return run || saved;
  }
  function list(id) {
    template(id);
    return (store.getSchedulerState(id).tasks || []).map(task => ({ ...task, lastRun: visibleRun(task) }));
  }
  function write(id, tasks) { store.tasks(id, tasks); return list(id); }
  function save(id, input) {
    const parsed = taskSchema.parse(input);
    if (!store.getSchedulerState(id).records.some(record => record.id === parsed.ownerId)) throw new Error("负责人不存在。");
    const tasks = list(id); const old = tasks.find(task => task.id === parsed.id);
    if (parsed.id && (!old || old.ownerId !== parsed.ownerId)) throw new Error("任务不存在或不属于此负责人。");
    if (parsed.enabled && !supported(template(id))) throw new Error("仅支持本机 Windows Codex 图形模板且须配置项目目录。");
    const next = nextRun(parsed.schedule, now());
    const reenabled = old && !old.enabled && parsed.enabled;
    const task = { ...old, ...parsed, id: old?.id || randomUUID(), executedCount: reenabled ? 0 : old?.executedCount || 0 };
    if (parsed.promptTemplateId) {
      const source = store.promptTemplates().find(value => value.id === parsed.promptTemplateId);
      if (!source) throw new Error("提示词模板不存在，请刷新后重试。");
      if (old?.promptTemplateId !== source.id) {
        task.promptTemplateVersion = source.version; task.promptTemplateSnapshot = source.prompt;
      }
    } else {
      delete task.promptTemplateId; delete task.promptTemplateVersion; delete task.promptTemplateSnapshot;
    }
    if (task.schedule.kind === "interval" && task.executedCount >= task.schedule.count) task.enabled = false;
    const changed = !old || old.enabled !== task.enabled || JSON.stringify(old.schedule) !== JSON.stringify(task.schedule);
    task.nextRunAt = task.enabled ? (changed ? next : old.nextRunAt) : null;
    if (old) tasks[tasks.findIndex(value => value.id === old.id)] = task; else tasks.push(task);
    return write(id, tasks);
  }
  function copy(id, input) {
    const parsed = z.object({ taskId: z.string().min(1), targetOwnerIds: z.array(z.string().min(1)).min(1) }).strict().parse(input);
    template(id);
    const state = store.getSchedulerState(id);
    const tasks = state.tasks || [];
    const source = tasks.find(task => task.id === parsed.taskId);
    if (!source || !state.records.some(record => record.id === source.ownerId)) throw new Error("源任务或负责人不存在，请刷新后重试。");
    const targets = [...new Set(parsed.targetOwnerIds)];
    if (targets.includes(source.ownerId)) throw new Error("不能复制到源负责人。");
    if (targets.some(ownerId => !state.records.some(record => record.id === ownerId))) throw new Error("目标负责人不存在，请刷新后重试。");
    const copies = targets.map(ownerId => ({
      id: randomUUID(), ownerId, name: source.name, prompt: source.prompt, mode: source.mode,
      ...(source.promptTemplateId ? { promptTemplateId: source.promptTemplateId, promptTemplateVersion: source.promptTemplateVersion, promptTemplateSnapshot: source.promptTemplateSnapshot } : {}),
      enabled: false, recordHistory: source.recordHistory === true,
      tools: structuredClone(source.tools), schedule: structuredClone(source.schedule), executedCount: 0, nextRunAt: null
    }));
    return write(id, [...tasks, ...copies]);
  }
  function remove(id, input) {
    const tasks = list(id); const task = tasks.find(value => value.id === input?.id);
    if (!task) throw new Error("任务不存在。");
    revokeTask(task.id);
    return write(id, tasks.filter(value => value.id !== task.id));
  }
  async function runTask(id, input) {
    const parsed = z.object({ id: z.string().min(1) }).strict().parse(input);
    const task = list(id).find(value => value.id === parsed.id);
    if (!task || !store.getSchedulerState(id).records.some(record => record.id === task.ownerId)) throw new Error("任务或负责人不存在，请刷新后重试。");
    if (!supported(template(id))) throw new Error("仅支持本机 Windows Codex 图形模板且须配置项目目录。");
    if (stopped || suspended) throw new Error("调度服务当前不可执行。");
    const key = `${id}:${task.ownerId}`;
    if (pending.has(key) || ownerBusy(id, task.ownerId)) throw new Error("此负责人上一轮未结束，请等待任务结束。");
    pending.add(key); manualPending.add(task.id);
    const previous = job(task.id);
    try {
      const response = await launch(id, { ...task, trigger: "manual" });
      if (response?.result && response.result.status !== 201) throw new Error(response.result.body?.error?.message || "创建会话失败，请检查最近执行状态。");
    } finally {
      try {
        const run = job(task.id);
        if (run && run.startedAt !== previous?.startedAt) {
          const tasks = store.getSchedulerState(id).tasks || [];
          store.tasks(id, tasks.map(value => value.id === task.id ? { ...value, lastRun: run, countedRunAt: run.startedAt } : value));
        }
      } finally { pending.delete(key); manualPending.delete(task.id); }
    }
    return list(id);
  }
  function reconcile(id) {
    const state = store.getSchedulerState(id); let changed = false;
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
        const saved = store.getSchedulerState(id).tasks || [];
        let lifecycleChanged = false;
        const synced = saved.map(task => {
          const run = job(task.id);
          if (!run) return task;
          const shown = visibleRun(task, run);
          const counted = !manualPending.has(task.id) && submitted(task.id) && task.countedRunAt !== run.startedAt;
          if (!counted && JSON.stringify(task.lastRun) === JSON.stringify(shown)) return task;
          lifecycleChanged = true;
          const executedCount = task.executedCount + (counted ? 1 : 0);
          const exhausted = task.schedule.kind === "interval" && executedCount >= task.schedule.count;
          return { ...task, lastRun: shown, executedCount, ...(counted ? { countedRunAt: run.startedAt } : {}), ...(exhausted ? { enabled: false, nextRunAt: null } : {}) };
        });
        if (lifecycleChanged) store.tasks(id, synced);
        let value;
        try { value = template(id); } catch { value = null; }
        for (const task of store.getSchedulerState(id).tasks || []) {
          if (!task.enabled) continue;
          const update = patch => {
            if (stopped) return;
            const current = store.getSchedulerState(id).tasks || [];
            if (current.some(t => t.id === task.id)) store.tasks(id, current.map(t => t.id === task.id ? { ...t, ...patch } : t));
          };
          if (!value || !supported(value)) { revoke(task.ownerId); update({ enabled: false, nextRunAt: null, lastRun: { status: "stopped", error: "模板不存在或不支持。", startedAt: at } }); continue; }
          if (!task.nextRunAt || resumed) { update({ nextRunAt: nextRun(task.schedule, at) }); continue; }
          if (task.nextRunAt > at) continue;
          update({ nextRunAt: nextRun(task.schedule, at) });
          try {
            if (taskUnprocessed(id, task.id)) {
              update({ lastRun: { status: "skipped", error: "此定时任务仍有未处理任务，已跳过本周期。", startedAt: at } }); continue;
            }
          } catch (error) {
            update({ lastRun: { status: "failed", error: `未处理任务检查失败：${error.message}`, startedAt: at } }); continue;
          }
          const key = `${id}:${task.ownerId}`;
          if (pending.has(key) || ownerBusy(id, task.ownerId)) {
            update({ lastRun: { status: "skipped", error: "上一轮未结束，已跳过本周期。", startedAt: at } }); continue;
          }
          pending.add(key);
          // Dispatch independently so one slow HTTP launch cannot delay other owners.
          void launch(id, { ...task, trigger: "scheduled" }).then(() => {
            if (stopped) return;
            const run = job(task.id);
            const current = (store.getSchedulerState(id).tasks || []).find(t => t.id === task.id);
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
      const tasks = store.getSchedulerState(id).tasks || [];
      if (tasks.length) store.tasks(id, tasks.map(task => ({ ...task, nextRunAt: task.enabled ? nextRun(task.schedule, now()) : null,
        lastRun: active(task.lastRun) ? { ...task.lastRun, status: "stopped", error: "应用重启，上一轮状态不再跟踪。" } : task.lastRun })));
    }
    timer = setInterval(() => { void tick().catch(error => console.error("Module owner scheduler failed:", error.message)); }, 1000);
    timer.unref?.();
  }
  return { list, save, copy, remove, runTask, reconcile, tick, start, suspend: () => { suspended = true; }, resume: () => { suspended = false; lastTick = -Infinity; }, shutdown: () => { stopped = true; clearInterval(timer); timer = null; } };
}
module.exports = { createModuleOwnerScheduler };
