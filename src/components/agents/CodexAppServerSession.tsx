import { useEffect, useRef, useState } from "react";
import { ArrowUp, Clock3, History, LoaderCircle, Paperclip, Plus, Sparkles, Square, X } from "lucide-react";
import type { CodexAppServerHistory, CodexAppServerSnapshot } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";

const empty: CodexAppServerSnapshot = { threadId: null, mode: "default", busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusLabels: Record<string, string> = { completed: "已完成", inProgress: "进行中", pending: "待处理", failed: "失败", declined: "已拒绝" };
const statusLabel = (status?: string) => statusLabels[status || ""] || status || "进行中";
type SessionItem = CodexAppServerSnapshot["items"][number];
type DisplayItem = { kind: "item"; item: SessionItem } | { kind: "commands"; items: SessionItem[] };

function groupCommands(items: SessionItem[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    if (item.type === "commandExecution") {
      if (previous?.kind === "commands") previous.items.push(item);
      else result.push({ kind: "commands", items: [item] });
    } else result.push({ kind: "item", item });
  }
  return result;
}

function commandGroupStatus(items: SessionItem[]) {
  if (items.every(item => item.status === "completed")) return "已完成";
  if (items.some(item => item.status === "inProgress" || item.status === "pending" || !item.status)) return "进行中";
  if (items.some(item => item.status === "failed" || item.status === "declined")) return "有失败";
  return "进行中";
}

export function CodexAppServerSession({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<CodexAppServerSnapshot>(empty);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pastingImage, setPastingImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [resolvingPlan, setResolvingPlan] = useState(false);
  const [history, setHistory] = useState<CodexAppServerHistory[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const currentSessionRef = useRef(sessionId);
  const pastedImagesRef = useRef(new Set<string>());
  const pastingRef = useRef(false);
  const changingModeRef = useRef(false);
  const resolvingPlanRef = useRef(false);
  currentSessionRef.current = sessionId;

  useEffect(() => {
    let active = true;
    setSnapshot(empty);
    setError("");
    setDraft("");
    setAttachments([]);
    setSending(false);
    setChangingMode(false);
    setResolvingPlan(false);
    changingModeRef.current = false;
    resolvingPlanRef.current = false;
    pastedImagesRef.current.clear();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryOpen(false);
    setLoadingHistory(false);
    void window.codexAppServerApi.snapshot(sessionId).then(value => { if (active) setSnapshot(value); })
      .catch(cause => { if (active) setError(message(cause)); });
    const off = window.codexAppServerApi.onChanged(payload => {
      if (active && payload.id === sessionId) setSnapshot(payload.snapshot);
    });
    return () => { active = false; off(); };
  }, [sessionId]);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [snapshot.items.length, snapshot.approvals.length]);

  async function submit() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || snapshot.busy || sending || pastingRef.current) return;
    setSending(true);
    setDraft(""); setError("");
    try { await window.codexAppServerApi.submit(sessionId, text, attachments); if (currentSessionRef.current === sessionId) { setAttachments([]); pastedImagesRef.current.clear(); } }
    catch (cause) { if (currentSessionRef.current === sessionId) { setDraft(text); setError(message(cause)); } }
    finally { if (currentSessionRef.current === sessionId) setSending(false); }
  }
  async function loadHistory(cursor?: string | null) {
    setLoadingHistory(true); setError("");
    try {
      const page = await window.codexAppServerApi.listHistory(sessionId, cursor);
      if (currentSessionRef.current !== sessionId) return;
      setHistory(current => cursor ? [...current, ...page.data] : page.data);
      setHistoryCursor(page.nextCursor);
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setLoadingHistory(false); }
  }
  async function selectHistory(threadId: string) {
    setError("");
    try { const value = await window.codexAppServerApi.resume(sessionId, threadId);
      if (currentSessionRef.current === sessionId) { setSnapshot(value); setHistoryOpen(false); setAttachments([]); pastedImagesRef.current.clear(); setDraft(""); } }
    catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
  }
  async function addFiles() {
    setError("");
    try { const paths = await window.codexAppServerApi.chooseFiles(sessionId);
      if (currentSessionRef.current === sessionId) setAttachments(current => [...new Set([...current, ...paths])].slice(0, 10)); }
    catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
  }
  async function pasteImage() {
    if (pastingRef.current || snapshot.busy || sending || !snapshot.threadId) return;
    if (attachments.length >= 10) { setError("最多附加 10 个文件。"); return; }
    pastingRef.current = true;
    setPastingImage(true);
    setError("");
    try {
      const result = await window.codexAppServerApi.pasteImage(sessionId);
      if (result.status === "no_image") throw new Error("剪贴板中没有可用的图片。");
      if (currentSessionRef.current !== sessionId) {
        await window.codexAppServerApi.discardImage(sessionId, result.path);
        return;
      }
      pastedImagesRef.current.add(result.path);
      setAttachments(current => [...current, result.path]);
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally { pastingRef.current = false; if (currentSessionRef.current === sessionId) setPastingImage(false); }
  }
  async function removeAttachment(filePath: string) {
    if (pastedImagesRef.current.has(filePath)) {
      try { await window.codexAppServerApi.discardImage(sessionId, filePath); pastedImagesRef.current.delete(filePath); }
      catch (cause) { setError(message(cause)); return; }
    }
    setAttachments(current => current.filter(value => value !== filePath));
  }
  async function resolve(requestId: number, approved: boolean) {
    setError("");
    try { await window.codexAppServerApi.resolveApproval(sessionId, requestId, approved); }
    catch (cause) { setError(message(cause)); }
  }
  async function changeMode(mode: "default" | "plan") {
    if (!snapshot.threadId || snapshot.busy || changingModeRef.current || mode === snapshot.mode) return;
    changingModeRef.current = true;
    setChangingMode(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setMode(sessionId, mode);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
    } catch (cause) {
      if (currentSessionRef.current === sessionId) setError(message(cause));
    } finally {
      if (currentSessionRef.current === sessionId) {
        changingModeRef.current = false;
        setChangingMode(false);
      }
    }
  }
  async function resolvePlan(itemId: string, execute: boolean) {
    if (resolvingPlanRef.current || snapshot.busy || snapshot.pendingPlan?.itemId !== itemId) return;
    resolvingPlanRef.current = true;
    setResolvingPlan(true);
    setError("");
    try {
      if (execute) await window.codexAppServerApi.executePlan(sessionId, itemId);
      else {
        const value = await window.codexAppServerApi.dismissPlan(sessionId, itemId);
        if (currentSessionRef.current === sessionId) setSnapshot(value);
      }
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally {
      if (currentSessionRef.current === sessionId) {
        resolvingPlanRef.current = false;
        setResolvingPlan(false);
      }
    }
  }

  return <section className="codex-app-server-session" aria-label="Codex App Server">
    <div className="codex-app-server-messages" aria-live="polite">
      {snapshot.items.length === 0 && !snapshot.busy && <div className="codex-app-server-empty"><span className="codex-app-server-empty-icon"><Sparkles aria-hidden="true" /></span><h2>有什么需要完成？</h2><p>描述你的任务，Codex 会在当前项目中协助你。</p><span className="codex-app-server-empty-hint">支持附加文件、粘贴图片与规划模式</span></div>}
      {groupCommands(snapshot.items).map(entry => {
        if (entry.kind === "commands") {
          const commands = entry.items;
          return <details className="codex-app-server-event" key={commands[0].id}>
            <summary><strong>{commands.length === 1 ? "执行命令" : `执行 ${commands.length} 条命令`}</strong>
              <span>{commands.length === 1 ? statusLabel(commands[0].status) : commandGroupStatus(commands)}</span></summary>
            {commands.map((command, index) => <div className="codex-app-server-command" key={command.id}>
              {commands.length > 1 && <div className="codex-app-server-command-heading"><strong>命令 {index + 1}</strong><span>{statusLabel(command.status)}</span></div>}
              <pre>{command.command}</pre>{command.output && <pre>{command.output}</pre>}
            </div>)}
          </details>;
        }
        const item = entry.item;
        if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan") return <article className={`codex-app-server-message ${item.type}`} key={item.id}>
          <strong>{item.type === "userMessage" ? "你" : item.type === "plan" ? "计划" : "Codex"}</strong>
          {item.type === "userMessage" ? <p>{item.text || ""}</p> : item.text && <MarkdownBlock className="codex-app-server-markdown" content={item.text} externalLinks />}
          {snapshot.pendingPlan?.itemId === item.id && <div className="codex-app-server-plan-confirm" role="group" aria-label="确认执行计划">
            <p>计划已完成。确认后将在当前会话中执行。</p>
            <div><button type="button" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, false)}>暂不执行</button>
              <button type="button" className="primary" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, true)}>执行计划</button></div>
          </div>}
        </article>;
        if (item.type === "turnPlan") return <article className="codex-app-server-message turnPlan" key={item.id}>
          <strong>计划进度</strong>
          {item.explanation && <p>{item.explanation}</p>}
          <ol>{item.plan?.map((step, index) => <li key={index}>{step.step} <span>{statusLabel(step.status)}</span></li>)}</ol>
        </article>;
        if (item.type === "fileChange") return <details className="codex-app-server-event" key={item.id}>
          <summary><strong>修改文件</strong><span>{statusLabel(item.status)}</span></summary>
          <pre>{JSON.stringify(item.changes, null, 2)}</pre>
        </details>;
        return null;
      })}
      {snapshot.approvals.map(approval => <article className="codex-app-server-approval" key={approval.requestId}>
        <strong>{approval.params.networkApprovalContext ? "网络访问确认" : approval.method.includes("fileChange") ? "文件修改确认" : "操作确认"}</strong>
        {approval.params.reason && <p>{approval.params.reason}</p>}
        {approval.params.networkApprovalContext && <p>{approval.params.networkApprovalContext.protocol}://{approval.params.networkApprovalContext.host}{approval.params.networkApprovalContext.port ? `:${approval.params.networkApprovalContext.port}` : ""}</p>}
        {approval.params.cwd && <p>{approval.params.cwd}</p>}
        {(approval.params.command || snapshot.items.find(item => item.id === approval.params.itemId)?.command) &&
          <pre>{approval.params.command || snapshot.items.find(item => item.id === approval.params.itemId)?.command}</pre>}
        {(approval.params.changes ?? snapshot.items.find(item => item.id === approval.params.itemId)?.changes) != null &&
          <pre>{JSON.stringify(approval.params.changes ?? snapshot.items.find(item => item.id === approval.params.itemId)?.changes, null, 2)}</pre>}
        <div><button type="button" onClick={() => void resolve(approval.requestId, false)}>拒绝</button>
          <button type="button" onClick={() => void resolve(approval.requestId, true)}>批准一次</button></div>
      </article>)}
      {snapshot.busy && <p className="codex-app-server-working"><LoaderCircle aria-hidden="true" />Codex 正在运行…</p>}
      {(snapshot.error || error) && <p className="codex-app-server-error" role="alert">{error || snapshot.error}</p>}
      <div ref={endRef} />
    </div>
    <form className="codex-app-server-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {historyOpen && <div className="codex-app-server-history" aria-label="历史会话">
        {history.length === 0 && !loadingHistory && !error && <p>当前项目没有历史会话。</p>}
        {history.map(thread => <button type="button" key={thread.id} disabled={snapshot.busy || sending || pastingImage || thread.id === snapshot.threadId} onClick={() => void selectHistory(thread.id)}>
          <strong>{thread.title}</strong><span>{new Date(thread.updatedAt * 1000).toLocaleString()} · {thread.source}</span>
        </button>)}
        {historyCursor && <button type="button" disabled={loadingHistory} onClick={() => void loadHistory(historyCursor)}>加载更多</button>}
        {loadingHistory && <p>正在加载历史会话…</p>}
      </div>}
      {attachments.length > 0 && <div className="codex-app-server-attachments">{attachments.map(filePath => <span key={filePath} title={filePath}>
        {filePath.split(/[\\/]/).pop()} <button type="button" disabled={snapshot.busy || sending || pastingImage} aria-label={`移除 ${filePath.split(/[\\/]/).pop()}`} onClick={() => void removeAttachment(filePath)}><X aria-hidden="true" /></button>
      </span>)}</div>}
      <textarea value={draft} onChange={event => setDraft(event.target.value)} onPaste={event => {
        if (!Array.from(event.clipboardData.items).some(item => item.type.startsWith("image/"))) return;
        event.preventDefault();
        void pasteImage();
      }} onKeyDown={event => {
        if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void changeMode(snapshot.mode === "plan" ? "default" : "plan");
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} placeholder="向 Codex 发送消息" disabled={!snapshot.threadId || snapshot.busy} />
      <div className="codex-app-server-composer-footer"><div className="codex-app-server-composer-tools">
        <button type="button" disabled={!snapshot.threadId || snapshot.busy || sending || pastingImage} onClick={() => void window.codexAppServerApi.newThread(sessionId)
          .then(value => { if (currentSessionRef.current === sessionId) { setSnapshot(value); setDraft(""); setAttachments([]); pastedImagesRef.current.clear(); setHistoryOpen(false); } })
          .catch(cause => { if (currentSessionRef.current === sessionId) setError(message(cause)); })}><Plus aria-hidden="true" />新对话</button>
        <button type="button" className={historyOpen ? "is-active" : undefined} aria-expanded={historyOpen} disabled={!snapshot.threadId || snapshot.busy} onClick={() => { const next = !historyOpen; setHistoryOpen(next); if (next) void loadHistory(); }}><History aria-hidden="true" />历史会话</button>
        <label className="codex-app-server-mode">模式 <select value={snapshot.mode} disabled={!snapshot.threadId || snapshot.busy || changingMode} onChange={event => void changeMode(event.target.value as "default" | "plan")}>
          <option value="default">Exec</option><option value="plan">Plan</option>
        </select></label>
        <button type="button" disabled={!snapshot.threadId || snapshot.busy || sending || pastingImage || attachments.length >= 10} onClick={() => void addFiles()}><Paperclip aria-hidden="true" />附加文件</button>
        <span><Clock3 aria-hidden="true" />Enter 发送 · Shift+Enter 换行</span></div>
      {snapshot.busy ? <button type="button" className="codex-app-server-send" onClick={() => void window.codexAppServerApi.interrupt(sessionId).catch(cause => setError(message(cause)))}><Square aria-hidden="true" />停止</button>
        : <button type="submit" className="codex-app-server-send" disabled={!snapshot.threadId || sending || pastingImage || (!draft.trim() && attachments.length === 0)}><ArrowUp aria-hidden="true" />发送</button>}</div>
    </form>
  </section>;
}
