import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createRequestId } from "./protocol";
import { GraphicalUsage } from "./GraphicalUsage";
import { QuickCommandPicker } from "./QuickCommandPicker";
import { PROTOCOL_VERSION, type AgentProvider, type ClientMessage, type GraphicalItem, type GraphicalQuestion, type GraphicalSnapshot,
  type GraphicalHistory, type QuickCommand, type RuntimeSession, type ServerMessage } from "./types";

type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "command.ok" | "error" }>;
type Props = {
  session: RuntimeSession;
  send: (message: ClientMessage) => boolean;
  onGraphicalMessage: (listener: (message: GraphicalMessage) => void) => () => void;
};

function providerLabel(provider?: string) {
  return provider === "codebuddy" ? "CodeBuddy" : provider === "opencode" ? "OpenCode" : "Codex";
}

const execModeIds = ["default", "normal", "code", "ask", "build", "acceptEdits"];
const graphicalProviders: AgentProvider[] = ["codex", "codebuddy", "opencode"];
type ActionSheet = "menu" | "agent" | "agent-confirm" | "model" | "history" | null;
function canSwitchMode(snapshot: GraphicalSnapshot, mode: "default" | "plan") {
  if (snapshot.provider === "codex") return mode === "default" || snapshot.capabilities?.plan !== false;
  const modes = snapshot.nativeModes || [];
  return mode === "plan" ? modes.some(value => /plan/i.test(value.id))
    : modes.some(value => execModeIds.some(id => id.toLowerCase() === value.id.toLowerCase()));
}
function configLabel(snapshot: GraphicalSnapshot, id: "model" | "effort") {
  const option = snapshot.acpOptions?.find(value => value.id === id);
  const value = typeof option?.currentValue === "string" ? option.currentValue : null;
  return value ? option?.options.find(entry => entry.value === value)?.name || value : null;
}
function modelLabel(snapshot: GraphicalSnapshot) {
  const model = configLabel(snapshot, "model");
  if (model) return model;
  const id = snapshot.model || snapshot.effectiveModel;
  return id ? snapshot.models?.find(value => value.id === id)?.displayName || id : "未提供";
}
function modelOptions(snapshot: GraphicalSnapshot) {
  if (snapshot.provider === "codex") return snapshot.backend === "openai"
    ? (snapshot.models || []).map(model => ({ value: model.id, name: model.displayName })) : [];
  return snapshot.acpOptions?.find(option => option.id === "model")?.options || [];
}
function effortLabel(snapshot: GraphicalSnapshot) {
  const effort = configLabel(snapshot, "effort") || snapshot.effort;
  const labels: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
  return effort ? labels[effort] || effort : "未提供";
}
function permissionLabel(permission?: string | null) {
  const labels: Record<string, string> = { readOnly: "只读", askApproval: "需要确认", fullAccess: "完全访问" };
  return permission ? labels[permission] || permission : null;
}

