import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createRequestId } from "./protocol";
import { GraphicalUsage } from "./GraphicalUsage";
import { GraphicalIcon } from "./GraphicalIcon";
import { GraphicalQuestionCard } from "./GraphicalQuestionCard";
import { canSwitchMode, effortLabel, groupTimeline, modelLabel, modelOptions, permissionLabel, providerLabel, ToolItem, toolStatus } from "./GraphicalPresentation";
import { QuickCommandPicker } from "./QuickCommandPicker";
import { PROTOCOL_VERSION, type AgentProvider, type ClientMessage, type GraphicalSnapshot,
  type GraphicalHistory, type QuickCommand, type RuntimeSession, type ServerMessage } from "./types";

type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "command.ok" | "error" }>;
type Props = {
  session: RuntimeSession;
  connectionEpoch: number;
  send: (message: ClientMessage) => boolean;
  onGraphicalMessage: (listener: (message: GraphicalMessage) => void) => () => void;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  submissionPending: boolean;
  onSubmitRequest: (requestId: string) => void;
};

const graphicalProviders: AgentProvider[] = ["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"];
type ActionSheet = "menu" | "agent" | "agent-confirm" | "model" | "history" | "permission" | "native-mode" | null;
const permissions = [
  { value: "readOnly", name: "只读", description: "可检查文件，不能修改或申请扩权" },
  { value: "askApproval", name: "需要确认", description: "可修改工作区，越界操作先确认" },
  { value: "fullAccess", name: "完全访问", description: "可访问文件与网络，不再请求批准" }
] as const;
function openCodePlanReplyId(snapshot: GraphicalSnapshot) {
  if (snapshot.provider !== "opencode" || snapshot.nativeMode !== "plan" || snapshot.busy || snapshot.archived
    || snapshot.error || snapshot.pendingPlan || !snapshot.threadId
    || !snapshot.nativeModes?.some(mode => mode.id.toLowerCase() === "build")) return null;
  const lastUserIndex = snapshot.items.map(item => item.type).lastIndexOf("userMessage");
  if (lastUserIndex < 0) return null;
  const reply = snapshot.items.slice(lastUserIndex + 1);
  if (reply.some(item => item.type === "turnError")) return null;
  return reply.filter(item => item.type === "agentMessage" && Boolean(item.text?.trim())
    || item.type === "turnPlan" && Boolean(item.plan?.length)).at(-1)?.id || null;
}
export function GraphicalView({ session, connectionEpoch, send, onGraphicalMessage, draft, setDraft, submissionPending, onSubmitRequest }: Props) {
  const [snapshot, setSnapshot] = useState<GraphicalSnapshot | null>(null);
  const [sending, setSending] = useState(false);
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;
  const isSending = sending || submissionPending;
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
  const subscribedEpochRef = useRef(0);
  const [switchingTo, setSwitchingTo] = useState<AgentProvider | null>(null);
  const threadRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

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
        if (submitIdRef.current === message.requestId) { setAttachments([]); setSending(false); submitIdRef.current = null; }
        if (quickIdRef.current === message.requestId) {
          const quickDraft = quickDraftRef.current;
          if (quickDraft) setDraftRef.current(current => current + quickDraft);
          quickDraftRef.current = "";
          quickIdRef.current = null;
          setSending(false);
        }
        if (modeIdRef.current === message.requestId) {
          setChangingMode(false); modeIdRef.current = null;
          setActiveSheet(current => current === "permission" || current === "native-mode" ? null : current);
        }
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

  useEffect(() => {
    if (!connectionEpoch) return;
    if (subscribedEpochRef.current && subscribedEpochRef.current !== connectionEpoch) {
      if (pendingRef.current.size || uploadRequests.current.size) setError("连接中断，操作结果未确认；请核对会话内容后再重试。");
      pendingRef.current.clear();
      submitIdRef.current = null;
      quickIdRef.current = null;
      quickDraftRef.current = "";
      modeIdRef.current = null;
      modelIdRef.current = null;
      switchIdRef.current = null;
      historyIdRef.current = null;
      setSending(false);
      setChangingMode(false);
      setChangingModel(false);
      setSwitchingTo(null);
      setHistoryLoading(false);
      for (const item of attachmentsRef.current) cancelledUploads.current.add(item.key);
      for (const pending of uploadRequests.current.values()) pending.reject(new Error("连接已断开，请重新上传。"));
      uploadRequests.current.clear();
      setAttachments(current => current.map(item => ({ ...item, fileId: undefined, status: "failed" })));
    }
    subscribedEpochRef.current = connectionEpoch;
    send({ v: PROTOCOL_VERSION, type: "graphical.subscribe", sessionId: session.id });
  }, [connectionEpoch, send, session.id]);

  const lastItem = snapshot?.items.at(-1);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [snapshot?.items.length, lastItem?.text, lastItem?.output]);

  useEffect(() => {
    if (!activeSheet) return;
    sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveSheet(null);
      if (event.key !== "Tab" || !sheetRef.current) return;
      const elements = [...sheetRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
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
    if ((!text && !ready.length) || attachments.some(item => item.status !== "ready") || !snapshot?.threadId || isSending) return;
    submitIdRef.current = action({ type: "graphical.submit", text, fileIds: ready.map(item => item.fileId) }) || null;
    if (submitIdRef.current) { onSubmitRequest(submitIdRef.current); setSending(true); }
  };
  const runQuickCommand = (command: QuickCommand) => {
    if (!snapshot?.threadId || snapshot.archived) return false;
    if ((command.mode || "write") === "write") { setDraft(current => current + command.command); return true; }
    if (isSending || quickIdRef.current) return false;
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
    if (!snapshot || snapshot.busy || snapshot.archived || changingMode || snapshot.pendingPlan || !canSwitchMode(snapshot, mode)) return;
    if (snapshot.provider === "codebuddy" ? mode === "plan" ? snapshot.mode === "plan"
      : snapshot.executionPermission === "fullAccess" : snapshot.mode === mode) return;
    modeIdRef.current = action({ type: "graphical.mode", mode }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const changePermission = (permission: typeof permissions[number]["value"]) => {
    if (!snapshot || snapshot.provider !== "codex" || !snapshot.threadId || snapshot.busy || snapshot.archived || changingMode
      || snapshot.capabilities?.permissions === false
      || snapshot.executionPermission === permission || snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(permission)) return;
    setError("");
    modeIdRef.current = action({ type: "graphical.permission", permission }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const changeNativeMode = (modeId: string) => {
    if (!snapshot || snapshot.provider === "codex" || !snapshot.threadId || snapshot.busy || snapshot.archived || changingMode
      || snapshot.nativeMode === modeId || !snapshot.nativeModes?.some(mode => mode.id === modeId)) return;
    setError("");
    modeIdRef.current = action({ type: "graphical.native-mode", modeId }) || null;
    if (modeIdRef.current) setChangingMode(true);
  };
  const executeOpenCodePlan = (itemId: string) => {
    if (!snapshot || changingMode || modeIdRef.current || openCodePlanReplyId(snapshot) !== itemId) return;
    setError("");
    modeIdRef.current = action({ type: "graphical.plan", itemId, execute: true }) || null;
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
  const addFileDisabled = !snapshot.threadId || snapshot.archived || isSending || attachments.length >= 10
    || (snapshot.busy && snapshot.provider !== "codex");
  const modelDisabled = !modelOptions(snapshot).length || snapshot.busy || snapshot.archived || changingModel || attachments.length > 0;
  const agentDisabled = snapshot.busy || Boolean(snapshot.approvals.length || snapshot.questions.length || snapshot.pendingPlan || switchingTo);
  const currentModel = snapshot.provider === "codex" ? snapshot.model || snapshot.effectiveModel || ""
    : String(snapshot.acpOptions?.find(option => option.id === "model")?.currentValue || "");
  const effectivePlan = snapshot.mode === "plan";
  const openCodePlanItemId = openCodePlanReplyId(snapshot);
  const openCodeBuildMode = snapshot.nativeModes?.find(mode => mode.id.toLowerCase() === "build");
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
        aria-expanded={Boolean(activeSheet)} onClick={() => setActiveSheet("menu")}><GraphicalIcon name="more" /></button>
    </header>
    <GraphicalUsage sessionId={session.id} sessionType={session.type} snapshot={snapshot} send={send} onGraphicalMessage={onGraphicalMessage} />
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
              <span className="graphical-tool-group-chevron"><GraphicalIcon name="chevron" /></span>
              <strong>工具调用 · {entry.items.length} 项</strong><span>{status}</span>
            </button>
            {expanded && <div className="graphical-tool-list">{entry.items.map(item => <ToolItem item={item} codeBuddy={snapshot.provider === "codebuddy"} key={item.id} />)}</div>}
          </section>;
        }
        const item = entry.item;
        if (item.type === "userMessage" || item.type === "agentMessage")
          return <article className={`graphical-message ${item.type}`} key={item.id}><small>{item.type === "userMessage" ? "你" : providerLabel(snapshot.provider)}</small>
            <div className="graphical-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text || ""}</ReactMarkdown></div>
            {item.attachments?.length ? <div className="graphical-attachment-history">{item.attachments.map((file, index) => <span key={index}>📎 {file.name}</span>)}</div> : null}
            {openCodePlanItemId === item.id && openCodeBuildMode && <div className="graphical-actions">
              <button type="button" className="primary" disabled={changingMode} onClick={() => executeOpenCodePlan(item.id)}>执行计划</button>
            </div>}</article>;
        if (item.type === "questionAnswer") return <article className="graphical-card" key={item.id}><strong>已回答问题</strong>{item.questions?.map(value => <p key={value.id}>{value.question}：{value.answers.join("、")}</p>)}</article>;
        if (item.type === "plan" || item.type === "turnPlan") return <article className="graphical-card" key={item.id}><strong>计划</strong><p>{item.text}</p>{item.plan?.map((step, index) => <p key={index}>{step.status === "completed" ? "✓" : "•"} {step.step}</p>)}
          {openCodePlanItemId === item.id && openCodeBuildMode && <div className="graphical-actions">
            <button type="button" className="primary" disabled={changingMode} onClick={() => executeOpenCodePlan(item.id)}>执行计划</button>
          </div>}</article>;
        if (item.type === "turnError") return <article className="graphical-card" role="alert" key={item.id}><strong>运行错误</strong><p>{item.text}</p></article>;
        return <article className="graphical-card" key={item.id}><strong>后台任务汇总</strong></article>;
      })}
      {snapshot.provider === "codex" && snapshot.diagnostics?.map(event => <details className="graphical-card graphical-diagnostic" key={event.id}>
        <summary><strong>运行错误</strong>{event.message}</summary>
        {(event.kind || event.httpStatusCode) && <p>{event.kind || "Codex 错误"}{event.httpStatusCode ? ` · HTTP ${event.httpStatusCode}` : ""}</p>}
        {event.additionalDetails != null && <pre>{typeof event.additionalDetails === "string" ? event.additionalDetails : JSON.stringify(event.additionalDetails, null, 2)}</pre>}
      </details>)}
      {snapshot.pendingPlan && <article className="graphical-card"><strong>确认执行计划</strong><div className="graphical-actions">
        <button type="button" onClick={() => action({ type: "graphical.plan", itemId: snapshot.pendingPlan!.itemId, execute: false })}><GraphicalIcon name="back" />{snapshot.provider === "codebuddy" ? "继续修改" : "暂不执行"}</button>
        <button type="button" className="primary" onClick={() => action({ type: "graphical.plan", itemId: snapshot.pendingPlan!.itemId, execute: true })}><GraphicalIcon name="check" />执行计划</button>
      </div></article>}
      {snapshot.approvals.map(approval => <article className="graphical-card" key={approval.requestId}>
        <strong>{approval.params.networkApprovalContext ? "网络访问确认" : approval.method.includes("fileChange") ? "文件修改确认" : "操作确认"}</strong>
        <p>{approval.params.reason || approval.params.command || approval.method}</p>
        {approval.params.cwd && <small>{approval.params.cwd}</small>}
        {approval.params.networkApprovalContext && <p>{approval.params.networkApprovalContext.protocol}://{approval.params.networkApprovalContext.host}{approval.params.networkApprovalContext.port ? `:${approval.params.networkApprovalContext.port}` : ""}</p>}
        {approval.params.changes != null && <pre>{JSON.stringify(approval.params.changes, null, 2)}</pre>}
        {approval.params.choices?.length ? <div className="graphical-actions">{approval.params.choices.map(choice =>
          <button type="button" key={choice.id} onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: choice.id })}>{choice.label}</button>)}</div>
          : <div className="graphical-actions"><button type="button" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: false })}><GraphicalIcon name="close" />拒绝</button>
            <button type="button" className="primary" onClick={() => action({ type: "graphical.approval", approvalId: approval.requestId, decision: true })}><GraphicalIcon name="check" />批准一次</button></div>}
      </article>)}
      {snapshot.questions.map(question => <GraphicalQuestionCard key={question.requestId} question={question} provider={snapshot.provider}
        onAnswer={(questionId, answers) => action({ type: "graphical.answer", questionId, answers })}
        onCancel={questionId => action({ type: "graphical.cancelQuestion", questionId })} />)}
    </div>
    <QuickCommandPicker commands={session.quickCommands || []} onSelect={runQuickCommand}
      disabled={command => !snapshot?.threadId || !!snapshot.archived || (command.mode !== "write" && isSending)
        || (command.mode === "auto-enter" && !!snapshot.busy && snapshot.provider !== "codex")} />
    <form className="graphical-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      {attachments.length > 0 && <div className="graphical-attachments">{attachments.map(item => <div key={item.key}>
        <span>{item.file.name} · {item.status === "uploading" ? "上传中" : item.status === "failed" ? "上传失败" : "已上传"}</span>
        {item.status === "failed" && <button type="button" className="graphical-icon-button" aria-label={`重试上传 ${item.file.name}`} title="重试上传" onClick={() => { setAttachments(current => current.map(value => value.key === item.key ? { ...value, status: "uploading" } : value)); void uploadFile(item.file, item.key); }}><GraphicalIcon name="retry" /></button>}
        <button type="button" className="graphical-icon-button" aria-label={`移除附件 ${item.file.name}`} title="移除附件" disabled={isSending} onClick={() => removeAttachment(item.key)}><GraphicalIcon name="remove" /></button>
      </div>)}</div>}
      <div className={`graphical-input-border${snapshot.busy ? " is-running" : ""}`} data-mode={effectivePlan ? "plan" : "default"}>
        <div className="graphical-input-row">
          <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder={snapshot.archived ? "已归档的对话不可发送" : "输入消息"}
            disabled={!snapshot.threadId || snapshot.archived || (snapshot.busy && snapshot.provider !== "codex")} />
          {snapshot.busy && <button type="button" className="graphical-icon-button" aria-label="停止" title="停止" onClick={() => action({ type: "graphical.interrupt" })}><GraphicalIcon name="stop" /></button>}
          <button type="submit" className="primary graphical-icon-button" aria-label="发送" title="发送" disabled={isSending || (!draft.trim() && !attachments.length) || attachments.some(item => item.status !== "ready") || !snapshot.threadId || snapshot.archived || (snapshot.busy && snapshot.provider !== "codex")}><GraphicalIcon name="send" /></button>
        </div>
      </div>
    </form>
    {activeSheet && <div className="graphical-sheet-backdrop" onClick={() => setActiveSheet(null)}>
      <div ref={sheetRef} className="graphical-sheet" role="dialog" aria-modal="true"
        aria-label={activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型"
            : activeSheet === "permission" ? "执行权限" : activeSheet === "native-mode" ? "切换模式" : "历史对话"}
        tabIndex={-1} onClick={event => event.stopPropagation()}>
        <header><strong>{activeSheet === "menu" ? "更多操作" : activeSheet === "agent" ? "切换 Agent"
          : activeSheet === "agent-confirm" ? "确认切换 Agent" : activeSheet === "model" ? "切换模型"
            : activeSheet === "permission" ? "执行权限" : activeSheet === "native-mode" ? "切换模式" : "历史对话"}</strong>
          <button type="button" className="graphical-sheet-close" aria-label="关闭弹层" onClick={() => setActiveSheet(null)}><GraphicalIcon name="close" /></button></header>
        {error && <p className="graphical-sheet-error" role="alert">{error}</p>}
        {activeSheet === "menu" && <div className="graphical-sheet-list">
          {(snapshot.provider === "codex" || snapshot.provider === "codebuddy" || snapshot.provider === "claude") && <div className="graphical-menu-mode" role="group" aria-label="会话模式">
            <span>会话模式</span>
            <div className="graphical-mode-switch">
              <button type="button" aria-pressed={effectivePlan}
                disabled={snapshot.busy || snapshot.archived || changingMode || !!snapshot.pendingPlan || !canSwitchMode(snapshot, "plan")}
                onClick={() => changeMode("plan")}><GraphicalIcon name="mode" />Plan</button>
              <button type="button" aria-pressed={snapshot.provider === "codebuddy" ? snapshot.executionPermission === "fullAccess" : snapshot.mode === "default"}
                disabled={snapshot.busy || snapshot.archived || changingMode || !!snapshot.pendingPlan || !canSwitchMode(snapshot, "default")}
                onClick={() => changeMode("default")}><GraphicalIcon name="mode" />{snapshot.provider === "codebuddy" ? "Full Access" : "Exec"}</button>
            </div>
          </div>}
          {snapshot.provider === "codex"
            ? <button type="button" disabled={!snapshot.threadId || snapshot.busy || snapshot.archived || changingMode || snapshot.capabilities?.permissions === false}
              onClick={() => { setError(""); setActiveSheet("permission"); }}><span><GraphicalIcon name="shield" />执行权限</span><small>{permissionLabel(snapshot.executionPermission) || "未提供"}</small></button>
            : snapshot.nativeModes?.length ? <button type="button" disabled={!snapshot.threadId || snapshot.busy || snapshot.archived || changingMode}
              onClick={() => { setError(""); setActiveSheet("native-mode"); }}><span><GraphicalIcon name="mode" />切换模式</span><small>{snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "未提供"}</small></button> : null}
          <button type="button" disabled={modelDisabled} onClick={() => setActiveSheet("model")}><span><GraphicalIcon name="model" />切换模型</span><small>{modelLabel(snapshot)}</small></button>
          <button type="button" disabled={agentDisabled} onClick={() => setActiveSheet("agent")}><span><GraphicalIcon name="agent" />切换 Agent</span><small>{providerLabel(snapshot.provider)}</small></button>
          <button type="button" disabled={snapshot.busy || snapshot.capabilities?.history === false} onClick={openHistory}><span><GraphicalIcon name="history" />历史记录</span><small>查看并恢复对话</small></button>
          <button type="button" disabled={snapshot.busy} onClick={() => { if (action({ type: "graphical.new-thread" })) setActiveSheet(null); }}><span><GraphicalIcon name="new" />新对话</span></button>
          <label className={`graphical-file-picker${addFileDisabled ? " is-disabled" : ""}`}>
            <span><GraphicalIcon name="file" />添加文件</span><small>{attachments.length}/10</small>
            <input aria-label="添加文件" type="file" multiple disabled={addFileDisabled}
              onChange={event => {
                if (event.currentTarget.files?.length) {
                  addFiles(event.currentTarget.files);
                  setActiveSheet(null);
                }
                event.currentTarget.value = "";
              }} />
          </label>
        </div>}
        {activeSheet === "agent" && <div className="graphical-sheet-list">
          {graphicalProviders.filter(provider => session.type !== "ssh" || provider !== "gemini" && provider !== "grok").map(provider => <button type="button" key={provider} disabled={agentDisabled || provider === snapshot.provider}
            aria-pressed={provider === snapshot.provider} onClick={() => { setSelectedProvider(provider); setActiveSheet("agent-confirm"); }}>
            <span>{providerLabel(provider)}</span>{provider === snapshot.provider && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "agent-confirm" && selectedProvider && <div className="graphical-sheet-confirm">
          <p>切换到 {providerLabel(selectedProvider)} 会关闭当前运行会话并启动新会话，是否继续？</p>
          <div><button type="button" onClick={() => setActiveSheet("agent")}><GraphicalIcon name="back" />返回</button>
            <button type="button" className="primary" disabled={agentDisabled} onClick={() => switchAgent(selectedProvider)}><GraphicalIcon name="check" />确认切换</button></div>
        </div>}
        {activeSheet === "model" && <div className="graphical-sheet-list">
          {modelOptions(snapshot).map(option => <button type="button" key={option.value} disabled={modelDisabled || option.value === currentModel}
            aria-pressed={option.value === currentModel} onClick={() => changeModel(option.value)}>
            <span>{option.name}</span>{option.value === currentModel && <small>当前使用</small>}
          </button>)}
        </div>}
        {activeSheet === "permission" && <div className="graphical-sheet-list">
          {permissions.map(option => <button type="button" key={option.value} aria-pressed={snapshot.executionPermission === option.value}
            disabled={changingMode || snapshot.busy || snapshot.archived || snapshot.executionPermission === option.value
              || Boolean(snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(option.value))}
            onClick={() => changePermission(option.value)}><span>{option.name}</span><small>{option.description}</small></button>)}
        </div>}
        {activeSheet === "native-mode" && <div className="graphical-sheet-list">
          {snapshot.nativeModes?.map(mode => <button type="button" key={mode.id} aria-pressed={snapshot.nativeMode === mode.id}
            disabled={changingMode || snapshot.busy || snapshot.archived || snapshot.nativeMode === mode.id}
            onClick={() => changeNativeMode(mode.id)}><span>{mode.name || mode.id}</span>{snapshot.nativeMode === mode.id && <small>当前使用</small>}</button>)}
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
