import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PROTOCOL_VERSION, type ClientMessage, type GraphicalQuestion, type GraphicalSnapshot,
  type GraphicalHistory, type RuntimeSession, type ServerMessage } from "./types";

type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.history" | "command.ok" | "error" }>;
type Props = {
  session: RuntimeSession;
  send: (message: ClientMessage) => boolean;
  onGraphicalMessage: (listener: (message: GraphicalMessage) => void) => () => void;
};

function requestId() { return crypto.randomUUID(); }
function providerLabel(provider?: string) {
  return provider === "codebuddy" ? "CodeBuddy" : provider === "opencode" ? "OpenCode" : "Codex";
}

function QuestionCard({ question, onAnswer }: {
  question: GraphicalQuestion;
  onAnswer: (id: number | string, answers: Record<string, { answers: string[] }>) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const submit = () => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const entry of question.params.questions) {
      const choice = choices[entry.id];
      const note = (notes[entry.id] || "").trim();
      if ((!choice && !note) || (entry.options?.length && !choice && !entry.isOther)) {
        setError(`请回答「${entry.header || entry.question}」。`);
        return;
      }
      answers[entry.id] = { answers: [...(choice ? [choice] : []), ...(note ? [`user_note: ${note}`] : [])] };
    }
    setError("");
    onAnswer(question.requestId, answers);
  };
  return <article className="graphical-card" aria-label="待回答问题">
    <strong>需要回答</strong>
    {question.params.questions.map(entry => <label className="graphical-question" key={entry.id}>
      <span>{entry.question}</span>
      {entry.options?.length ? <select value={choices[entry.id] || ""} onChange={event => setChoices(current => ({ ...current, [entry.id]: event.target.value }))}>
        <option value="">请选择</option>
        {entry.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description ? ` · ${option.description}` : ""}</option>)}
      </select> : null}
      <input type={entry.isSecret ? "password" : "text"} value={notes[entry.id] || ""} placeholder={entry.options?.length ? "补充说明或自定义回答" : "回答"}
        onChange={event => setNotes(current => ({ ...current, [entry.id]: event.target.value }))} />
    </label>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="primary" disabled={question.submitting} onClick={submit}>提交回答</button>
  </article>;
}

