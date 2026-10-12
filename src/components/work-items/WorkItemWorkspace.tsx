import { WorkItemQuickPrompts } from "./WorkItemQuickPrompts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../../styles/markdown-content.css";
import { WorkItemSummary } from "./WorkItemSummary";
import { WorkItemMenu } from "./WorkItemMenu";
import type { WorkItem, WorkItemAttempt, WorkItemPage, WorkItemStatus } from "../../vite-env";
import { OwnerDialog } from "../module-owners/OwnerDialog";
import "../module-owners/module-owners.css";
import "./work-items.css";

export const WORK_ITEM_STATUS: Record<WorkItemStatus, string> = { pending: "待执行", creating: "创建中", running: "执行中", uncertain: "待核对", completed: "已完成", failed: "失败", stopped: "中断", void: "已作废" };
const defaultStatuses = () => (Object.keys(WORK_ITEM_STATUS) as WorkItemStatus[]).filter(status => status !== "void");
const active = (status: WorkItemStatus) => ["creating", "running", "uncertain"].includes(status);
const time = (at?: number) => at ? new Date(at).toLocaleString() : "—";
type Dialog = { id: string; kind: "detail" | "execute" | "attempts" | "void" | "restore" | "resolve" };
const titles = { detail: "任务详情", execute: "执行任务", attempts: "执行记录", void: "作废任务", restore: "恢复任务", resolve: "核对执行结果" };

