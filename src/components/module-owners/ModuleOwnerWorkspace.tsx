import { useEffect, useRef, useState } from "react";
import { OwnerCell } from "./OwnerCell";
import { OwnerDialog } from "./OwnerDialog";
import type { ModuleOwnerHistory, ModuleOwnerRecord, ModuleOwnerSettings, ModuleOwnerState, ModuleOwnerTask, ModuleOwnerTemplate, SessionApiResult, SessionApiState } from "../../vite-env";
import "./module-owners.css";
import { PromptTemplates } from "./PromptTemplates";
import { ModuleOwnerTasks } from "./ModuleOwnerTasks";

const activeStatuses = ["creating", "running", "uncertain"];
const statusLabels: Record<string, string> = { creating: "正在创建分析会话", running: "分析进行中", uncertain: "创建结果待确认，请检查会话列表", completed: "分析已结束", failed: "分析失败", stopped: "分析已停止" };
const operationLabels: Record<string, string> = { initial: "初始状态", add: "新增", update: "修改", delete: "删除", restore: "回滚" };
const blank = { name: "", responsibilities: "", recentActivity: "", directories: "" };

function OwnerTable({ records }: { records: ModuleOwnerRecord[] }) {
  return <div className="module-owners-table-scroll"><table><thead><tr><th>负责模块名称</th><th>职责</th><th>近期行为</th><th>主要负责目录</th></tr></thead><tbody>
    {records.map(record => <tr key={record.id}><td><OwnerCell label="负责模块名称" text={record.name} /></td><td><OwnerCell label="职责" text={record.responsibilities} /></td><td><OwnerCell label="近期行为" text={record.recentActivity ?? ""} /></td><td><OwnerCell label="主要负责目录" text={record.directories.join("\n")} code /></td></tr>)}
  </tbody></table>{!records.length && <p className="module-owners-empty">此版本暂无负责人。</p>}</div>;
}