export function GraphicalView({ session, send, onGraphicalMessage }: Props) {
  const [snapshot, setSnapshot] = useState<GraphicalSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<GraphicalHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const pendingRef = useRef(new Set<string>());
  const submitIdRef = useRef<string | null>(null);
  const historyIdRef = useRef<string | null>(null);
  const threadRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSnapshot(null);
    setHistory(null);
    setHistoryOpen(false);
    setError("");
    setSending(false);
    pendingRef.current.clear();
    threadRef.current = null;
    const unsubscribe = onGraphicalMessage(message => {
      if (message.type === "graphical.snapshot" && message.sessionId === session.id) {
        if (threadRef.current !== message.snapshot.threadId) {
          setHistory(null);
          setHistoryOpen(false);
        }
        threadRef.current = message.snapshot.threadId;
        setSnapshot(message.snapshot);
      } else if (message.type === "graphical.history" && message.sessionId === session.id
        && message.requestId === historyIdRef.current && message.threadId === threadRef.current) {
        pendingRef.current.delete(message.requestId);
        setHistory(current => current && current.nextCursor && current.nextCursor !== message.history.nextCursor
          ? { data: [...current.data, ...message.history.data], nextCursor: message.history.nextCursor }
          : message.history);
        setHistoryLoading(false);
      } else if (message.type === "command.ok" && pendingRef.current.delete(message.requestId)) {
        if (submitIdRef.current === message.requestId) { setDraft(""); setSending(false); submitIdRef.current = null; }
        setError("");
      } else if (message.type === "error" && message.requestId && pendingRef.current.delete(message.requestId)) {
        setError(message.message);
        if (submitIdRef.current === message.requestId) { setSending(false); submitIdRef.current = null; }
        if (historyIdRef.current === message.requestId) setHistoryLoading(false);
      }
    });
    send({ v: PROTOCOL_VERSION, type: "graphical.subscribe", sessionId: session.id });
    return unsubscribe;
  }, [session.id, send, onGraphicalMessage]);

  const lastItem = snapshot?.items.at(-1);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [snapshot?.items.length, lastItem?.text, lastItem?.output]);

  const action = (payload: { type: `graphical.${string}`; [key: string]: unknown }) => {
    if (!snapshot) return;
    const id = requestId();
    const message = { v: PROTOCOL_VERSION, sessionId: session.id, threadId: snapshot.threadId,
      requestId: id, ...payload } as ClientMessage;
    if (!send(message)) { setError("连接已断开，请重试。"); return; }
    pendingRef.current.add(id);
    return id;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || !snapshot?.threadId || sending) return;
    submitIdRef.current = action({ type: "graphical.submit", text }) || null;
    if (submitIdRef.current) setSending(true);
  };
  const loadHistory = (cursor: string | null = null) => {
    if (!snapshot) return;
    setHistoryLoading(true);
    if (!cursor) setHistory(null);
    historyIdRef.current = action({ type: "graphical.history", cursor }) || null;
    if (!historyIdRef.current) setHistoryLoading(false);
  };

  if (!snapshot) return <section className="graphical-shell graphical-loading">正在加载图形会话…</section>;
  return <section className="graphical-shell">
    <header className="graphical-header">
      <div><strong>{session.title}</strong><span>{providerLabel(snapshot.provider)} · {snapshot.busy ? "运行中" : "就绪"}</span></div>
      <button type="button" disabled={snapshot.busy || snapshot.capabilities?.history === false} onClick={() => { setHistoryOpen(true); loadHistory(); }}>历史</button>
      <button type="button" disabled={snapshot.busy} onClick={() => action({ type: "graphical.new-thread" })}>新对话</button>
    </header>
    {snapshot.error && <div className="graphical-error" role="alert">{snapshot.error}</div>}
    {error && <div className="graphical-error" role="alert">{error}</div>}
    <div className="graphical-timeline" ref={scrollRef}>
      {snapshot.items.length === 0 && <p className="graphical-empty">向 {providerLabel(snapshot.provider)} 发送消息以开始对话。</p>}
      {snapshot.items.map(item => {
        if (item.type === "userMessage" || item.type === "agentMessage")
          return <article className={`graphical-message ${item.type}`} key={item.id}><small>{item.type === "userMessage" ? "你" : providerLabel(snapshot.provider)}</small>
            <div className="graphical-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || ""}</ReactMarkdown></div></article>;
        if (item.type === "questionAnswer") return <article className="graphical-card" key={item.id}><strong>已回答问题</strong>{item.questions?.map(value => <p key={value.id}>{value.question}：{value.answers.join("、")}</p>)}</article>;
        if (item.type === "plan" || item.type === "turnPlan") return <article className="graphical-card" key={item.id}><strong>计划</strong><p>{item.text}</p>{item.plan?.map((step, index) => <p key={index}>{step.status === "completed" ? "✓" : "•"} {step.step}</p>)}</article>;
        return <details className="graphical-tool" key={item.id}><summary>{item.toolName || item.type}{item.status ? ` · ${item.status}` : ""}</summary>
          {item.command && <pre>{item.command}</pre>}{item.text && <p>{item.text}</p>}{item.output && <pre>{item.output}</pre>}</details>;
      })}
      {snapshot.pendingPlan && <article className="graphical-card"><strong>确认执行计划</strong><div className="graphical-actions">
        <button type="button" onClick={() => action({ type: "graphical.plan", itemId: snapshot.pendingPlan!.itemId, execute: false })}>暂不执行</button>
        <button type="button" className="primary" onClick={() => action({ type: "graphical.plan", itemId: snapshot.pendingPlan!.itemId, execute: true })}>执行计划</button>
      </div></article>}
      {snapshot.approvals.map(approval => <article className="graphical-card" key={approval.requestId}>
        <strong>{approval.params.networkApprovalContext ? "网络访问确认" : approval.method.includes("fileChange") ? "文件修改确认" : "操作确认"}</strong>
        <p>{approval.params.reason || approval.params.command || approval.method}</p>
        {approval.params.cwd && <small>{approval.params.cwd}</small>}
        {approval.params.networkApprovalContext && <p>{approval.params.networkApprovalContext.protocol}://{approval.params.networkApprovalContext.host}{approval.params.networkApprovalContext.port ? `:${approval.params.networkApprovalContext.port}` : ""}</p>}
        {approval.params.changes != null && <pre>{JSON.stringify(approval.params.changes, null, 2)}</pre>}
        {approval.params.choices?.length ? <div className="graphical-actions">{approval.params.choices.map(choice =>
          <button type="button" key={choice.id} onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: choice.id })}>{choice.label}</button>)}</div>
          : <div className="graphical-actions"><button type="button" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: false })}>拒绝</button>
            <button type="button" className="primary" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: true })}>批准一次</button></div>}
      </article>)}
      {snapshot.questions.map(question => <QuestionCard key={question.requestId} question={question}
        onAnswer={(questionId, answers) => action({ type: "graphical.answer", questionId, answers })} />)}
    </div>
    <form className="graphical-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder={snapshot.archived ? "已归档的对话不可发送" : "输入消息"}
        disabled={!snapshot.threadId || snapshot.archived || (snapshot.busy && snapshot.provider !== "codex")} />
      {snapshot.busy && <button type="button" onClick={() => action({ type: "graphical.interrupt" })}>停止</button>}
      <button type="submit" className="primary" disabled={sending || !draft.trim() || !snapshot.threadId || snapshot.archived || (snapshot.busy && snapshot.provider !== "codex")}>发送</button>
    </form>
    {historyOpen && <div className="graphical-history-backdrop" onClick={() => setHistoryOpen(false)}><aside className="graphical-history" onClick={event => event.stopPropagation()}>
      <header><strong>历史对话</strong><button type="button" onClick={() => setHistoryOpen(false)}>关闭</button></header>
      {history?.data.map(thread => <button type="button" key={thread.id} disabled={snapshot.busy || thread.archived || thread.id === snapshot.threadId}
        onClick={() => { action({ type: "graphical.resume", targetThreadId: thread.id }); setHistoryOpen(false); }}>
        <strong>{thread.title}</strong><small>{new Date(thread.updatedAt * 1000).toLocaleString()}</small>
      </button>)}
      {historyLoading && <p>正在加载…</p>}
      {!historyLoading && history?.data.length === 0 && <p>暂无历史对话</p>}
      {history?.nextCursor && <button type="button" disabled={historyLoading} onClick={() => loadHistory(history.nextCursor)}>加载更多</button>}
    </aside></div>}
  </section>;
}