type TimelineEntry = { kind: "item"; item: GraphicalItem } | { kind: "tools"; items: GraphicalItem[] };
const toolTypes = new Set(["commandExecution", "fileChange", "toolCall", "mcpToolCall", "dynamicToolCall", "webSearch"]);
const visibleTypes = new Set(["userMessage", "agentMessage", "plan", "turnPlan", "questionAnswer", "backgroundTurn", "turnError"]);
function groupTimeline(items: GraphicalItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    if (!toolTypes.has(item.type) && !visibleTypes.has(item.type)) continue;
    const previous = entries.at(-1);
    if (toolTypes.has(item.type)) {
      if (previous?.kind === "tools" && (!previous.items[0].turnId || !item.turnId || previous.items[0].turnId === item.turnId))
        previous.items.push(item);
      else entries.push({ kind: "tools", items: [item] });
    } else entries.push({ kind: "item", item });
  }
  return entries;
}
function toolStatus(items: GraphicalItem[]) {
  if (items.some(item => item.status === "failed" || item.status === "declined")) return "有失败";
  if (items.every(item => item.status === "completed")) return "已完成";
  return "进行中";
}
function itemStatus(status?: string) {
  return status === "completed" ? "已完成" : status === "failed" ? "失败" : status === "declined" ? "已拒绝"
    : status === "inProgress" ? "进行中" : status === "pending" ? "等待中" : status || "进行中";
}
function toolLabel(item: GraphicalItem) {
  if (item.toolName || item.tool) return item.toolName || item.tool;
  if (item.type === "fileChange") return "文件变更";
  if (item.type === "webSearch") return "搜索";
  if (item.type === "commandExecution" || item.toolKind === "execute") return "执行命令";
  return "工具调用";
}
function toolSummary(item: GraphicalItem) {
  const change = Array.isArray(item.changes) ? item.changes[0] : null;
  const changedFile = change && typeof change === "object" ? String((change as Record<string, unknown>).path || (change as Record<string, unknown>).filePath || "") : "";
  return item.command?.trim().split(/\r?\n/, 1)[0] || item.query || item.locations?.[0]?.path || changedFile || item.server || "";
}
function codeBuddyToolPresentation(item: GraphicalItem) {
  const labels: Record<string, string> = {
    read: "读取文件", write: "写入文件", edit: "编辑文件", delete: "删除文件", move: "移动文件",
    search: "搜索", fetch: "网页读取", execute: "执行命令"
  };
  const label = labels[item.toolKind || ""] || toolLabel({ ...item, toolName: undefined, tool: undefined });
  if (!item.toolName && item.command) return { label, summary: item.command.trim().split(/\r?\n/, 1)[0] };
  const output = item.output?.trim() || "";
  if (output && output.length <= 80 && !/[\r\n]/.test(output)) return { label, summary: output };
  const titlePath = item.toolName?.replace(/\s+\(\d+\s*-\s*\d+\)$/, "").match(/^(?:Read|Edit|Write|Delete|Move)\s+(.+)$/i)?.[1];
  const target = item.locations?.[0]?.path || item.locations?.[0]?.uri || titlePath || "";
  return { label, summary: target.split(/[\\/]/).pop() || "" };
}
function ToolItem({ item, codeBuddy = false }: { item: GraphicalItem; codeBuddy?: boolean }) {
  const presentation = codeBuddy ? codeBuddyToolPresentation(item) : null;
  return <details className="graphical-tool">
    <summary><span className="graphical-tool-label">{presentation?.label || toolLabel(item)}</span><span className="graphical-tool-summary">{presentation?.summary ?? toolSummary(item)}</span>
      <span className="graphical-tool-status">{itemStatus(item.status)}</span></summary>
    <div className="graphical-tool-details">
      {codeBuddy && item.toolName && <pre>{item.toolName}</pre>}
      {item.command && <pre>{item.command}</pre>}{item.server && <p>{item.server}</p>}{item.query && <p>{item.query}</p>}
      {item.arguments != null && <pre>{typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments, null, 2)}</pre>}
      {item.text && <p>{item.text}</p>}{item.output && <pre>{item.output}</pre>}
      {item.result != null && <pre>{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre>}
      {item.changes != null && <pre>{JSON.stringify(item.changes, null, 2)}</pre>}
      {item.locations?.map((location, index) => <p key={index}>{location.path || location.uri || "相关位置"}</p>)}
      {!item.command && !item.server && !item.query && item.arguments == null && !item.text && !item.output && !(codeBuddy && item.toolName)
        && item.result == null && item.changes == null && !item.locations?.length && <p>等待工具返回内容…</p>}
    </div>
  </details>;
}