export function ModuleOwnerWorkspace({ visible, onOpenSession }: { visible: boolean; onOpenSession: (id: string) => void }) {
  const [dialog, setDialog] = useState<"edit" | "delete" | "ai" | "history" | "tasks" | null>(null);
  const [promptTemplatesOpen, setPromptTemplatesOpen] = useState(false);
  const [taskOwner, setTaskOwner] = useState<ModuleOwnerRecord | null>(null);
  const [deleting, setDeleting] = useState<ModuleOwnerRecord | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [templates, setTemplates] = useState<ModuleOwnerTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [state, setState] = useState<ModuleOwnerState | null>(null);
  const [tasks, setTasks] = useState<ModuleOwnerTask[] | null>(null);
  const [settings, setSettings] = useState<ModuleOwnerSettings>({ mode: "plan", prompt: "" });
  const [apiState, setApiState] = useState<SessionApiState | null>(null);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState<ModuleOwnerRecord | null>(null);
  const [history, setHistory] = useState<{ entry: ModuleOwnerHistory; revision: number } | null>(null);
  const [historyOwner, setHistoryOwner] = useState<ModuleOwnerRecord | null>(null);
  const [ownerHistory, setOwnerHistory] = useState<{ revision: number; history: ModuleOwnerHistory[] } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyReload, setHistoryReload] = useState(0);
  const [preview, setPreview] = useState<unknown>();
  const [result, setResult] = useState<SessionApiResult | null>(null);
  const [sentBody, setSentBody] = useState<unknown>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const currentId = useRef(templateId);
  currentId.current = templateId;
  const selected = templates.find(item => item.templateId === templateId);
  const generating = Boolean(state?.generation && activeStatuses.includes(state.generation.status));
  const taskCounts = new Map<string, { enabled: number; disabled: number }>();
  for (const task of tasks ?? []) {
    const counts = taskCounts.get(task.ownerId) ?? { enabled: 0, disabled: 0 };
    if (task.enabled) counts.enabled += 1;
    else counts.disabled += 1;
    taskCounts.set(task.ownerId, counts);
  }

  useEffect(() => {
    let live = true;
    setTasks(null);
    if (!visible || !templateId) return;
    const load = () => { void window.moduleOwnerApi.listTasks(templateId).then(value => { if (live) setTasks(value); }).catch(err => { if (live) setError(String(err)); }); };
    load();
    const timer = window.setInterval(load, 2000);
    const unsubscribe = window.moduleOwnerApi.onChanged(event => { if (event.templateId === templateId) load(); });
    return () => { live = false; window.clearInterval(timer); unsubscribe(); };
  }, [templateId, visible]);

  useEffect(() => {
    let live = true;
    void window.moduleOwnerApi.listTemplates().then(items => { if (live) { setTemplates(items); setTemplateId(items[0]?.templateId || ""); } }).catch(err => { if (live) setError(String(err)); });
    void window.sessionApi.get().then(value => { if (live) setApiState(value); }).catch(err => { if (live) setError(String(err)); });
    const unsubscribe = window.sessionApi.onChanged(value => { if (live) setApiState(value); });
    return () => { live = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    let live = true;
    setDialog(null); setHistoryOwner(null); setOwnerHistory(null); setDeleting(null); setConfirmRestore(false); setSentBody(undefined); setState(null); setHistory(null); setEditing(null); setDraft(blank); setResult(null); setPreview(undefined); setError("");
    if (!templateId) return;
    const load = (initial = false) => window.moduleOwnerApi.get(templateId).then(value => {
      if (!live) return;
      setState(value);
      if (initial) setSettings(value.settings);
    }).catch(err => { if (live) setError(String(err)); });
    void load(true);
    const unsubscribe = window.moduleOwnerApi.onChanged(event => { if (event.templateId === templateId) { void load(); setHistoryReload(value => value + 1); } });
    // Query lifecycle while visible; table writes are delivered by the change event.
    return () => { live = false; unsubscribe(); };
  }, [templateId]);

  useEffect(() => {
    if (!visible || !templateId) return;
    let live = true;
    const load = () => { void window.moduleOwnerApi.getGeneration(templateId).then(generation => { if (live) setState(value => value ? { ...value, generation } : value); }).catch(err => { if (live) setError(String(err)); }); };
    load();
    const timer = window.setInterval(load, 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [templateId, visible]);

  useEffect(() => {
    let live = true;
    if (dialog !== "ai" || !templateId || !state || !settings.prompt.trim()) { setPreview(undefined); return; }
    const timer = window.setTimeout(() => {
      void window.moduleOwnerApi.preview(templateId, settings).then(value => { if (live) setPreview(value); }).catch(err => { if (live) setError(String(err)); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [dialog, templateId, settings, state?.revision, apiState?.url, Boolean(state)]);

  useEffect(() => {
    if (!visible) { setPromptTemplatesOpen(false); setDialog(null); setHistoryOwner(null); setOwnerHistory(null); setEditing(null); setDeleting(null); setHistory(null); setConfirmRestore(false); setDraft(blank); }
  }, [visible]);

  function closeDialog() {
    if (lock.current) return;
    setDialog(null); setHistoryOwner(null); setOwnerHistory(null); setEditing(null); setDeleting(null); setHistory(null); setConfirmRestore(false); setDraft(blank); setError("");
  }
  function openDialog(value: "edit" | "delete" | "ai" | "history" | "tasks", owner: ModuleOwnerRecord | null = null) {
    setError(""); setDialog(value);
    if (value === "history") {
      setHistoryOwner(owner); setOwnerHistory(null); setHistoryError("");
      const entry = owner ? undefined : state?.history.at(-1);
      setHistory(entry && state ? { entry, revision: state.revision } : null); setConfirmRestore(false);
    }
  }

  useEffect(() => {
    if (!visible || dialog !== "history" || !historyOwner || !templateId) {
      setOwnerHistory(null); setHistoryLoading(false); setHistoryError("");
      return;
    }
    let live = true;
    setHistoryLoading(true); setHistoryError(""); setHistory(null); setConfirmRestore(false); setOwnerHistory(null);
    void window.moduleOwnerApi.listHistory(templateId, { ownerId: historyOwner.id }).then(value => {
      if (!live) return;
      setOwnerHistory(value);
      const entry = value.history.at(-1);
      setHistory(entry ? { entry, revision: value.revision } : null);
    }).catch(err => { if (live) setHistoryError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (live) setHistoryLoading(false); });
    return () => { live = false; };
  }, [visible, dialog, templateId, historyOwner, historyReload]);

  const displayedHistory = historyOwner ? ownerHistory?.history ?? [] : state?.history ?? [];
  const historyRevision = historyOwner ? ownerHistory?.revision ?? 0 : state?.revision ?? 0;

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function saveRecord() {
    const id = templateId;
    const fields = { name: draft.name, responsibilities: draft.responsibilities, recentActivity: draft.recentActivity, directories: draft.directories.split(/\r?\n/).map(value => value.trim()).filter(Boolean) };
    const value = await window.moduleOwnerApi.mutate(id, editing ? { operation: "update", id: editing.id, version: editing.version, ...fields } : { operation: "add", ...fields });
    if (currentId.current === id) { setState(value); setDraft(blank); setEditing(null); setDialog(null); }
  }
  return <main className="module-owners-workspace" hidden={!visible} inert={Boolean(dialog) || promptTemplatesOpen} aria-label="模块负责人">
    <div className="module-owners-toolbar">
      <strong>项目模块负责人</strong>
      <label>会话模板<select aria-label="会话模板" value={templateId} disabled={busy} onChange={event => setTemplateId(event.target.value)}>
        <option value="">请选择模板</option>{templates.map(item => <option key={item.templateId} value={item.templateId}>{item.title}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={() => void run(async () => { const items = await window.moduleOwnerApi.listTemplates(); setTemplates(items); if (!items.some(item => item.templateId === templateId)) setTemplateId(items[0]?.templateId || ""); })}>刷新模板</button>
      <div className="module-owners-toolbar-actions">
        <button type="button" disabled={busy} onClick={() => setPromptTemplatesOpen(true)}>提示词模板</button>
        <span className="module-owners-count">{state?.records.length ?? 0} 个负责人</span>
        <button type="button" disabled={busy || !state} onClick={() => { setEditing(null); setDraft(blank); openDialog("edit"); }}>新增负责人</button>
        <button type="button" disabled={busy || !state} onClick={() => openDialog("ai")}>AI 分析生成</button>
        <button type="button" disabled={busy || !state} onClick={() => openDialog("history")}>历史记录</button>
      </div>
    </div>
    {visible && promptTemplatesOpen && <PromptTemplates onClose={() => setPromptTemplatesOpen(false)} />}
    {selected && <p className="module-owners-path">项目目录：<code>{selected.cwd || "未配置"}</code></p>}
    {!dialog && error && <p className="module-owners-error" role="alert">{error}</p>}
    {!templates.length && <p>请先创建会话模板。</p>}
    {state && <>
      <section className="module-owners-card">
        <div className="module-owners-table-scroll"><table><colgroup><col className="module-owners-name-column" /><col /><col /><col className="module-owners-directory-column" /><col className="module-owners-task-count-column" /><col className="module-owners-action-column" /></colgroup><thead><tr><th>负责模块名称</th><th>职责</th><th>近期行为</th><th>主要负责目录</th><th>定时任务</th><th>操作</th></tr></thead><tbody>
          {state.records.map(record => <tr key={record.id}><td><OwnerCell label="负责模块名称" text={record.name} /></td><td><OwnerCell label="职责" text={record.responsibilities} /></td><td><OwnerCell label="近期行为" text={record.recentActivity ?? ""} /></td><td><OwnerCell label="主要负责目录" text={record.directories.join("\n")} code /></td><td>{tasks ? <>已启用 {taskCounts.get(record.id)?.enabled ?? 0}<br />已停用 {taskCounts.get(record.id)?.disabled ?? 0}</> : "—"}</td><td><div className="module-owners-row-actions">
            <button type="button" aria-label={`编辑 ${record.name}`} disabled={busy} onClick={() => { openDialog("edit"); setEditing(record); setDraft({ name: record.name, responsibilities: record.responsibilities, recentActivity: record.recentActivity ?? "", directories: record.directories.join("\n") }); }}>编辑</button>
            <button type="button" aria-label={`定时任务 ${record.name}`} disabled={busy} onClick={() => { setTaskOwner(record); openDialog("tasks"); }}>定时任务</button>
            <button type="button" className="module-owners-history-link" aria-label={`历史记录 ${record.name}`} disabled={busy} onClick={() => openDialog("history", record)}>历史记录</button>
            <button type="button" className="module-owners-danger" aria-label={`删除 ${record.name}`} disabled={busy} onClick={() => { setDeleting(record); openDialog("delete"); }}>删除</button>
          </div></td></tr>)}
        </tbody></table></div>
        {!state.records.length && <p className="module-owners-empty">暂无负责人，可手工新增或让 AI 分析生成。</p>}
      </section>
      {visible && dialog && <OwnerDialog title={dialog === "edit" ? (editing ? "编辑负责人" : "新增负责人") : dialog === "delete" ? "删除负责人" : dialog === "ai" ? "AI 分析生成" : dialog === "tasks" ? `${taskOwner?.name} · 定时任务` : historyOwner ? `${state.records.find(record => record.id === historyOwner.id)?.name ?? historyOwner.name} · 历史记录` : "历史记录"} busy={busy} onClose={closeDialog} wide={dialog === "history" || dialog === "tasks"}>
        {error && <p className="module-owners-error" role="alert">{error}</p>}
        {dialog === "tasks" && taskOwner && <ModuleOwnerTasks templateId={templateId} ownerId={taskOwner.id} owners={state.records} supported={Boolean(selected?.supported)} busy={busy} run={run} onOpenSession={onOpenSession} />}
        {dialog === "delete" && deleting && <><div className="module-owners-dialog-body"><p>确定删除模块负责人“{deleting.name}”？</p><p>删除后可通过历史恢复。</p></div><footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={closeDialog}>取消</button><button type="button" className="module-owners-danger" disabled={busy} onClick={() => void run(async () => {
          const value = await window.moduleOwnerApi.mutate(templateId, { operation: "delete", id: deleting.id, version: deleting.version }); setState(value); setDialog(null); setHistoryOwner(null); setOwnerHistory(null); setDeleting(null);
        })}>{busy ? "删除中…" : "确认删除"}</button></footer></>}
        {dialog === "edit" && <form className="module-owners-form" onSubmit={event => { event.preventDefault(); void run(saveRecord); }}>
          <div className="module-owners-dialog-body">
          <label>负责模块名称<input required maxLength={200} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>职责<textarea required rows={3} maxLength={20000} value={draft.responsibilities} disabled={busy} onChange={event => setDraft({ ...draft, responsibilities: event.target.value })} /></label>
          <label>近期行为<textarea rows={3} maxLength={20000} value={draft.recentActivity} disabled={busy} onChange={event => setDraft({ ...draft, recentActivity: event.target.value })} /></label>
          <label>模块主要负责目录列表（每行一个，相对项目目录）<textarea required rows={3} value={draft.directories} disabled={busy} onChange={event => setDraft({ ...draft, directories: event.target.value })} /></label>
          </div><footer className="module-owners-dialog-footer"><button type="button" disabled={busy} onClick={closeDialog}>取消</button><button type="submit" disabled={busy || !draft.name.trim() || !draft.responsibilities.trim() || !draft.directories.trim()}>保存负责人</button>
          </footer>
        </form>}
        {dialog === "history" && <div className="module-owners-dialog-body module-owners-history-layout">
        <div className="module-owners-history">{[...displayedHistory].reverse().map(entry => <button type="button" key={entry.id} aria-pressed={history?.entry.id === entry.id} onClick={() => { setHistory({ entry, revision: historyRevision }); setConfirmRestore(false); }}>
          {new Date(entry.at).toLocaleString()} · {operationLabels[entry.operation] || entry.operation} · {entry.source === "ai" ? "AI" : entry.source === "system" ? "系统" : "手工"} · {entry.kind === "owner" ? (entry.after || entry.before)?.name : "旧版整表快照"}
        </button>)}</div>
        {historyLoading ? <p role="status">正在查询负责人历史记录…</p> : historyError ? <div><p className="module-owners-error" role="alert">{historyError}</p><button type="button" onClick={() => setHistoryReload(value => value + 1)}>重试查询</button></div> : history ? <div className="module-owners-history-preview"><p>历史版本 {history.entry.revision}{history.entry.sessionId && <> · 会话 {history.entry.sessionId}</>}</p>
          {history.entry.kind === "owner" ? <>
            <h3>操作前</h3>{history.entry.before ? <OwnerTable records={[history.entry.before]} /> : <p>该负责人尚不存在。</p>}
            <h3>操作后</h3>{history.entry.after ? <OwnerTable records={[history.entry.after]} /> : <p>该负责人已不存在。</p>}
          </> : <><p>旧版整表快照，仅供查看。</p><OwnerTable records={history.entry.records} /></>}
          {history.entry.kind === "owner" && (!confirmRestore ? <button type="button" disabled={busy || generating} onClick={() => setConfirmRestore(true)}>恢复此负责人</button> : <div className="module-owners-restore-confirm"><p>仅恢复此负责人（删除记录恢复删除前内容），其他负责人不变。当前内容会保留在历史中。</p><div className="module-owners-buttons"><button type="button" disabled={busy} onClick={() => setConfirmRestore(false)}>取消恢复</button><button type="button" disabled={busy || generating} onClick={() => void run(async () => { setState(await window.moduleOwnerApi.restore(templateId, { historyId: history.entry.id, revision: history.revision })); setHistory(null); setConfirmRestore(false); if (historyOwner) setHistoryReload(value => value + 1); })}>确认恢复</button></div></div>)}
          {generating && history.entry.kind === "owner" && <p>生成任务运行中，请先结束会话任务再回滚。</p>}
        </div> : <p className="module-owners-empty">{displayedHistory.length ? "选择一条历史记录查看负责人列表。" : historyOwner ? "此负责人暂无历史记录。" : "暂无历史记录。"}</p>}
        </div>}
        {dialog === "ai" && <div className="module-owners-dialog-body">
        {apiState?.error && <p className="module-owners-error" role="alert">{apiState.error}</p>}
      <span>{apiState?.running ? "HTTP 服务已开启" : "HTTP 服务未开启"}</span>
      {!apiState?.running && <button type="button" disabled={busy} onClick={() => void run(async () => { const value = await window.sessionApi.configure({ enabled: true }); setApiState(value); if (!value.running) throw new Error(value.error || "HTTP 服务未启动"); })}>开启 HTTP 服务</button>}
        <p>创建一个分析会话，由 AI 结合现有负责人决定增删改；已写入的修改会立即保存并保留历史。</p>
        {!selected?.supported && <p>生成仅支持配置了项目目录的本机 Windows Codex 图形模板，此模板仍可手工维护负责人表。</p>}
        <div className="module-owners-form">
          <label>会话模式<select value={settings.mode} disabled={busy} onChange={event => setSettings({ ...settings, mode: event.target.value as ModuleOwnerSettings["mode"] })}><option value="plan">Plan</option><option value="default">正常模式</option></select></label>
          <label>生成提示词<textarea rows={9} maxLength={100000} value={settings.prompt} disabled={busy} onChange={event => setSettings({ ...settings, prompt: event.target.value })} /></label>
          <div className="module-owners-buttons">
            <button type="button" disabled={busy || !settings.prompt.trim()} onClick={() => void run(async () => { setState(await window.moduleOwnerApi.configure(templateId, settings)); })}>保存生成配置</button>
            <button type="button" disabled={busy || generating || !selected?.supported || !apiState?.running || !settings.prompt.trim()} onClick={() => void run(async () => {
              const body = await window.moduleOwnerApi.preview(templateId, settings); setSentBody(body); setResult(null);
              const value = await window.moduleOwnerApi.generate(templateId, settings); setState(value.state); setResult(value.result); setSentBody(value.request ?? body);
            })}>{busy ? "处理中…" : "分析并生成负责人"}</button>
          </div>
        </div>
        {state.generation && <p role="status">{statusLabels[state.generation.status] || state.generation.status}{state.generation.error && `：${state.generation.error}`}
          {state.generation.sessionId && <button type="button" onClick={() => onOpenSession(state.generation!.sessionId!)}>打开分析会话</button>}
        </p>}
        <details><summary>内置接口与工具参数（只读，凭据已脱敏）</summary><code>POST {apiState?.url}/api/v1/session-instances</code><pre>{preview ? JSON.stringify(preview, null, 2) : "填写提示词后显示完整请求。"}</pre></details>
        {result && <div><p>{result.method} {result.url} · HTTP {result.status} · {result.elapsedMs} ms</p><details><summary>已发送请求（凭据脱敏）</summary><pre>{JSON.stringify(sentBody, null, 2)}</pre></details><pre>{JSON.stringify(result.body, null, 2)}</pre></div>}
        </div>}
      </OwnerDialog>}
    </>}
  </main>;
}
