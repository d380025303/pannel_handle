import { Fragment, useEffect, useState } from "react";
import { TaskRunHistory } from "./TaskRunHistory";
import { OwnerDialog } from "./OwnerDialog";
import type { ModuleOwnerPromptTemplate, ModuleOwnerRecord, ModuleOwnerTask, ModuleOwnerTaskInput } from "../../vite-env";

const blank = (ownerId: string): ModuleOwnerTaskInput => ({ ownerId, name: "", prompt: "", mode: "default", enabled: false, recordHistory: false, autoCreateWorkItem: true,
  tools: [], schedule: { kind: "cron", cron: "0 * * * *" } });
const labels: Record<string, string> = { creating: "创建中", running: "运行中", uncertain: "创建结果待确认", failed: "失败", completed: "已结束", stopped: "已停止", skipped: "已跳过" };

export function ModuleOwnerTasks({ templateId, ownerId, owners, supported, busy, run, onOpenSession }: {
  templateId: string; ownerId: string; owners: ModuleOwnerRecord[]; supported: boolean; busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>; onOpenSession: (id: string) => void;
}) {
  const [promptTemplates, setPromptTemplates] = useState<ModuleOwnerPromptTemplate[]>([]);
  const [tasks, setTasks] = useState<ModuleOwnerTask[]>([]);
  const [historyTask, setHistoryTask] = useState<ModuleOwnerTask | null>(null);
  const [draft, setDraft] = useState<ModuleOwnerTaskInput | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [copyTask, setCopyTask] = useState<ModuleOwnerTask | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [notice, setNotice] = useState("");
  const candidates = owners.filter(owner => owner.id !== ownerId);
  const selectedTargets = targets.filter(id => candidates.some(owner => owner.id === id));
  function closeCopy() { if (!busy) { setCopyTask(null); setCopyError(""); } }
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const ownerTasks = tasks.filter(task => task.ownerId === ownerId);
  function closeEditor() { if (!busy) { setDraft(null); setSaveError(""); } }
  useEffect(() => {
    let live = true;
    const load = () => { void window.moduleOwnerApi.listTasks(templateId).then(value => { if (live) setTasks(value); }).catch(err => { if (live) setError(String(err)); }); };
    const loadPrompts = () => { void window.moduleOwnerApi.listPromptTemplates().then(value => { if (live) setPromptTemplates(value); }).catch(err => { if (live) setError(String(err)); }); };
    loadPrompts();
    load(); const timer = window.setInterval(load, 2000);
    const unsubscribe = window.moduleOwnerApi.onChanged(event => { if (event.templateId === templateId) load(); if (!event.templateId || event.templateId === templateId) loadPrompts(); });
    return () => { live = false; clearInterval(timer); unsubscribe(); };
  }, [templateId]);
  function input(task: ModuleOwnerTask): ModuleOwnerTaskInput {
    return { id: task.id, ownerId: task.ownerId, name: task.name, prompt: task.prompt, ...(task.promptTemplateId ? { promptTemplateId: task.promptTemplateId } : {}), mode: task.mode, enabled: task.enabled, recordHistory: task.recordHistory === true, autoCreateWorkItem: task.autoCreateWorkItem !== false, tools: task.tools, schedule: task.schedule };
  }
  return <><div className="module-owners-dialog-body module-owners-task-list">
    <div className="module-owners-task-toolbar">
      <span className="module-owners-count">共 {ownerTasks.length} 个定时任务</span>
      <button type="button" disabled={busy} onClick={() => { setDraft(blank(ownerId)); setSaveError(""); setDeleting(null); }}>新增定时任务</button>
    </div>
    <p className="module-owners-task-hint">仅应用运行时执行，错过的周期不补跑；同一负责人上一轮未结束则跳过。执行需要开启 HTTP 服务。</p>
    {!supported && <p className="module-owners-task-hint">此模板不支持定时执行，请使用配置了项目目录的本机 Windows Codex 图形模板。</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="module-owners-error">{error}</p>}
    {!ownerTasks.length ? <p className="module-owners-empty">暂无定时任务，点击上方按钮添加。</p> : <div className="module-owners-task-scroll">
      <table className="module-owners-task-table" aria-label="定时任务列表">
        <colgroup><col className="module-owners-task-name-column" /><col className="module-owners-task-schedule-column" /><col className="module-owners-task-next-column" /><col className="module-owners-task-recent-column" /><col className="module-owners-task-actions-column" /></colgroup>
        <thead><tr><th scope="col">任务名称 / 状态</th><th scope="col">执行周期 / 次数</th><th scope="col">下次执行</th><th scope="col">最近执行</th><th scope="col">操作</th></tr></thead>
        <tbody>{ownerTasks.map(task => <Fragment key={task.id}>
          <tr>
            <td><strong className="module-owners-task-name">{task.name}</strong>{task.promptTemplateId && <span className="module-owners-task-meta">{promptTemplates.find(value => value.id === task.promptTemplateId)?.name || "引用模板"} · {task.prompt !== task.promptTemplateSnapshot ? "已独立修改" : promptTemplates.find(value => value.id === task.promptTemplateId)?.version !== task.promptTemplateVersion ? "模板有更新" : "已同步"}</span>}<span className="module-owners-task-badge" data-enabled={task.enabled}>{task.enabled ? "已启用" : "已停用"}</span></td>
            <td><span>{task.schedule.kind === "cron" ? `Cron：${task.schedule.cron}` : `每 ${task.schedule.minutes} 分钟，共 ${task.schedule.count} 次`}</span><span className="module-owners-task-meta">已执行 {task.executedCount} 次</span></td>
            <td><span className="module-owners-task-meta">{task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—"}</span></td>
            <td>{task.lastRun ? <>
              <span>{labels[task.lastRun.status] || task.lastRun.status}</span>
              <span className="module-owners-task-meta">{new Date(task.lastRun.startedAt).toLocaleString()}</span>
              {task.lastRun.error && <span className="module-owners-task-run-error">{task.lastRun.error}</span>}
              {task.lastRun.sessionId && <button type="button" className="module-owners-task-session" onClick={() => onOpenSession(task.lastRun!.sessionId!)}>打开会话</button>}
            </> : <span className="module-owners-task-meta">—</span>}</td>
            <td><div className="module-owners-task-actions">
              <button type="button" disabled={busy || !supported || !!task.lastRun && ["creating", "running", "uncertain"].includes(task.lastRun.status)} onClick={() => void run(async () => {
                setNotice("");
                setTasks(await window.moduleOwnerApi.runTask(templateId, { id: task.id }));
                setNotice(`已手动执行“${task.name}”。`);
              })}>手动执行</button>
              <button type="button" disabled={busy} onClick={() => { setDraft(input(task)); setSaveError(""); setDeleting(null); }}>编辑任务</button>
              <button type="button" disabled={busy || (!task.enabled && !supported)} onClick={() => void run(async () => { setTasks(await window.moduleOwnerApi.saveTask(templateId, { ...input(task), enabled: !task.enabled })); })}>{task.enabled ? "停用" : "启用"}</button>
              <button type="button" disabled={busy} onClick={() => { setCopyTask(task); setTargets([]); setCopyEnabled(false); setCopyError(""); setNotice(""); setDeleting(null); }}>复制到其它负责人</button>
              <button type="button" disabled={busy} onClick={() => setHistoryTask(task)}>历史记录</button>
              <button type="button" className="module-owners-danger" disabled={busy} onClick={() => setDeleting(task.id)}>删除任务</button>
            </div></td>
          </tr>
          {deleting === task.id && <tr className="module-owners-task-confirm-row"><td colSpan={5}><div className="module-owners-task-confirm">
            <span>确认删除任务“{task.name}”？</span>
            <button type="button" className="module-owners-danger" disabled={busy} onClick={() => void run(async () => { setTasks(await window.moduleOwnerApi.deleteTask(templateId, { id: task.id })); setDeleting(null); })}>确认删除任务</button>
            <button type="button" disabled={busy} onClick={() => setDeleting(null)}>取消删除</button>
          </div></td></tr>}
        </Fragment>)}</tbody>
      </table>
    </div>}
    </div>
    {copyTask && <OwnerDialog title="复制到其它负责人" busy={busy} onClose={closeCopy}>
      <form className="module-owners-copy-form" onSubmit={event => { event.preventDefault(); if (!selectedTargets.length || busy) return; void run(async () => {
        setCopyError("");
        try {
          setTasks(await window.moduleOwnerApi.copyTask(templateId, { taskId: copyTask.id, targetOwnerIds: selectedTargets, enabled: supported && copyEnabled }));
          setNotice(`已复制到 ${selectedTargets.length} 个负责人，新任务均已${supported && copyEnabled ? "启用" : "停用"}。`); setCopyTask(null);
        } catch (err) { setCopyError(err instanceof Error ? err.message : String(err)); }
      }); }}>
        <div className="module-owners-dialog-body">
          <p className="module-owners-copy-summary">源任务：{copyTask.name}</p>
          <p className="module-owners-task-hint">复制配置并创建新任务，默认停用，已有任务保留。提示词中的文字保持原样。</p>
          <label className="module-owners-check"><input type="checkbox" checked={supported && copyEnabled} disabled={busy || !supported} onChange={event => setCopyEnabled(event.target.checked)} />复制后自动启动</label>
          <p className="module-owners-task-hint">勾选后按周期自动执行，复制完成时不立即执行。{!supported && "此模板不支持定时执行，复制后只能保持停用。"}</p>
          {copyError && <p role="alert" className="module-owners-error">{copyError}</p>}
          {!candidates.length ? <p className="module-owners-empty">当前模板没有其它负责人。</p> : <fieldset disabled={busy} className="module-owners-copy-targets">
            <legend>目标负责人</legend>
            <label className="module-owners-check"><input type="checkbox" checked={selectedTargets.length === candidates.length} onChange={event => setTargets(event.target.checked ? candidates.map(owner => owner.id) : [])} />全选</label>
            {candidates.map(owner => <label className="module-owners-check" key={owner.id}><input type="checkbox" checked={selectedTargets.includes(owner.id)} onChange={event => setTargets(event.target.checked ? [...selectedTargets, owner.id] : selectedTargets.filter(id => id !== owner.id))} /><span>{owner.name}</span></label>)}
          </fieldset>}
        </div>
        <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={closeCopy}>取消</button><button type="submit" disabled={busy || !selectedTargets.length}>{busy ? "复制中…" : "复制配置"}</button></footer>
      </form>
    </OwnerDialog>}
    {historyTask && <TaskRunHistory templateId={templateId} task={historyTask} onClose={() => setHistoryTask(null)} />}
    {draft && <OwnerDialog title={draft.id ? "编辑定时任务" : "新增定时任务"} busy={busy} onClose={closeEditor}>
      <form className="module-owners-form module-owners-task-editor" onSubmit={event => { event.preventDefault(); void run(async () => {
        setSaveError("");
        try { setTasks(await window.moduleOwnerApi.saveTask(templateId, draft)); setDraft(null); }
        catch (err) { setSaveError(err instanceof Error ? err.message : String(err)); }
      }); }}>
      <div className="module-owners-dialog-body">
      {saveError && <p role="alert" className="module-owners-error">{saveError}</p>}
      <fieldset disabled={busy} className="module-owners-task-fields">
        <label className="module-owners-task-full">任务名称<input required maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="module-owners-task-full">提示词模板<select value={draft.promptTemplateId || ""} onChange={event => {
          const source = promptTemplates.find(value => value.id === event.target.value);
          if (source) setDraft({ ...draft, promptTemplateId: source.id, prompt: source.prompt });
          else { const next = { ...draft }; delete next.promptTemplateId; setDraft(next); }
        }}><option value="">不引用模板</option>{promptTemplates.map(source => <option key={source.id} value={source.id}>{source.name} · v{source.version}</option>)}</select></label>
        {draft.promptTemplateId && <p className="module-owners-task-full">可单独修改；模板发布时可选择是否覆盖。解除引用会保留当前文字。</p>}
        <label className="module-owners-task-full">提示词<textarea required rows={4} maxLength={100000} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>
        <label>会话模式<select value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as "default" | "plan" })}><option value="default">普通模式</option><option value="plan">Plan</option></select></label>
        <label>周期类型<select value={draft.schedule.kind} onChange={event => setDraft({ ...draft, schedule: event.target.value === "cron" ? { kind: "cron", cron: "0 * * * *" } : { kind: "interval", minutes: 30, count: 10 } })}><option value="cron">Cron</option><option value="interval">固定间隔＋次数</option></select></label>
        {draft.schedule.kind === "cron" ? <label className="module-owners-task-full">Cron（分钟 小时 日 月 星期，系统本地时区）<input required value={draft.schedule.cron} onChange={event => setDraft({ ...draft, schedule: { kind: "cron", cron: event.target.value } })} /></label> : <>
          <label>间隔（分钟，60 分钟为一小时）<input type="number" required min={1} max={525600} value={draft.schedule.minutes} onChange={event => { if (draft.schedule.kind === "interval") setDraft({ ...draft, schedule: { ...draft.schedule, minutes: Number(event.target.value) } }); }} /></label>
          <label>执行次数上限<input type="number" required min={1} max={1000000} value={draft.schedule.count} onChange={event => { if (draft.schedule.kind === "interval") setDraft({ ...draft, schedule: { ...draft.schedule, count: Number(event.target.value) } }); }} /></label>
        </>}
        <div className="module-owners-task-full module-owners-task-tools">
        <p>注入工具（update 仅可修改本负责人）</p>
        <div className="module-owners-task-tool-options">
        {(["list_module_owners", "update_module_owner"] as const).map(tool => <label className="module-owners-check" key={tool}><input type="checkbox" checked={draft.tools.includes(tool)} onChange={event => setDraft({ ...draft, tools: event.target.checked ? [...draft.tools, tool] : draft.tools.filter(value => value !== tool) })} /><span>{tool}</span></label>)}
        </div>
        </div>
        <div className="module-owners-task-full module-owners-task-options">
        <label className="module-owners-check"><input type="checkbox" checked={draft.autoCreateWorkItem !== false} onChange={event => setDraft({ ...draft, autoCreateWorkItem: event.target.checked })} />自动生成任务</label>
        <label className="module-owners-check"><input type="checkbox" checked={draft.recordHistory === true} onChange={event => setDraft({ ...draft, recordHistory: event.target.checked })} />记录到历史记录</label>
        <label className="module-owners-check"><input type="checkbox" checked={draft.enabled} disabled={!supported} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用任务</label>
        </div>
        <p className="module-owners-task-full module-owners-task-hint">关闭自动生成任务后仍按周期执行，最终回复不进入任务列表；历史记录由上方开关独立控制。</p>
      </fieldset>
      </div>
      <footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={closeEditor}>取消编辑</button><button type="submit" disabled={busy}>{busy ? "保存中…" : "保存任务"}</button></footer>
      </form>
    </OwnerDialog>}
  </>;
}
