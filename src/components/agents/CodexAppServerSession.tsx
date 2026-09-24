import { useEffect, useRef, useState } from "react";
import type { CodexAppServerHistory, CodexAppServerSnapshot } from "../../vite-env";

const empty: CodexAppServerSnapshot = { threadId: null, mode: "default", busy: false, error: null, items: [], approvals: [] };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodexAppServerSession({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<CodexAppServerSnapshot>(empty);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [history, setHistory] = useState<CodexAppServerHistory[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const currentSessionRef = useRef(sessionId);
  currentSessionRef.current = sessionId;

  useEffect(() => {
    let active = true;
    setSnapshot(empty);
    setError("");
    setDraft("");
    setAttachments([]);
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
    if ((!text && attachments.length === 0) || snapshot.busy) return;
    setDraft(""); setError("");
    try { await window.codexAppServerApi.submit(sessionId, text, attachments); if (currentSessionRef.current === sessionId) setAttachments([]); }
    catch (cause) { if (currentSessionRef.current === sessionId) { setDraft(text); setError(message(cause)); } }
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
      if (currentSessionRef.current === sessionId) { setSnapshot(value); setHistoryOpen(false); setAttachments([]); setDraft(""); } }
    catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
  }
  async function addFiles() {
    setError("");
    try { const paths = await window.codexAppServerApi.chooseFiles(sessionId);
      if (currentSessionRef.current === sessionId) setAttachments(current => [...new Set([...current, ...paths])].slice(0, 10)); }
    catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
  }
  async function resolve(requestId: number, approved: boolean) {
    setError("");
    try { await window.codexAppServerApi.resolveApproval(sessionId, requestId, approved); }
    catch (cause) { setError(message(cause)); }
  }

  return <section className="codex-app-server-session" aria-label="Codex App Server">
    <div className="codex-app-server-toolbar">
      <button type="button" disabled={!snapshot.threadId || snapshot.busy} onClick={() => void window.codexAppServerApi.newThread(sessionId)
        .then(value => { if (currentSessionRef.current === sessionId) { setSnapshot(value); setDraft(""); setAttachments([]); setHistoryOpen(false); } })
        .catch(cause => { if (currentSessionRef.current === sessionId) setError(message(cause)); })}>新对话</button>
      <button type="button" disabled={!snapshot.threadId || snapshot.busy} onClick={() => { const next = !historyOpen; setHistoryOpen(next); if (next) void loadHistory(); }}>历史会话</button>
      <label>模式 <select value={snapshot.mode} disabled={!snapshot.threadId || snapshot.busy} onChange={event => void window.codexAppServerApi.setMode(sessionId, event.target.value as "default" | "plan")
        .then(value => { if (currentSessionRef.current === sessionId) setSnapshot(value); })
        .catch(cause => { if (currentSessionRef.current === sessionId) setError(message(cause)); })}>
        <option value="default">默认</option><option value="plan">Plan</option>
      </select></label>
    </div>
    {historyOpen && <div className="codex-app-server-history" aria-label="历史会话">
      {history.length === 0 && !loadingHistory && !error && <p>当前项目没有历史会话。</p>}
      {history.map(thread => <button type="button" key={thread.id} disabled={snapshot.busy || thread.id === snapshot.threadId} onClick={() => void selectHistory(thread.id)}>
        <strong>{thread.title}</strong><span>{new Date(thread.updatedAt * 1000).toLocaleString()} · {thread.source}</span>
      </button>)}
      {historyCursor && <button type="button" disabled={loadingHistory} onClick={() => void loadHistory(historyCursor)}>加载更多</button>}
      {loadingHistory && <p>正在加载历史会话…</p>}
    </div>}
    <div className="codex-app-server-messages" aria-live="polite">
      {snapshot.items.length === 0 && <p className="codex-app-server-empty">Codex 已就绪，输入消息开始。</p>}
      {snapshot.items.map(item => {
        if (item.type === "userMessage" || item.type === "agentMessage") return <article className={`codex-app-server-message ${item.type}`} key={item.id}>
          <strong>{item.type === "userMessage" ? "你" : "Codex"}</strong><p>{item.text || ""}</p>
        </article>;
        if (item.type === "commandExecution") return <article className="codex-app-server-event" key={item.id}>
          <strong>执行命令 · {item.status || "运行中"}</strong><pre>{item.command}</pre>{item.output && <pre>{item.output}</pre>}
        </article>;
        if (item.type === "fileChange") return <article className="codex-app-server-event" key={item.id}>
          <strong>修改文件 · {item.status || "运行中"}</strong><pre>{JSON.stringify(item.changes, null, 2)}</pre>
        </article>;
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
      {snapshot.busy && <p className="codex-app-server-working">Codex 正在运行…</p>}
      {(snapshot.error || error) && <p className="codex-app-server-error" role="alert">{error || snapshot.error}</p>}
      <div ref={endRef} />
    </div>
    <form className="codex-app-server-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {attachments.length > 0 && <div className="codex-app-server-attachments">{attachments.map(filePath => <span key={filePath} title={filePath}>
        {filePath.split(/[\\/]/).pop()} <button type="button" aria-label={`移除 ${filePath.split(/[\\/]/).pop()}`} onClick={() => setAttachments(current => current.filter(value => value !== filePath))}>×</button>
      </span>)}</div>}
      <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} placeholder="向 Codex 发送消息" disabled={!snapshot.threadId || snapshot.busy} />
      <button type="button" disabled={!snapshot.threadId || snapshot.busy || attachments.length >= 10} onClick={() => void addFiles()}>附加文件</button>
      {snapshot.busy ? <button type="button" onClick={() => void window.codexAppServerApi.interrupt(sessionId).catch(cause => setError(message(cause)))}>停止</button>
        : <button type="submit" disabled={!snapshot.threadId || (!draft.trim() && attachments.length === 0)}>发送</button>}
    </form>
  </section>;
}