function QuestionCard({ question, provider, onAnswer, onCancel }: {
  question: GraphicalQuestion;
  provider: AgentProvider;
  onAnswer: (id: number | string, answers: Record<string, { answers: string[] }>) => void;
  onCancel: (id: number | string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const submit = () => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const entry of question.params.questions) {
      const choice = choices[entry.id] || [];
      const note = (notes[entry.id] || "").trim();
      if ((!choice.length && !note) || (entry.options?.length && !choice.length && !entry.isOther)) {
        setError(`请回答「${entry.header || entry.question}」。`);
        return;
      }
      answers[entry.id] = { answers: provider === "codebuddy"
        ? [...(entry.multiSelect ? choice : note ? [] : choice), ...(note ? [note] : [])]
        : [...choice, ...(note ? [`user_note: ${note}`] : [])] };
    }
    setError("");
    onAnswer(question.requestId, answers);
  };
  return <article className="graphical-card" aria-label="待回答问题">
    <strong>需要回答</strong>
    {question.params.questions.map(entry => <div className="graphical-question" key={entry.id}>
      <span>{entry.question}</span>
      {entry.options?.length && entry.multiSelect ? entry.options.map(option => <label className="graphical-question-choice" key={option.label}>
        <input type="checkbox" checked={choiceIncludes(choices[entry.id], option.label)}
          onChange={() => setChoices(current => ({ ...current, [entry.id]: choiceIncludes(current[entry.id], option.label)
            ? current[entry.id].filter(value => value !== option.label) : [...(current[entry.id] || []), option.label] }))} />
        {option.label}{option.description ? ` · ${option.description}` : ""}
      </label>) : entry.options?.length ? <select aria-label={entry.question} value={choices[entry.id]?.[0] || ""} onChange={event => {
        setChoices(current => ({ ...current, [entry.id]: event.target.value ? [event.target.value] : [] }));
        if (provider === "codebuddy") setNotes(current => ({ ...current, [entry.id]: "" }));
      }}>
        <option value="">请选择</option>
        {entry.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description ? ` · ${option.description}` : ""}</option>)}
      </select> : null}
      <input type={entry.isSecret ? "password" : "text"} aria-label={`${entry.question}的自定义回答`} value={notes[entry.id] || ""} placeholder={entry.options?.length ? "补充说明或自定义回答" : "回答"}
        onChange={event => { setNotes(current => ({ ...current, [entry.id]: event.target.value }));
          if (provider === "codebuddy" && !entry.multiSelect) setChoices(current => ({ ...current, [entry.id]: [] })); }} />
    </div>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="primary" disabled={question.submitting} onClick={submit}>提交回答</button>
    {provider === "codebuddy" && <button type="button" disabled={question.submitting} onClick={() => onCancel(question.requestId)}>取消提问</button>}
  </article>;
}

function choiceIncludes(choices: string[] | undefined, label: string) { return choices?.includes(label) || false; }