export function WorkItemWorkspace({ visible, onOpenSession }: { visible: boolean; onOpenSession: (id: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const submitting = useRef(false);
  const promptInitialized = useRef(false);
  const [prompt, setPrompt] = useState("");
  const [promptMode, setPromptMode] = useState<"preview" | "edit">("preview");
  const [data, setData] = useState<WorkItemPage>({ records: [], total: 0, templates: [], owners: [] });
  const [templateId, setTemplateId] = useState(""); const [ownerId, setOwnerId] = useState("");
  const [statuses, setStatuses] = useState<WorkItemStatus[]>(defaultStatuses); const [keyword, setKeyword] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [page, setPage] = useState(0); const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null); const [item, setItem] = useState<WorkItem | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof window.workItemApi.preview>> | null>(null);
  const [dialogLoading, setDialogLoading] = useState(false); const [dialogError, setDialogError] = useState("");
  const [busy, setBusy] = useState(false); const [reason, setReason] = useState("");
  const [attemptPage, setAttemptPage] = useState(0); const [attempts, setAttempts] = useState<Awaited<ReturnType<typeof window.workItemApi.listAttempts>> | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState(""); const [attempt, setAttempt] = useState<WorkItemAttempt | null>(null);

  useEffect(() => {
    if (!visible) { setDialog(null); return; }
    const changed = () => setReload(value => value + 1);
    const off = window.workItemApi.onChanged(changed);
    const offOwners = window.moduleOwnerApi.onChanged(changed);
    changed();
    return () => { off(); offOwners(); };
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    setLoading(true); setError("");
    void window.workItemApi.list({ ...(templateId ? { templateId } : {}), ...(ownerId ? { ownerId } : {}), statuses, ...(followUp ? { needsFollowUp: followUp === "true" } : {}), keyword, page })
      .then(value => { if (live) { setData(value); if (page > 0 && page * 20 >= value.total) setPage(Math.max(0, Math.ceil(value.total / 20) - 1)); } })
      .catch(err => { if (live) setError(String(err)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [visible, templateId, ownerId, statuses, followUp, keyword, page, reload]);
  useLayoutEffect(() => {
    if (!ref.current || !dialog) return;
    const background = ref.current;
    background.inert = true;
    background.setAttribute("aria-hidden", "true");
    return () => { background.inert = false; background.removeAttribute("aria-hidden"); };
  }, [dialog]);
  useEffect(() => {
    if (!dialog || !visible) return;
    let live = true;
    setDialogLoading(true);
    void (async () => {
      const value = await window.workItemApi.get({ id: dialog.id });
      if (live) setItem(value);
      if (dialog.kind === "execute" && !active(value.status) && value.status !== "void") {
        const body = await window.workItemApi.preview({ id: value.id, version: value.version });
        if (live) {
          setPreview(body);
          if (!promptInitialized.current) { setPrompt(value.output); promptInitialized.current = true; }
        }
      }
      if (dialog.kind === "attempts") {
        const value = await window.workItemApi.listAttempts({ id: dialog.id, page: attemptPage });
        if (live) setAttempts(value);
        if (selectedAttemptId) {
          const detail = await window.workItemApi.getAttempt({ id: dialog.id, attemptId: selectedAttemptId });
          if (live) setAttempt(detail);
        }
      }
    })().catch(err => { if (live) setDialogError(String(err)); }).finally(() => { if (live) setDialogLoading(false); });
    return () => { live = false; };
  }, [dialog, visible, reload, attemptPage, selectedAttemptId]);

  function open(id: string, kind: Dialog["kind"]) {
    promptInitialized.current = false; setPrompt(""); setPromptMode("preview");
    setItem(null); setPreview(null); setAttempts(null); setAttempt(null); setSelectedAttemptId(""); setAttemptPage(0);
    setDialogError(""); setReason(""); setDialog({ id, kind });
  }
  async function openSession(id: string) {
    try {
      const sessions = await window.terminalApi.listSessions();
      if (!sessions.some(session => session.id === id)) throw new Error("会话已关闭或不存在，执行记录仍保留。");
      setDialog(null); onOpenSession(id);
    } catch (err) { if (dialog) setDialogError(String(err)); else setError(String(err)); }
  }
  async function perform(operation: "execute" | "markCompleted" | "void" | "restore" | "resolveUncertain") {
    if (!item || submitting.current || (operation === "execute" && !prompt.trim())) return;
    submitting.current = true; setBusy(true); setDialogError("");
    try {
      await window.workItemApi[operation]({ id: item.id, version: item.version, ...(operation === "void" ? { reason } : {}), ...(operation === "execute" ? { prompt } : {}) });
      setDialog(null);
    } catch (err) { setDialogError(String(err)); }
    finally { submitting.current = false; setBusy(false); setReload(value => value + 1); }
  }
  async function toggleFollowUp(value: WorkItem | WorkItemPage["records"][number]) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true);
    if (dialog) setDialogError(""); else setError("");
    try {
      const updated = await window.workItemApi.setFollowUp({ id: value.id, version: value.version, needsFollowUp: !value.needsFollowUp });
      if (dialog?.id === updated.id) setItem(updated);
      setReload(value => value + 1);
    } catch (err) { if (dialog) setDialogError(String(err)); else setError(String(err)); }
    finally { submitting.current = false; setBusy(false); }
  }
  const followUpAction = (needed: boolean) => needed ? "标记为不需要后续处理" : "标记为需要后续处理";
  const filtered = Boolean(followUp || templateId || ownerId || keyword || statuses.length !== 7 || statuses.includes("void"));
  function resetFilters() { setFollowUp(""); setTemplateId(""); setOwnerId(""); setKeyword(""); setStatuses(defaultStatuses()); setPage(0); }
  if (!visible) return null;
  return <>
    <section ref={ref} className="module-owners-workspace work-items-workspace" aria-label="任务列表">
      <header className="work-items-toolbar">
        <div className="work-items-heading">
          <h2>任务列表</h2><span className="work-items-count">{data.total} 条</span>
          <button type="button" className="work-items-help" aria-label="任务生成与完成规则" title="定时任务成功且最终回复非空时自动生成；人工执行创建新会话，成功结束本轮自动记为已完成，也可手动标记完成。">?</button>
        </div>
        <div className="work-items-select-filters">
          <div className="work-items-search">
            <input type="search" aria-label="搜索任务" placeholder="搜索回复、任务、负责人、模板" value={keyword} maxLength={1000} onChange={event => { setKeyword(event.target.value); setPage(0); }} />
          </div>
          <label>模板<select value={templateId} onChange={event => { setTemplateId(event.target.value); setOwnerId(""); setPage(0); }}><option value="">全部模板</option>{data.templates.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
          <label>负责人<select value={ownerId} onChange={event => { setOwnerId(event.target.value); setPage(0); }}><option value="">全部负责人</option>{data.owners.filter(value => !templateId || value.templateId === templateId).map(value => <option key={`${value.templateId}:${value.id}`} value={value.id}>{value.name}</option>)}</select></label>
          <label>后续处理<select value={followUp} onChange={event => { setFollowUp(event.target.value); setPage(0); }}><option value="">全部</option><option value="true">需要</option><option value="false">不需要</option></select></label>
          <fieldset className="work-items-status-filter"><legend>状态</legend>{(Object.entries(WORK_ITEM_STATUS) as [WorkItemStatus, string][]).map(([id, name]) => <label key={id} className="work-items-status-option" data-selected={statuses.includes(id)}><input type="checkbox" checked={statuses.includes(id)} onChange={event => { setStatuses(values => event.target.checked ? [...values, id] : values.filter(value => value !== id)); setPage(0); }} /><span>{name}</span></label>)}</fieldset>
          <button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>{loading ? "刷新中…" : "刷新"}</button>
          {filtered && <button type="button" className="work-items-reset" onClick={resetFilters}>重置筛选</button>}
        </div>
      </header>
      {error && <p className="module-owners-error" role="alert">{error}</p>}
      {data.storageErrors?.map((value, index) => <p key={index} className="module-owners-error" role="alert">{value}</p>)}
      <div className="module-owners-card work-items-scroll" aria-busy={loading}>
        {!data.records.length ? <div className="work-items-empty">{loading ? <p role="status">正在查询任务…</p> : <><strong>{filtered ? "没有符合筛选条件的任务" : "暂无任务"}</strong><p>{filtered ? "尝试调整关键词或筛选条件。" : "定时任务成功并产生回复后，任务会显示在这里。"}</p>{filtered && <button type="button" onClick={resetFilters}>重置筛选</button>}</>}</div> : <table className="work-items-table" aria-label="任务列表"><thead><tr><th>来源</th><th>回复摘要</th><th>状态</th><th>后续处理</th><th>时间</th><th>操作</th></tr></thead><tbody>{data.records.map(value => <tr key={value.id}>
          <td><strong title={value.taskName}>{value.taskName}</strong><div className={`work-items-source-meta${value.unavailable ? " module-owners-error" : ""}`} title={[value.owner.name, value.template.title, value.unavailable].filter(Boolean).join(" · ")}>{value.owner.name} · {value.template.title}{value.unavailable && <> · <span>{value.unavailable}</span></>}</div></td>
          <td><WorkItemSummary id={value.id} version={value.version} name={value.taskName} summary={value.summary} disabled={Boolean(dialog)} resetKey={JSON.stringify([page, templateId, ownerId, followUp, keyword, statuses, reload])} /></td>
          <td><span className="work-items-status" data-status={value.status}>{WORK_ITEM_STATUS[value.status]}</span>{value.error && <div className="module-owners-error work-items-row-error" title={value.error}>{value.error}</div>}</td>
          <td>{value.needsFollowUp ? "需要" : "不需要"}</td>
          <td className="work-items-time"><div title={`创建：${time(value.createdAt)}`}>创建：{time(value.createdAt)}</div><div title={`最近执行：${time(value.lastStartedAt)}`}>最近：{time(value.lastStartedAt)}</div></td>
          <td><div className="work-items-actions">
            <button type="button" onClick={() => open(value.id, "detail")}>详情</button>
            <button type="button" className="work-items-execute" disabled={active(value.status) || value.status === "void" || Boolean(value.unavailable)} onClick={() => open(value.id, "execute")}>{value.latestAttemptId ? "再次执行" : "执行"}</button>
            <WorkItemMenu name={value.taskName} actions={[
              { label: "执行记录", run: () => open(value.id, "attempts") },
              ...(value.latestAttemptId && value.sessionId ? [{ label: "打开最近会话", run: () => void openSession(value.sessionId!) }] : []),
              ...(value.status === "uncertain" ? [{ label: "核对结果", run: () => open(value.id, "resolve") }] : []),
              { label: followUpAction(value.needsFollowUp), disabled: busy, run: () => void toggleFollowUp(value) },
              value.status === "void" ? { label: "恢复", run: () => open(value.id, "restore") }
                : { label: "作废", danger: true, disabled: active(value.status), run: () => open(value.id, "void") },
            ]} />
          </div></td>
        </tr>)}</tbody></table>}
      </div>
      <footer className="work-items-pagination work-items-list-pagination"><span>共 {data.total} 条 · 第 {page + 1} 页</span><button type="button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>上一页</button><button type="button" disabled={(page + 1) * 20 >= data.total || loading} onClick={() => setPage(value => value + 1)}>下一页</button></footer>
    </section>
    {dialog && <OwnerDialog title={titles[dialog.kind]} busy={busy} onClose={() => setDialog(null)} wide>
      <div className={`module-owners-dialog-body work-items-dialog-body${dialog.kind === "execute" ? " work-items-execute-body" : ""}`}>
        {dialogError && <div><p className="module-owners-error" role="alert">{dialogError}</p><button type="button" disabled={busy || dialogLoading} onClick={() => { setDialogError(""); setReload(value => value + 1); }}>重新查询</button></div>}
        {dialogLoading && <p role="status">正在加载…</p>}
        {item && <>
          {dialog.kind === "execute" ? <div className="work-items-execute-meta"><strong>{item.taskName}</strong><span>{item.owner.name} · {item.template.title}</span><span className="work-items-status" data-status={item.status}>{WORK_ITEM_STATUS[item.status]}</span><span>后续处理：{item.needsFollowUp ? "需要" : "不需要"}</span></div> : <><p>{item.taskName} · {item.owner.name} · {item.template.title} · {WORK_ITEM_STATUS[item.status]}</p><p>后续处理：{item.needsFollowUp ? "需要" : "不需要"}</p></>}
          {item.unavailable && <p className="module-owners-error">{item.unavailable}</p>}
          {dialog.kind === "detail" && <>
            <h3>原始最终回复</h3><pre className="work-items-content">{item.output}</pre>
            <h3>来源信息</h3><pre className="work-items-content">{JSON.stringify({ taskId: item.taskId, ownerId: item.ownerId, templateId: item.templateId, sourceRunId: item.sourceRunId,
              sessionId: item.sourceSessionId, threadId: item.sourceThreadId, turnId: item.sourceTurnId, template: item.template, owner: item.owner, tools: item.tools }, null, 2)}</pre>
            {item.voidedAt && <p>作废时间：{time(item.voidedAt)} · 原因：{item.voidReason || "未填写"}</p>}
          </>}
          {dialog.kind === "execute" && <>
            <p className="work-items-execute-hint">普通模式创建新会话，提示词修改仅用于本次执行。</p>
            {preview && <>
              <WorkItemQuickPrompts api={window.workItemApi} disabled={busy || dialogLoading} Dialog={OwnerDialog} onAppend={text => setPrompt(value => value ? `${value}\n\n${text}` : text)} />
              <section className="work-items-prompt" aria-label="实际提示词">
                <div className="work-items-prompt-toolbar"><strong>实际提示词</strong><div role="group" aria-label="提示词显示模式"><button type="button" aria-pressed={promptMode === "preview"} disabled={busy} onClick={() => setPromptMode("preview")}>预览</button><button type="button" aria-pressed={promptMode === "edit"} disabled={busy} onClick={() => setPromptMode("edit")}>编辑</button></div></div>
                {promptMode === "preview" ? <div className="work-items-prompt-preview remote-preview-markdown-content" tabIndex={0}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{prompt || "提示词为空，请切换到编辑填写。"}</ReactMarkdown></div>
                  : <textarea className="work-items-prompt-editor" aria-label="实际提示词" autoFocus value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} />}
              </section>
              <details className="work-items-execute-config" key={dialog.id}><summary>执行配置</summary><h3>当前模板配置</h3><pre className="work-items-content">{JSON.stringify(preview.configuration, null, 2)}</pre><p>负责人工具：{preview.body.tools?.map(tool => tool.name).join("、") || "无"}</p></details>
            </>}
          </>}
          {dialog.kind === "void" && <><p>作废后保留回复和执行记录，恢复后才能执行。</p><label>作废原因（可选）<textarea aria-label="作废原因" value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} /></label></>}
          {dialog.kind === "restore" && <p>恢复为待执行，保留原始回复及全部执行记录。</p>}
          {dialog.kind === "resolve" && <p>请先查看原会话，确认已结束或不存在。确认后标记为中断，允许再次执行。关联会话仍在运行或创建请求未结束时不能解除锁定。</p>}
          {dialog.kind === "attempts" && <>
            {!attempts?.records.length && !dialogLoading && <p>暂无执行记录。</p>}
            {attempts?.records.map(value => <button className="work-items-attempt-row" type="button" key={value.id} aria-pressed={selectedAttemptId === value.id} onClick={() => { setAttempt(null); setDialogError(""); setSelectedAttemptId(value.id); }}>{time(value.startedAt)} · {WORK_ITEM_STATUS[value.status]} · {value.sessionId || "未创建会话"}</button>)}
            <div className="work-items-pagination"><span>共 {attempts?.total || 0} 次</span><button type="button" disabled={attemptPage === 0 || dialogLoading} onClick={() => { setAttemptPage(value => value - 1); setSelectedAttemptId(""); setAttempt(null); }}>上一页</button><button type="button" disabled={(attemptPage + 1) * 20 >= (attempts?.total || 0) || dialogLoading} onClick={() => { setAttemptPage(value => value + 1); setSelectedAttemptId(""); setAttempt(null); }}>下一页</button></div>
            {attempt && <><p>结束时间：{time(attempt.endedAt)}</p>{attempt.error && <p className="module-owners-error">{attempt.error}</p>}{attempt.sessionId && <button type="button" onClick={() => void openSession(attempt.sessionId!)}>打开会话</button>}<h3>实际输入与配置</h3><pre className="work-items-content">{JSON.stringify({ input: attempt.input, configuration: attempt.configuration }, null, 2)}</pre><h3>本次最终回复</h3><pre className="work-items-content">{attempt.output || "无回复"}</pre></>}
          </>}
        </>}
      </div>
      <footer className="module-owners-dialog-footer work-items-dialog-footer"><button type="button" disabled={busy} onClick={() => setDialog(null)}>关闭</button>
        {dialog.kind === "execute" && item && <button type="button" disabled={busy || dialogLoading} onClick={() => void toggleFollowUp(item)}>{followUpAction(item.needsFollowUp)}</button>}
        {dialog.kind === "execute" && item && ["pending", "failed", "stopped"].includes(item.status) && <button type="button" disabled={busy || dialogLoading} onClick={() => void perform("markCompleted")}>标记完成</button>}
        {dialog.kind === "execute" && <button type="button" disabled={busy || dialogLoading || !item || !preview || !prompt.trim() || active(item.status) || item.status === "void" || Boolean(item.unavailable)} onClick={() => void perform("execute")}>{busy ? "创建中…" : "确认执行"}</button>}
        {dialog.kind === "void" && <button type="button" disabled={busy || dialogLoading || !item || active(item.status) || item.status === "void"} onClick={() => void perform("void")}>确认作废</button>}
        {dialog.kind === "restore" && <button type="button" disabled={busy || dialogLoading || item?.status !== "void"} onClick={() => void perform("restore")}>确认恢复</button>}
        {dialog.kind === "resolve" && <button type="button" disabled={busy || dialogLoading || item?.status !== "uncertain"} onClick={() => void perform("resolveUncertain")}>确认已结束，标记中断</button>}
      </footer>
    </OwnerDialog>}
  </>;
}
