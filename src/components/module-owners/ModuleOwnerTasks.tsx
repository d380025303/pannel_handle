import { useEffect, useState } from "react";
import { TaskRunHistory } from "./TaskRunHistory";
import { OwnerDialog } from "./OwnerDialog";
import type { ModuleOwnerTask, ModuleOwnerTaskInput } from "../../vite-env";

const blank = (ownerId: string): ModuleOwnerTaskInput => ({ ownerId, name: "", prompt: "", mode: "default", enabled: false, recordHistory: false,
  tools: ["list_module_owners", "update_module_owner"], schedule: { kind: "cron", cron: "0 * * * *" } });
const labels: Record<string, string> = { creating: "创建中", running: "运行中", uncertain: "创建结果待确认", failed: "失败", completed: "已结束", stopped: "已停止", skipped: "已跳过" };

export function ModuleOwnerTasks({ templateId, ownerId, supported, busy, run, onOpenSession }: {
  templateId: string; ownerId: string; supported: boolean; busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>; onOpenSession: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<ModuleOwnerTask[]>([]);
  const [historyTask, setHistoryTask] = useState<ModuleOwnerTask | null>(null);
  const [draft, setDraft] = useState<ModuleOwnerTaskInput | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const ownerTasks = tasks.filter(task => task.ownerId === ownerId);
  function closeEditor() { if (!busy) { setDraft(null); setSaveError(""); } }
  useEffect(() => {
    let live = true;
    const load = () => { void window.moduleOwnerApi.listTasks(templateId).then(value => { if (live) setTasks(value); }).catch(err => { if (live) setError(String(err)); }); };
    load(); const timer = window.setInterval(load, 2000);
    const unsubscribe = window.moduleOwnerApi.onChanged(event => { if (event.templateId === templateId) load(); });
    return () => { live = false; clearInterval(timer); unsubscribe(); };
  }, [templateId]);
  function input(task: ModuleOwnerTask): ModuleOwnerTaskInput {
    return { id: task.id, ownerId: task.ownerId, name: task.name, prompt: task.prompt, mode: task.mode, enabled: task.enabled, recordHistory: task.recordHistory === true, tools: task.tools, schedule: task.schedule };
  }
  return <><div className="module-owners-dialog-body module-owners-form">
    <p>仅应用运行时执行，错过的周期不补跑；同一负责人上一轮未结束则跳过。执行需要开启 HTTP 服务。</p>
    {!supported && <p>此模板不支持定时执行，请使用配置了项目目录的本机 Windows Codex 图形模板。</p>}
    {error && <p role="alert" className="module-owners-error">{error}</p>}
    <div className="module-owners-buttons"><button type="button" disabled={busy} onClick={() => { setDraft(blank(ownerId)); setSaveError(""); setDeleting(null); }}>新增定时任务</button></div>
    {!ownerTasks.length && <p className="module-owners-empty">暂无定时任务，点击上方按钮添加。</p>}
    {ownerTasks.map(task => <section className="module-owners-task" key={task.id}>
      <strong>{task.name} · {task.enabled ? "已启用" : "已停用"}</strong>
      <p>{task.schedule.kind === "cron" ? `Cron：${task.schedule.cron}` : `每 ${task.schedule.minutes} 分钟，共 ${task.schedule.count} 次`} · 已执行 {task.executedCount} 次</p>
      <p>下次：{task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—"}</p>
      {task.lastRun && <p role="status">最近：{labels[task.lastRun.status] || task.lastRun.status} · {new Date(task.lastRun.startedAt).toLocaleString()}{task.lastRun.error && ` · ${task.lastRun.error}`}
        {task.lastRun.sessionId && <button type="button" onClick={() => onOpenSession(task.lastRun!.sessionId!)}>打开会话</button>}</p>}
      <div className="module-owners-buttons">
        <button type="button" disabled={busy} onClick={() => { setDraft(input(task)); setSaveError(""); setDeleting(null); }}>编辑任务</button>
        <button type="button" disabled={busy || (!task.enabled && !supported)} onClick={() => void run(async () => { setTasks(await window.moduleOwnerApi.saveTask(templateId, { ...input(task), enabled: !task.enabled })); })}>{task.enabled ? "停用" : "启用"}</button>
        <button type="button" disabled={busy} onClick={() => setHistoryTask(task)}>历史记录</button>
        <button type="button" disabled={busy} onClick={() => setDeleting(task.id)}>删除任务</button>
        {deleting === task.id && <><span>确认删除此任务？</span><button type="button" disabled={busy} onClick={() => void run(async () => { setTasks(await window.moduleOwnerApi.deleteTask(templateId, { id: task.id })); setDeleting(null); })}>确认删除任务</button><button type="button" disabled={busy} onClick={() => setDeleting(null)}>取消删除</button></>}
      </div>
    </section>)}
    </div>
    {historyTask && <TaskRunHistory templateId={templateId} task={historyTask} onClose={() => setHistoryTask(null)} />}
    {draft && <OwnerDialog title={draft.id ? "编辑定时任务" : "新增定时任务"} busy={busy} onClose={closeEditor}>
      <form className="module-owners-form module-owners-task-editor" onSubmit={event => { event.preventDefault(); void run(async () => {
        setSaveError("");
        try { setTasks(await window.moduleOwnerApi.saveTask(templateId, draft)); setDraft(null); }
        catch (err) { setSaveError(err instanceof Error ? err.message : String(err)); }
      }); }}>
      <div className="module-owners-dialog-body">
      {saveError && <p role="alert" className="module-owners-error">{saveError}</p>}
      <fieldset disabled={busy} className="module-owners-form">
        <label>任务名称<input required maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>提示词<textarea required rows={5} maxLength={100000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
        <label>会话模式<select value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as "default" | "plan" })}><option value="default">普通模式</option><option value="plan">Plan</option></select></label>
        <label>周期类型<select value={draft.schedule.kind} onChange={event => setDraft({ ...draft, schedule: event.target.value === "cron" ? { kind: "cron", cron: "0 * * * *" } : { kind: "interval", minutes: 30, count: 10 } })}><option value="cron">Cron</option><option value="interval">固定间隔＋次数</option></select></label>
        {draft.schedule.kind === "cron" ? <label>Cron（分钟 小时 日 月 星期，系统本地时区）<input required value={draft.schedule.cron} onChange={event => setDraft({ ...draft, schedule: { kind: "cron", cron: event.target.value } })} /></label> : <>
          <label>间隔（分钟，60 分钟为一小时）<input type="number" required min={1} max={525600} value={draft.schedule.minutes} onChange={event => { if (draft.schedule.kind === "interval") setDraft({ ...draft, schedule: { ...draft.schedule, minutes: Number(event.target.value) } }); }} /></label>
          <label>执行次数上限<input type="number" required min={1} max={1000000} value={draft.schedule.count} onChange={event => { if (draft.schedule.kind === "interval") setDraft({ ...draft, schedule: { ...draft.schedule, count: Number(event.target.value) } }); }} /></label>
        </>}
        <p>注入工具（update 仅可修改本负责人）</p>
        {(["list_module_owners", "update_module_owner"] as const).map(tool => <label className="module-owners-check" key={tool}><input type="checkbox" checked={draft.tools.includes(tool)} onChange={event => setDraft({ ...draft, tools: event.target.checked ? [...draft.tools, tool] : draft.tools.filter(value => value !== tool) })} />{tool}</label>)}
        <label className="module-owners-check"><input type="checkbox" checked={draft.recordHistory === true} onChange={event => setDraft({ ...draft, recordHistory: event.target.checked })} />记录到历史记录</label>
        <label className="module-owners-check"><input type="checkbox" checked={draft.enabled} disabled={!supported} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用任务</label>
      </fieldset>
      </div>
      <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={closeEditor}>取消编辑</button><button type="submit" disabled={busy}>{busy ? "保存中…" : "保存任务"}</button></footer>
      </form>
    </OwnerDialog>}
  </>;
}