export function GraphicalView({ session, send, onGraphicalMessage }: Props) {
  const [snapshot, setSnapshot] = useState<GraphicalSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [activeSheet, setActiveSheet] = useState<ActionSheet>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider | null>(null);
  const [history, setHistory] = useState<GraphicalHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const pendingRef = useRef(new Set<string>());
  const submitIdRef = useRef<string | null>(null);
  const quickIdRef = useRef<string | null>(null);
  const quickDraftRef = useRef("");
  const historyIdRef = useRef<string | null>(null);
  const modeIdRef = useRef<string | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const modelIdRef = useRef<string | null>(null);
  const uploadRequests = useRef(new Map<string, { resolve: (value: { fileId: string; url: string }) => void; reject: (reason: Error) => void }>());
  const cancelledUploads = useRef(new Set<string>());
  const [attachments, setAttachments] = useState<Array<{ key: string; file: File; fileId?: string; status: "uploading" | "ready" | "failed" }>>([]);
  const attachmentsRef = useRef<typeof attachments>([]);
  const switchIdRef = useRef<string | null>(null);
  const [switchingTo, setSwitchingTo] = useState<AgentProvider | null>(null);
  const threadRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    setSnapshot(null);
    setHistory(null);
    setActiveSheet(null);
    setSelectedProvider(null);
    setError("");
    setSending(false);
    setChangingMode(false);
    setChangingModel(false);
    setAttachments([]);
    setSwitchingTo(null);
    setExpandedGroupId(null);
    pendingRef.current.clear();
    modeIdRef.current = null;
    quickIdRef.current = null;
    quickDraftRef.current = "";
    modelIdRef.current = null;
    switchIdRef.current = null;
    threadRef.current = null;
    const unsubscribe = onGraphicalMessage(message => {
      if (message.type === "graphical.snapshot" && message.sessionId === session.id) {
        if (threadRef.current !== message.snapshot.threadId) {
          if (quickIdRef.current) pendingRef.current.delete(quickIdRef.current);
          quickIdRef.current = null;
          quickDraftRef.current = "";
          setSending(false);
          for (const item of attachmentsRef.current) cancelledUploads.current.add(item.key);
          const fileIds = attachmentsRef.current.flatMap(item => item.fileId ? [item.fileId] : []);
          if (fileIds.length) send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
            threadId: threadRef.current, fileIds, requestId: createRequestId() });
          setHistory(null);
          setActiveSheet(null);
          setSelectedProvider(null);
          setExpandedGroupId(null);
          setAttachments([]);
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
      } else if (message.type === "graphical.upload.ready") {
        const pending = uploadRequests.current.get(message.requestId);
        if (pending) { uploadRequests.current.delete(message.requestId); pending.resolve({ fileId: message.fileId, url: message.url }); }
      } else if (message.type === "command.ok" && pendingRef.current.delete(message.requestId)) {
        if (submitIdRef.current === message.requestId) { setDraft(""); setAttachments([]); setSending(false); submitIdRef.current = null; }
        if (quickIdRef.current === message.requestId) {
          const quickDraft = quickDraftRef.current;
          if (quickDraft) setDraft(current => current + quickDraft);
          quickDraftRef.current = "";
          quickIdRef.current = null;
          setSending(false);
        }
        if (modeIdRef.current === message.requestId) { setChangingMode(false); modeIdRef.current = null; }
        if (modelIdRef.current === message.requestId) { setChangingModel(false); modelIdRef.current = null; }
        setError("");
      } else if (message.type === "error" && message.requestId && pendingRef.current.delete(message.requestId)) {
        const upload = uploadRequests.current.get(message.requestId);
        if (upload) { uploadRequests.current.delete(message.requestId); upload.reject(new Error(message.message)); }
        setError(message.message);
        if (submitIdRef.current === message.requestId) { setSending(false); submitIdRef.current = null; }
        if (quickIdRef.current === message.requestId) { setSending(false); quickIdRef.current = null; quickDraftRef.current = ""; }
        if (modeIdRef.current === message.requestId) { setChangingMode(false); modeIdRef.current = null; }
        if (modelIdRef.current === message.requestId) { setChangingModel(false); modelIdRef.current = null; }
        if (switchIdRef.current === message.requestId) { setSwitchingTo(null); switchIdRef.current = null; }
        if (historyIdRef.current === message.requestId) setHistoryLoading(false);
      }
    });
    send({ v: PROTOCOL_VERSION, type: "graphical.subscribe", sessionId: session.id });
    return () => {
      unsubscribe();
      for (const item of attachmentsRef.current) cancelledUploads.current.add(item.key);
      const fileIds = attachmentsRef.current.flatMap(item => item.fileId ? [item.fileId] : []);
      if (fileIds.length) send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
        threadId: threadRef.current, fileIds, requestId: createRequestId() });
      for (const pending of uploadRequests.current.values()) pending.reject(new Error("会话已切换。"));
      uploadRequests.current.clear();
    };
  }, [session.id, send, onGraphicalMessage]);

  const lastItem = snapshot?.items.at(-1);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [snapshot?.items.length, lastItem?.text, lastItem?.output]);

  useEffect(() => {
    if (!activeSheet) return;
    sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveSheet(null);
      if (event.key !== "Tab" || !sheetRef.current) return;
      const elements = [...sheetRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheetRef.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); moreButtonRef.current?.focus(); };
  }, [activeSheet]);

  const action = (payload: { type: `graphical.${string}`; [key: string]: unknown }) => {
    if (!snapshot) return;
    const id = createRequestId();
    const message = { v: PROTOCOL_VERSION, sessionId: session.id, threadId: snapshot.threadId,
      requestId: id, ...payload } as ClientMessage;
    if (!send(message)) { setError("连接已断开，请重试。"); return; }
    pendingRef.current.add(id);
    return id;
  };

  const submit = () => {
    const text = draft.trim();
    const ready = attachments.filter(item => item.status === "ready" && item.fileId);
    if ((!text && !ready.length) || attachments.some(item => item.status !== "ready") || !snapshot?.threadId || sending) return;
    submitIdRef.current = action({ type: "graphical.submit", text, fileIds: ready.map(item => item.fileId) }) || null;
    if (submitIdRef.current) setSending(true);
  };
  const runQuickCommand = (command: QuickCommand) => {
    if (!snapshot?.threadId || snapshot.archived) return false;
    if ((command.mode || "write") === "write") { setDraft(current => current + command.command); return true; }
    if (sending || quickIdRef.current) return false;
    const id = createRequestId();
    if (!send({ v: PROTOCOL_VERSION, type: "quick-command.invoke", sessionId: session.id,
      commandId: command.id, threadId: snapshot.threadId, requestId: id })) {
      setError("连接已断开，请重试。");
      return false;
    }
    pendingRef.current.add(id);
    quickIdRef.current = id;
    quickDraftRef.current = command.mode === "one-time" ? command.command : "";
    setSending(true);
    return true;
  };
  const changeModel = (modelId: string) => {
    if (!snapshot || snapshot.busy || snapshot.archived || changingModel || attachments.length || !modelOptions(snapshot).some(option => option.value === modelId)) return;
    modelIdRef.current = action({ type: "graphical.model", modelId }) || null;
    if (modelIdRef.current) { setChangingModel(true); setActiveSheet(null); }
  };
  const uploadFile = async (file: File, key: string) => {
    if (!snapshot?.threadId) return;
    const requestId = createRequestId();
    const prepared = new Promise<{ fileId: string; url: string }>((resolve, reject) => uploadRequests.current.set(requestId, { resolve, reject }));
    pendingRef.current.add(requestId);
    if (!send({ v: PROTOCOL_VERSION, type: "graphical.upload.prepare", sessionId: session.id,
      threadId: snapshot.threadId, name: file.name, size: file.size, requestId })) {
      uploadRequests.current.delete(requestId); pendingRef.current.delete(requestId);
      setAttachments(current => current.map(item => item.key === key ? { ...item, status: "failed" } : item));
      setError("连接已断开，请重试。");
      return;
    }
    let uploadedId: string | null = null;
    try {
      const { fileId, url } = await prepared;
      uploadedId = fileId;
      pendingRef.current.delete(requestId);
      const response = await fetch(url, { method: "POST", body: file, cache: "no-store" });
      if (!response.ok) throw new Error("附件上传失败，请重试。");
      if (threadRef.current !== snapshot.threadId || cancelledUploads.current.has(key)) {
        send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
          threadId: snapshot.threadId, fileIds: [fileId], requestId: createRequestId() });
        return;
      }
      setAttachments(current => current.map(item => item.key === key ? { ...item, fileId, status: "ready" } : item));
    } catch (cause) {
      if (uploadedId) send({ v: PROTOCOL_VERSION, type: "graphical.upload.discard", sessionId: session.id,
        threadId: snapshot.threadId, fileIds: [uploadedId], requestId: createRequestId() });
      setAttachments(current => current.map(item => item.key === key ? { ...item, status: "failed" } : item));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const chosen = [...files].slice(0, Math.max(0, 10 - attachments.length));
    if (chosen.length < files.length) setError("最多附加 10 个文件。");
    for (const file of chosen) {
      if (file.size > 10 * 1024 * 1024) { setError("单个附件必须在 10 MB 以内。"); continue; }
      const key = createRequestId();
      setAttachments(current => [...current, { key, file, status: "uploading" }]);
      void uploadFile(file, key);
    }
  };
  const removeAttachment = (key: string) => {
    cancelledUploads.current.add(key);
    const item = attachments.find(value => value.key === key);
    if (item?.fileId) action({ type: "graphical.upload.discard", fileIds: [item.fileId] });
    setAttachments(current => current.filter(value => value.key !== key));
  };
  const changeMode = (mode: "default" | "plan") => {
    if (!snapshot || snapshot.busy || snapshot.archived || changingMode || !canSwitchMode(snapshot, mode)) return;
    if (snapshot.mode === mode) return;
    modeIdRef.current = action({ type: "graphical.mode", mode }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const switchAgent = (provider: AgentProvider) => {
    if (!snapshot || snapshot.busy || snapshot.approvals.length || snapshot.questions.length || snapshot.pendingPlan || switchingTo
      || provider === snapshot.provider) return;
    const id = createRequestId();
    if (!send({ v: PROTOCOL_VERSION, type: "session.switch-agent", sessionId: session.id,
      threadId: snapshot.threadId, provider, requestId: id })) {
      setError("连接已断开，请重试。");
      return;
    }
    pendingRef.current.add(id);
    switchIdRef.current = id;
    setError("");
    setSwitchingTo(provider);
    setActiveSheet(null);
    setSelectedProvider(null);
  };
  const loadHistory = (cursor: string | null = null) => {
    if (!snapshot) return;
    setHistoryLoading(true);
    if (!cursor) setHistory(null);
    historyIdRef.current = action({ type: "graphical.history", cursor }) || null;
    if (!historyIdRef.current) setHistoryLoading(false);
  };

  const openHistory = () => { setActiveSheet("history"); loadHistory(); };

  if (!snapshot) return <section className="graphical-shell graphical-loading">正在加载图形会话…</section>;
  const addFileDisabled = !snapshot.threadId || snapshot.archived || sending || attachments.length >= 10
    || (snapshot.busy && snapshot.provider !== "codex");
  const modelDisabled = !modelOptions(snapshot).length || snapshot.busy || snapshot.archived || changingModel || attachments.length > 0;
  const agentDisabled = snapshot.busy || Boolean(snapshot.approvals.length || snapshot.questions.length || snapshot.pendingPlan || switchingTo);
  const currentModel = snapshot.provider === "codex" ? snapshot.model || snapshot.effectiveModel || ""
    : String(snapshot.acpOptions?.find(option => option.id === "model")?.currentValue || "");
  const effectivePlan = snapshot.mode === "plan";
  return <section className="graphical-shell">
    <header className="graphical-header">
      <div className="graphical-header-details">
        <strong>{session.title}</strong>
        <span>{providerLabel(snapshot.provider)} · {snapshot.busy ? "运行中" : "就绪"}</span>
        <div className="graphical-current-config">
          <span>模型：{modelLabel(snapshot)}</span>
          <span>强度：{effortLabel(snapshot)}</span>
          {snapshot.provider === "codex" && permissionLabel(snapshot.executionPermission)
            && <span>执行权限：{permissionLabel(snapshot.executionPermission)}</span>}
          {snapshot.fastMode && <span>快速模式</span>}
        </div>
      </div>
      {switchingTo && <span className="graphical-switching">切换中…</span>}
      <button ref={moreButtonRef} type="button" className="graphical-more-button" aria-label="更多操作" aria-haspopup="dialog"
        aria-expanded={Boolean(activeSheet)} onClick={() => setActiveSheet("menu")}>···</button>
    </header>
    <GraphicalUsage sessionId={session.id} snapshot={snapshot} send={send} onGraphicalMessage={onGraphicalMessage} />
    {snapshot.error && <div className="graphical-error" role="alert">{snapshot.error}</div>}
    {error && !activeSheet && <div className="graphical-error" role="alert">{error}</div>}
    <div className="graphical-timeline" ref={scrollRef}>
      {snapshot.items.length === 0 && <p className="graphical-empty">向 {providerLabel(snapshot.provider)} 发送消息以开始对话。</p>}
      {groupTimeline(snapshot.items).map(entry => {
        if (entry.kind === "tools") {
          const groupId = entry.items[0].id;
          const expanded = expandedGroupId === groupId;
          const status = toolStatus(entry.items);
          return <section className="graphical-tool-group" data-status={status} key={groupId}>
            <button type="button" className="graphical-tool-group-toggle" aria-expanded={expanded}
              onClick={() => setExpandedGroupId(current => current === groupId ? null : groupId)}>
              <span className="graphical-tool-group-chevron" aria-hidden="true">›</span>
              <strong>工具调用 · {entry.items.length} 项</strong><span>{status}</span>
            </button>
            {expanded && <div className="graphical-tool-list">{entry.items.map(item => <ToolItem item={item} codeBuddy={snapshot.provider === "codebuddy"} key={item.id} />)}</div>}
          </section>;
        }
        const item = entry.item;
        if (item.type === "userMessage" || item.type === "agentMessage")
          return <article className={`graphical-message ${item.type}`} key={item.id}><small>{item.type === "userMessage" ? "你" : providerLabel(snapshot.provider)}</small>
            <div className="graphical-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || ""}</ReactMarkdown></div>
            {item.attachments?.length ? <div className="graphical-attachment-history">{item.attachments.map((file, index) => <span key={index}>📎 {file.name}</span>)}</div> : null}</article>;
        if (item.type === "questionAnswer") return <article className="graphical-card" key={item.id}><strong>已回答问题</strong>{item.questions?.map(value => <p key={value.id}>{value.question}：{value.answers.join("、")}</p>)}</article>;
        if (item.type === "plan" || item.type === "turnPlan") return <article className="graphical-card" key={item.id}><strong>计划</strong><p>{item.text}</p>{item.plan?.map((step, index) => <p key={index}>{step.status === "completed" ? "✓" : "•"} {step.step}</p>)}</article>;
        if (item.type === "turnError") return <article className="graphical-card" role="alert" key={item.id}><strong>运行错误</strong><p>{item.text}</p></article>;
        return <article className="graphical-card" key={item.id}><strong>后台任务汇总</strong></article>;
      })}
      {snapshot.provider === "codex" && snapshot.diagnostics?.map(event => <details className="graphical-card graphical-diagnostic" key={event.id}>
        <summary><strong>运行错误</strong>{event.message}</summary>
        {(event.kind || event.httpStatusCode) && <p>{event.kind || "Codex 错误"}{event.httpStatusCode ? ` · HTTP ${event.httpStatusCode}` : ""}</p>}
        {event.additionalDetails != null && <pre>{typeof event.additionalDetails === "string" ? event.additionalDetails : JSON.stringify(event.additionalDetails, null, 2)}</pre>}
      </details>)}
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
      {snapshot.questions.map(question => <QuestionCard key={question.requestId} question={question} provider={snapshot.provider}
        onAnswer={(questionId, answers) => action({ type: "graphical.answer", questionId, answers })}
        onCancel={questionId => action({ type: "graphical.cancelQuestion", questionId })} />)}
    </div>
    <QuickCommandPicker commands={session.quickCommands || []} onSelect={runQuickCommand}
      disabled={command => !snapshot?.threadId || !!snapshot.archived || (command.mode !== "write" && sending)
        || (command.mode === "auto-enter" && !!snapshot.busy && snapshot.provider !== "codex")} />
    <form className="graphical-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      {attachments.length > 0 && <div className="graphical-attachments">{attachments.map(item => <div key={item.key}>
        <span>{item.file.name} · {item.status === "uploading" ? "上传中" : item.status === "failed" ? "上传失败" : "已上传"}</span>
        {item.status === "failed" && <button type="button" onClick={() => { setAttachments(current => current.map(value => value.key === item.key ? { ...value, status: "uploading" } : value)); void uploadFile(item.file, item.key); }}>重试</button>}
        <button type="button" disabled={sending} onClick={() => removeAttachment(item.key)}>移除</button>
      </div>)}</div>}
      <input ref={fileInputRef} className="graphical-file-input" aria-label="添加文件" type="file" multiple
        disabled={addFileDisabled} onChange={event => { addFiles(event.target.files); event.target.value = ""; }} />
      <div className={`graphical-input-border${snapshot.busy ? " is-running" : ""}`} data-mode={effectivePlan ? "plan" : "default"}>
        <div className="graphical-input-row">
          <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder={snapshot.archived ? "已归档的对话不可发送" : "输入消息"}
            disabled={!snapshot.threadId || snapshot.archived || (snapshot.busy && snapshot.provider !== "codex")} />
          {snapshot.busy && <button type="button" onClick={() => action({ type: "graphical.interrupt" })}>停止</button>}
          <button type="submit" className="primary" disabled={sending || (!draft.trim() && !attachments.length) || attachments.some(item => item.status !== "ready") || !snapshot.threadId || snapshot.archived || (snapshot.busy && snapshot.provider !== "codex")}>发送</button>
        </div>
      </div>
    </form>
    {activeSheet && <div className="graphical-sheet-backdrop" onClick={() => setActiveSheet(null)}>
      <div ref={sheetRef} className="graphical-sheet" role="dialog" aria-modal="true"
        aria-label={activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型" : "历史对话"}
        tabIndex={-1} onClick={event => event.stopPropagation()}>
        <header><strong>{activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型" : "历史对话"}</strong>
          <button type="button" className="graphical-sheet-close" aria-label="关闭弹层" onClick={() => setActiveSheet(null)}>×</button></header>
        {error && <p className="graphical-sheet-error" role="alert">{error}</p>}
        {activeSheet === "menu" && <div className="graphical-sheet-list">
          <div className="graphical-menu-mode" role="group" aria-label="会话模式">
            <span>会话模式</span>
            <div className="graphical-mode-switch">
              <button type="button" aria-pressed={effectivePlan}
                disabled={snapshot.busy || snapshot.archived || changingMode || !canSwitchMode(snapshot, "plan")}
                onClick={() => changeMode("plan")}>Plan</button>
              <button type="button" aria-pressed={snapshot.mode === "default"}
                disabled={snapshot.busy || snapshot.archived || changingMode || !canSwitchMode(snapshot, "default")}
                onClick={() => changeMode("default")}>Exec</button>
            </div>
          </div>
          <button type="button" disabled={modelDisabled} onClick={() => setActiveSheet("model")}><span>切换模型</span><small>{modelLabel(snapshot)}</small></button>
          <button type="button" disabled={agentDisabled} onClick={() => setActiveSheet("agent")}><span>切换 Agent</span><small>{providerLabel(snapshot.provider)}</small></button>
          <button type="button" disabled={snapshot.busy || snapshot.capabilities?.history === false} onClick={openHistory}><span>历史记录</span><small>查看并恢复对话</small></button>
          <button type="button" disabled={snapshot.busy} onClick={() => { if (action({ type: "graphical.new-thread" })) setActiveSheet(null); }}><span>新对话</span></button>
          <button type="button" disabled={addFileDisabled} onClick={() => { setActiveSheet(null); fileInputRef.current?.click(); }}><span>添加文件</span><small>{attachments.length}/10</small></button>
        </div>}
        {activeSheet === "agent" && <div className="graphical-sheet-list">
          {graphicalProviders.map(provider => <button type="button" key={provider} disabled={agentDisabled || provider === snapshot.provider}
            aria-pressed={provider === snapshot.provider} onClick={() => { setSelectedProvider(provider); setActiveSheet("agent-confirm"); }}>
            <span>{providerLabel(provider)}</span>{provider === snapshot.provider && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "agent-confirm" && selectedProvider && <div className="graphical-sheet-confirm">
          <p>切换到 {providerLabel(selectedProvider)} 会关闭当前运行会话并启动新会话，是否继续？</p>
          <div><button type="button" onClick={() => setActiveSheet("agent")}>返回</button>
            <button type="button" className="primary" disabled={agentDisabled} onClick={() => switchAgent(selectedProvider)}>确认切换</button></div>
        </div>}
        {activeSheet === "model" && <div className="graphical-sheet-list">
          {modelOptions(snapshot).map(option => <button type="button" key={option.value} disabled={modelDisabled || option.value === currentModel}
            aria-pressed={option.value === currentModel} onClick={() => changeModel(option.value)}>
            <span>{option.name}</span>{option.value === currentModel && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "history" && <div className="graphical-sheet-list graphical-history-list">
          {history?.data.map(thread => <button type="button" key={thread.id} disabled={snapshot.busy || thread.archived || thread.id === snapshot.threadId}
            onClick={() => { if (action({ type: "graphical.resume", targetThreadId: thread.id })) setActiveSheet(null); }}>
            <span>{thread.title}</span><small>{new Date(thread.updatedAt * 1000).toLocaleString()}{thread.archived ? " · 已归档" : ""}</small>
          </button>)}
          {historyLoading && <p role="status">正在加载…</p>}
          {!historyLoading && history?.data.length === 0 && <p>暂无历史对话</p>}
          {history?.nextCursor && <button type="button" disabled={historyLoading} onClick={() => loadHistory(history.nextCursor)}>加载更多</button>}
        </div>}
      </div>
    </div>}
  </section>;
}
