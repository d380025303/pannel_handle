import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ArrowUp, Ellipsis, FileText, History, Image as ImageIcon, Paperclip, Plus, Sparkles, Square, X } from "lucide-react";
import type { CodexAppServerHistory, CodexAppServerSnapshot, CodexExecutionPermission, CodexQuestionRequest, CodexQuestionAnswer, QuickCommand } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";

const empty: CodexAppServerSnapshot = { threadId: null, mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
const permissionLabels: Record<CodexExecutionPermission, string> = { readOnly: "只读", askApproval: "需要确认", fullAccess: "完全访问" };
const permissionDescriptions: Record<CodexExecutionPermission, string> = {
  readOnly: "可检查文件，不能修改或申请扩权",
  askApproval: "可修改工作区，越界操作先确认",
  fullAccess: "可访问文件与网络，不再请求批准"
};
const effortLabels: Record<string, string> = {
  none: "无", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极致"
};
const effortLabel = (effort: string) => effortLabels[effort] || effort;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusLabels: Record<string, string> = { completed: "已完成", inProgress: "进行中", pending: "待处理", failed: "失败", declined: "已拒绝" };
const statusLabel = (status?: string) => statusLabels[status || ""] || status || "进行中";
type SessionItem = CodexAppServerSnapshot["items"][number];
type DisplayItem = { kind: "item"; item: SessionItem } | { kind: "tools"; items: SessionItem[] };
type AttachmentPreview = Awaited<ReturnType<typeof window.codexAppServerApi.previewAttachment>>;
const imageFile = (name: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;

function AttachmentTile({ sessionId, file, onPreview, onRemove, disabled }: {
  sessionId: string; file: { path: string; name: string }; onPreview: () => void;
  onRemove?: () => void; disabled?: boolean;
}) {
  const [thumbnail, setThumbnail] = useState("");
  useEffect(() => {
    if (!imageFile(file.name)) return;
    let active = true;
    void window.codexAppServerApi.previewAttachment(sessionId, file.path).then(result => {
      if (active && result.kind === "image") setThumbnail(result.dataUrl);
    }).catch(() => {});
    return () => { active = false; };
  }, [sessionId, file.path, file.name]);
  return <div className="codex-app-server-attachment-tile">
    <button type="button" className="codex-app-server-attachment-open" title={file.name} aria-label={`预览 ${file.name}`} onClick={onPreview}>
      {thumbnail ? <img src={thumbnail} alt="" /> : imageFile(file.name) ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
      <span>{file.name}</span>
    </button>
    {onRemove && <button type="button" className="codex-app-server-attachment-remove" disabled={disabled} aria-label={`移除 ${file.name}`} onClick={onRemove}><X aria-hidden="true" /></button>}
  </div>;
}

function QuestionCard({ sessionId, request }: { sessionId: string; request: CodexQuestionRequest }) {
  const tabId = useId();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const questions = request.params.questions || [];
  const hasAnswer = (question: typeof questions[number]) => {
    const choice = choices[question.id];
    const note = notes[question.id]?.trim();
    return Boolean((choice || note) && (!question.options?.length || choice || question.isOther));
  };
  async function answer() {
    if (sending || request.submitting) return;
    const answers: Record<string, CodexQuestionAnswer> = {};
    for (const [index, question] of questions.entries()) {
      const choice = choices[question.id];
      const note = notes[question.id]?.trim();
      if (!choice && !note) { setActiveIndex(index); setError(`请回答「${question.header || question.question}」。`); return; }
      if (question.options?.length && !choice && !question.isOther) {
        setActiveIndex(index); setError(`请选择「${question.header || question.question}」的选项。`); return;
      }
      answers[question.id] = { answers: [...(choice ? [choice] : []), ...(note ? [`user_note: ${note}`] : [])] };
    }
    setSending(true); setError("");
    try { await window.codexAppServerApi.answerQuestion(sessionId, request.requestId, answers); }
    catch (cause) { setError(message(cause)); }
    finally { setSending(false); }
  }
  return <article className="codex-app-server-question" aria-label="Codex 提问">
    <strong>Codex 提问</strong>
    {questions.length > 1 && <div className="codex-app-server-question-tabs" role="tablist" aria-label="切换问题">
      {questions.map((question, index) => <button key={question.id} type="button" role="tab"
        id={`${tabId}-tab-${index}`} aria-controls={`${tabId}-panel`} aria-selected={index === activeIndex}
        onClick={() => { setActiveIndex(index); setError(""); }}>
        <span>{index + 1}. {question.header || "问题"}</span>
        <small>{hasAnswer(question) ? "已回答" : "待回答"}</small>
      </button>)}
    </div>}
    {questions.slice(activeIndex, activeIndex + 1).map(question => <fieldset key={question.id} role={questions.length > 1 ? "tabpanel" : undefined}
      id={questions.length > 1 ? `${tabId}-panel` : undefined}
      aria-labelledby={questions.length > 1 ? `${tabId}-tab-${activeIndex}` : undefined}>
      <legend><span>{question.header}</span>{question.question}</legend>
      {question.options?.map(option => <label className="codex-app-server-question-option" key={option.label}>
        <input type="radio" name={`question-${request.requestId}-${question.id}`} value={option.label}
          checked={choices[question.id] === option.label} disabled={sending || request.submitting}
          onChange={() => { setChoices(current => ({ ...current, [question.id]: option.label })); setError(""); }} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>)}
      <label className="codex-app-server-question-note">
        <span>{question.options?.length ? "补充说明或自定义回答" : "回答"}</span>
        {question.isSecret ? <input type="password" value={notes[question.id] || ""} disabled={sending || request.submitting}
          onChange={event => { setNotes(current => ({ ...current, [question.id]: event.target.value })); setError(""); }} />
          : <textarea value={notes[question.id] || ""} disabled={sending || request.submitting}
            onChange={event => { setNotes(current => ({ ...current, [question.id]: event.target.value })); setError(""); }} />}
      </label>
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={sending || request.submitting || !questions.length} onClick={() => void answer()}>
      {sending || request.submitting ? "正在提交…" : "提交回答"}
    </button>
  </article>;
}

function groupTools(items: SessionItem[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  const isTool = (item: SessionItem) => item.type === "commandExecution" || item.type === "fileChange";
  const isHidden = (item: SessionItem) => !isTool(item) && !["userMessage", "agentMessage", "plan", "turnPlan", "questionAnswer"].includes(item.type);
  const sameTurn = (first: SessionItem, second: SessionItem) => !first.turnId || !second.turnId || first.turnId === second.turnId;
  for (const item of items) {
    if (isHidden(item)) continue;
    const previous = result.at(-1);
    if (isTool(item)) {
      if (previous?.kind === "tools" && sameTurn(previous.items[0], item)) previous.items.push(item);
      else result.push({ kind: "tools", items: [item] });
    } else result.push({ kind: "item", item });
  }
  return result;
}

function ToolGroup({ items }: { items: SessionItem[] }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="codex-app-server-event">
    <button type="button" className="codex-app-server-event-summary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <strong>工具调用 · {items.length} 项</strong><span>{toolGroupStatus(items)}</span>
    </button>
    {expanded && items.map(item => <div className="codex-app-server-tool" key={item.id}>
      <div className="codex-app-server-tool-heading"><strong>{item.type === "commandExecution" ? "执行命令" : "修改文件"}</strong><span>{statusLabel(item.status)}</span></div>
      {item.type === "commandExecution" ? <><pre>{item.command}</pre>{item.output && <pre>{item.output}</pre>}</>
        : <pre>{JSON.stringify(item.changes, null, 2)}</pre>}
    </div>)}
  </section>;
}

function toolGroupStatus(items: SessionItem[]) {
  if (items.every(item => item.status === "completed")) return "已完成";
  if (items.some(item => item.status === "inProgress" || item.status === "pending" || !item.status)) return "进行中";
  if (items.some(item => item.status === "failed" || item.status === "declined")) return "有失败";
  return "进行中";
}

export type CodexAppServerSessionHandle = { applyQuickCommand: (command: QuickCommand) => Promise<boolean> };

type CodexAppServerSessionProps = {
  sessionId: string;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  onLinkClick?: (href: string) => void;
};

export const CodexAppServerSession = forwardRef<CodexAppServerSessionHandle, CodexAppServerSessionProps>(function CodexAppServerSession({ sessionId, draft, setDraft, onLinkClick }, ref) {
  const [snapshot, setSnapshot] = useState<CodexAppServerSnapshot>(empty);
  const [error, setError] = useState("");
  const [dismissedSnapshotError, setDismissedSnapshotError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [pastingImage, setPastingImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const [changingPermission, setChangingPermission] = useState(false);
  const [resolvingPlan, setResolvingPlan] = useState(false);
  const [history, setHistory] = useState<CodexAppServerHistory[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [resumingHistory, setResumingHistory] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const historyRequestRef = useRef(0);
  const currentSessionRef = useRef(sessionId);
  const loadedSessionIdRef = useRef<string | null>(null);
  const pastedImagesRef = useRef(new Set<string>());
  const pastingRef = useRef(false);
  const changingModeRef = useRef(false);
  const changingModelRef = useRef(false);
  const changingPermissionRef = useRef(false);
  const resolvingPlanRef = useRef(false);
  currentSessionRef.current = sessionId;

  useImperativeHandle(ref, () => ({
    async applyQuickCommand(command) {
      if (loadedSessionIdRef.current !== sessionId || !snapshot.threadId) return false;
      if (command.mode !== "auto-enter") {
        setDraft(current => current + command.command);
        textareaRef.current?.focus();
        return true;
      }
      if ((snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null) || sending || pastingImage) return false;
      setSending(true); setError("");
      try {
        await window.codexAppServerApi.submit(sessionId, command.command, []);
        return true;
      } catch (cause) {
        if (currentSessionRef.current === sessionId) setError(message(cause));
        return false;
      } finally {
        if (currentSessionRef.current === sessionId) setSending(false);
      }
    }
  }));

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    loadedSessionIdRef.current = null;
    setSnapshot(empty);
    setError("");
    setDismissedSnapshotError(null);
    setAttachments([]);
    setPreviewFile(null);
    setSending(false);
    setChangingMode(false);
    setChangingModel(false);
    setChangingPermission(false);
    setResolvingPlan(false);
    changingModeRef.current = false;
    changingModelRef.current = false;
    changingPermissionRef.current = false;
    resolvingPlanRef.current = false;
    pastedImagesRef.current.clear();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryOpen(false);
    setMenuOpen(false);
    setHistoryQuery("");
    setHistoryError("");
    setLoadingHistory(false);
    setResumingHistory(false);
    historyRequestRef.current += 1;
    void window.codexAppServerApi.snapshot(sessionId).then(value => { if (active && !receivedChange) { loadedSessionIdRef.current = sessionId; setSnapshot(value); } })
      .catch(cause => { if (active) setError(message(cause)); });
    const off = window.codexAppServerApi.onChanged(payload => {
      if (active && payload.id === sessionId) { receivedChange = true; loadedSessionIdRef.current = sessionId; setSnapshot(payload.snapshot); }
    });
    return () => { active = false; off(); };
  }, [sessionId]);
  useEffect(() => {
    if (!snapshot.error) setDismissedSnapshotError(null);
  }, [snapshot.error]);
  useLayoutEffect(() => {
    const messages = messagesRef.current;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }, [snapshot.items, snapshot.approvals.length, snapshot.questions?.length, snapshot.pendingPlan, error, snapshot.error]);
  useEffect(() => {
    if (!previewFile) return;
    let active = true;
    setPreview(null); setPreviewError("");
    void window.codexAppServerApi.previewAttachment(sessionId, previewFile.path).then(result => {
      if (active) setPreview(result);
    }).catch(cause => { if (active) setPreviewError(message(cause)); });
    return () => { active = false; };
  }, [sessionId, previewFile]);
  useEffect(() => {
    if (!historyOpen) return;
    const timer = window.setTimeout(() => void loadHistory(null, historyQuery), historyQuery.trim() ? 150 : 0);
    return () => { window.clearTimeout(timer); historyRequestRef.current += 1; };
  }, [historyOpen, historyQuery, sessionId]);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  async function submit() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null)
      || sending || pastingRef.current) return;
    setSending(true);
    setDraft(""); setError("");
    try { await window.codexAppServerApi.submit(sessionId, text, attachments); if (currentSessionRef.current === sessionId) { setAttachments([]); pastedImagesRef.current.clear(); } }
    catch (cause) {
      setDraft(current => current || text);
      if (currentSessionRef.current === sessionId) setError(message(cause));
    }
    finally { if (currentSessionRef.current === sessionId) setSending(false); }
  }
  async function loadHistory(cursor: string | null = null, query = "") {
    const requestId = ++historyRequestRef.current;
    const searching = Boolean(query.trim());
    setLoadingHistory(true); setHistoryError("");
    if (!cursor) { setHistory([]); setHistoryCursor(null); }
    try {
      const seenCursors = new Set<string>();
      let nextCursor = cursor;
      do {
        const page = await window.codexAppServerApi.listHistory(sessionId, nextCursor);
        if (currentSessionRef.current !== sessionId || historyRequestRef.current !== requestId) return;
        const append = Boolean(nextCursor);
        setHistory(current => append ? [...current, ...page.data] : page.data);
        setHistoryCursor(page.nextCursor);
        nextCursor = page.nextCursor;
        if (!searching || !nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
      } while (true);
    } catch (cause) {
      if (currentSessionRef.current === sessionId && historyRequestRef.current === requestId) setHistoryError(message(cause));
    } finally {
      if (currentSessionRef.current === sessionId && historyRequestRef.current === requestId) setLoadingHistory(false);
    }
  }
  function closeHistory() {
    setHistoryOpen(false);
    menuButtonRef.current?.focus();
  }
  async function selectHistory(threadId: string) {
    setResumingHistory(true); setHistoryError("");
    try { const value = await window.codexAppServerApi.resume(sessionId, threadId);
      if (currentSessionRef.current === sessionId) { setSnapshot(value); closeHistory(); setAttachments([]); pastedImagesRef.current.clear(); setDraft(""); } }
    catch (cause) { if (currentSessionRef.current === sessionId) setHistoryError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setResumingHistory(false); }
  }
  async function addFiles() {
    setError("");
    try { const paths = await window.codexAppServerApi.chooseFiles(sessionId);
      if (currentSessionRef.current === sessionId) setAttachments(current => [...new Set([...current, ...paths])].slice(0, 10)); }
    catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
  }
  async function pasteImage() {
    if (pastingRef.current || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null)
      || sending || !snapshot.threadId) return;
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
  async function resolve(requestId: number | string, approved: boolean | string) {
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
  async function changeNativeMode(modeId: string) {
    if (!snapshot.threadId || snapshot.busy || changingModeRef.current || modeId === snapshot.nativeMode) return;
    changingModeRef.current = true;
    setChangingMode(true); setError("");
    try {
      const value = await window.codexAppServerApi.setNativeMode(sessionId, modeId);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally { changingModeRef.current = false; if (currentSessionRef.current === sessionId) setChangingMode(false); }
  }
  async function changePermission(permission: CodexExecutionPermission) {
    if (!snapshot.threadId || snapshot.busy || changingPermissionRef.current || permission === snapshot.executionPermission) return;
    changingPermissionRef.current = true;
    setChangingPermission(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setExecutionPermission(sessionId, permission);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
    } catch (cause) {
      if (currentSessionRef.current === sessionId) setError(message(cause));
    } finally {
      if (currentSessionRef.current === sessionId) {
        changingPermissionRef.current = false;
        setChangingPermission(false);
      }
    }
  }
  async function changeModel(modelId: string) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || modelId === snapshot.model) return;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setModel(sessionId, modelId);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
  }
  async function changeEffort(effort: string) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || attachments.length || effort === snapshot.effort) return;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setEffort(sessionId, effort);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
  }
  async function changeFastMode(enabled: boolean) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || attachments.length || enabled === snapshot.fastMode) return;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setFastMode(sessionId, enabled);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
    } catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
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

  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  const visibleHistory = normalizedHistoryQuery
    ? history.filter(thread => `${thread.title} ${thread.id}`.toLocaleLowerCase().includes(normalizedHistoryQuery))
    : history;

  const agentName = snapshot.provider === "codebuddy" ? "CodeBuddy" : snapshot.provider === "opencode" ? "OpenCode" : "Codex";
  const canSendWhileBusy = agentName === "Codex";
  const acpModel = snapshot.provider === "opencode" ? snapshot.acpOptions?.find(option => option.id === "model" && option.type === "select") : undefined;
  const acpEffort = snapshot.provider === "opencode" ? snapshot.acpOptions?.find(option => option.id === "effort" && option.type === "select") : undefined;
  return <section className="codex-app-server-session" aria-label={`${agentName} 图形会话`}>
    <div ref={messagesRef} className="codex-app-server-messages" aria-live="polite">
      {snapshot.items.length === 0 && !snapshot.busy && <div className="codex-app-server-empty"><span className="codex-app-server-empty-icon"><Sparkles aria-hidden="true" /></span><h2>有什么需要完成？</h2><p>描述你的任务，{agentName} 会在当前项目中协助你。</p><span className="codex-app-server-empty-hint">支持附加文件、粘贴图片与规划模式</span></div>}
      {groupTools(snapshot.items).map(entry => {
        if (entry.kind === "tools") {
          return <ToolGroup key={entry.items[0].id} items={entry.items} />;
        }
        const item = entry.item;
        if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan") return <article className={`codex-app-server-message ${item.type}`} key={item.id}>
          {item.type === "plan" && <strong>计划</strong>}
          {item.type === "userMessage" ? <>{item.text && <p>{item.text}</p>}{Boolean(item.attachments?.length) &&
            <div className="codex-app-server-attachments">{item.attachments?.map(file => <AttachmentTile key={file.path} sessionId={sessionId} file={file} onPreview={() => setPreviewFile(file)} />)}</div>}</>
            : item.text && <MarkdownBlock className="codex-app-server-markdown" content={item.text} externalLinks={!onLinkClick} onLinkClick={onLinkClick} linkActions />}
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
          {snapshot.pendingPlan?.itemId === item.id && <div className="codex-app-server-plan-confirm" role="group" aria-label="确认执行计划">
            <p>计划已完成。确认后将在当前会话中执行。</p>
            <div><button type="button" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, false)}>暂不执行</button>
              <button type="button" className="primary" disabled={resolvingPlan} onClick={() => void resolvePlan(item.id, true)}>执行计划</button></div>
          </div>}
        </article>;
        if (item.type === "questionAnswer") return <article className="codex-app-server-message questionAnswer" key={item.id} aria-label="已回答的 Codex 提问">
          <strong>Codex 提问与回答{item.status === "submitted" ? " · 正在确认" : item.status === "failed" ? " · 轮次失败" : ""}</strong>
          {item.questions?.map(question => <div className="codex-app-server-answered-question" key={question.id}>
            {question.header && <small>{question.header}</small>}
            <p className="codex-app-server-answered-prompt">{question.question}</p>
            {question.answers.map((answer, index) => <p key={index} className="codex-app-server-answered-answer">
              {answer.startsWith("user_note: ") ? `补充说明：${answer.slice(11)}` : answer}
            </p>)}
          </div>)}
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
        <div>{approval.params.choices?.length ? approval.params.choices.map(choice =>
          <button type="button" key={choice.id} onClick={() => void resolve(approval.requestId, choice.id)}>{choice.label}</button>) : <>
          <button type="button" onClick={() => void resolve(approval.requestId, false)}>拒绝</button>
          <button type="button" onClick={() => void resolve(approval.requestId, true)}>批准一次</button></>}</div>
      </article>)}
      {snapshot.questions?.filter(question => !question.submitting || !snapshot.items.some(item => item.id === `question-answer:${question.params.turnId}:${question.requestId}`))
        .map(question => <QuestionCard key={question.requestId} sessionId={sessionId} request={question} />)}
      {(error || (snapshot.error !== dismissedSnapshotError && snapshot.error)) &&
        <div className="codex-app-server-error" role="alert">
          <span>{error || snapshot.error}</span>
          <button type="button" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => {
            setError("");
            setDismissedSnapshotError(snapshot.error);
          }}><X aria-hidden="true" /></button>
        </div>}
    </div>
    <form className="codex-app-server-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {attachments.length > 0 && <div className="codex-app-server-attachments">{attachments.map(filePath => <AttachmentTile key={filePath} sessionId={sessionId}
        file={{ path: filePath, name: fileName(filePath) }} onPreview={() => setPreviewFile({ path: filePath, name: fileName(filePath) })}
        onRemove={() => void removeAttachment(filePath)} disabled={(snapshot.busy && !canSendWhileBusy) || sending || pastingImage} />)}</div>}
      <div className={`codex-app-server-input-border${snapshot.busy ? " is-running" : ""}`} data-mode={snapshot.mode}><textarea ref={textareaRef} value={draft} onChange={event => setDraft(event.target.value)} onPaste={event => {
        if (!Array.from(event.clipboardData.items).some(item => item.type.startsWith("image/"))) return;
        event.preventDefault();
        void pasteImage();
      }} onKeyDown={event => {
        if (snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void changeMode(snapshot.mode === "plan" ? "default" : "plan");
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} placeholder={`向 ${agentName} 发送消息`} disabled={!snapshot.threadId || (snapshot.busy && !canSendWhileBusy)} />
        <div className="codex-app-server-input-actions">
          <div className="codex-app-server-menu-anchor">
            <button ref={menuButtonRef} type="button" className="codex-app-server-icon-button" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menuOpen} disabled={!snapshot.threadId} onClick={() => setMenuOpen(open => !open)}><Ellipsis aria-hidden="true" /></button>
            {menuOpen && <div ref={menuRef} className="codex-app-server-menu" role="menu" aria-label="会话操作" onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); menuButtonRef.current?.focus(); }
              if (event.key === "Tab") setMenuOpen(false);
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
            }}>
              <button type="button" role="menuitem" disabled={snapshot.busy || snapshot.capabilities?.history === false} title={snapshot.capabilities?.history === false ? `当前 ${agentName} CLI 不支持历史会话恢复` : undefined} onClick={() => { setMenuOpen(false); setHistoryQuery(""); setHistoryOpen(true); }}><History aria-hidden="true" />历史会话</button>
              {snapshot.provider === "codebuddy" || snapshot.provider === "opencode" ? <div className="codex-app-server-menu-group" role="group" aria-label={`${agentName} 模式`}>
                <span className="codex-app-server-menu-label" aria-hidden="true">{agentName} 模式</span>
                <div className="codex-app-server-mode-options">
                  {(snapshot.nativeModes || []).map(mode => <button key={mode.id} type="button" role="menuitemradio"
                    aria-checked={snapshot.nativeMode === mode.id} title={mode.description} disabled={snapshot.busy || changingMode}
                    onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeNativeMode(mode.id); }}>{mode.name}</button>)}
                  {!snapshot.nativeModes?.length && <span>当前 CLI 未提供模式切换</span>}
                </div>
              </div> : <div className="codex-app-server-menu-group" role="group" aria-label="模式">
                <span className="codex-app-server-menu-label" aria-hidden="true">模式</span>
                <div className="codex-app-server-mode-options">
                  <button type="button" role="menuitemradio" aria-checked={snapshot.mode === "default"} disabled={snapshot.busy || changingMode} onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeMode("default"); }}>Exec</button>
                  <button type="button" role="menuitemradio" aria-checked={snapshot.mode === "plan"} disabled={snapshot.busy || changingMode || snapshot.capabilities?.plan === false} title={snapshot.capabilities?.plan === false ? "当前 CodeBuddy CLI 不支持 Plan 模式" : undefined} onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeMode("plan"); }}>Plan</button>
                </div>
              </div>}
              {acpModel && <div className="codex-app-server-menu-group" role="group" aria-label="OpenCode 模型">
                <span className="codex-app-server-menu-label" aria-hidden="true">模型 <small>下一轮生效</small></span>
                <div className="codex-app-server-mode-options">{acpModel.options?.map(option => <button key={option.value} type="button" role="menuitemradio"
                  aria-checked={acpModel.currentValue === option.value} disabled={snapshot.busy || changingModel}
                  onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeModel(option.value); }}>{option.name}</button>)}</div>
              </div>}
              {acpEffort && <div className="codex-app-server-menu-group" role="group" aria-label="OpenCode 思考强度">
                <span className="codex-app-server-menu-label" aria-hidden="true">思考强度 <small>下一轮生效</small></span>
                <div className="codex-app-server-mode-options">{acpEffort.options?.map(option => <button key={option.value} type="button" role="menuitemradio"
                  aria-checked={acpEffort.currentValue === option.value} disabled={snapshot.busy || changingModel}
                  onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeEffort(option.value); }}>{option.name}</button>)}</div>
              </div>}
              {snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && snapshot.backend === "openai" && <div className="codex-app-server-menu-group" role="group" aria-label="模型">
                <span className="codex-app-server-menu-label" aria-hidden="true">模型 <small>下一轮生效</small></span>
                <div className="codex-app-server-mode-options">
                  {(snapshot.models || []).map(model => <button key={model.id} type="button" role="menuitemradio"
                    aria-checked={snapshot.model === model.id} disabled={snapshot.busy || sending || changingModel || attachments.length > 0}
                    onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeModel(model.id); }}>{model.displayName}</button>)}
                </div>
                {Boolean((snapshot.models || []).find(model => model.id === snapshot.model)?.supportedReasoningEfforts?.length) && <div className="codex-app-server-menu-group" role="group" aria-label="思考强度（下一轮生效）">
                  <span className="codex-app-server-menu-label" aria-hidden="true">思考强度 <small>下一轮生效</small></span>
                  <div className="codex-app-server-mode-options">
                    {(snapshot.models || []).find(model => model.id === snapshot.model)?.supportedReasoningEfforts?.map(option => <button key={option.reasoningEffort}
                      type="button" role="menuitemradio" aria-checked={snapshot.effort === option.reasoningEffort}
                      title={option.description || undefined} disabled={snapshot.busy || sending || changingModel || attachments.length > 0}
                      onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeEffort(option.reasoningEffort); }}>
                      {effortLabel(option.reasoningEffort)}
                    </button>)}
                  </div>
                </div>}
                <button type="button" className="codex-app-server-fast-option" role="menuitemcheckbox" aria-checked={Boolean(snapshot.fastMode)}
                  disabled={snapshot.busy || sending || changingModel || attachments.length > 0 || !(snapshot.models || []).find(model => model.id === snapshot.model)?.fastAvailable}
                  onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changeFastMode(!snapshot.fastMode); }}>
                  快速模式{snapshot.fastMode ? "：开启" : "：关闭"} <small>用量成本更高</small>
                </button>
              </div>}
              {snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && <div className="codex-app-server-menu-group" role="group" aria-label="执行权限（下一轮生效）">
                <span className="codex-app-server-menu-label" aria-hidden="true">执行权限 <small>下一轮生效</small></span>
                <div className="codex-app-server-permission-options">
                  {(["readOnly", "askApproval", "fullAccess"] as const).map(permission => <button key={permission} type="button"
                    role="menuitemradio" aria-label={permissionLabels[permission]} aria-checked={snapshot.executionPermission === permission}
                    disabled={snapshot.busy || changingPermission || (snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(permission))} onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void changePermission(permission); }}>
                    <span className="codex-app-server-permission-option"><strong>{permissionLabels[permission]}</strong><small>{permissionDescriptions[permission]}</small></span>
                  </button>)}
                </div>
              </div>}
              <button type="button" role="menuitem" disabled={(snapshot.busy && !canSendWhileBusy) || sending || pastingImage || attachments.length >= 10} onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void addFiles(); }}><Paperclip aria-hidden="true" />附加文件</button>
            </div>}
          </div>
          <span className="codex-app-server-permission-status" data-permission={snapshot.executionPermission}>{snapshot.provider === "codebuddy" || snapshot.provider === "opencode"
            ? `模式：${snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "默认"}`
            : `执行权限：${permissionLabels[snapshot.executionPermission] || "需要确认"}`}</span>
          {snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && snapshot.backend === "openai" && <span className="codex-app-server-permission-status">{(snapshot.models || []).find(model => model.id === snapshot.model)?.displayName || snapshot.model || "默认模型"}{snapshot.effort ? ` · 思考${effortLabel(snapshot.effort)}` : ""}{snapshot.fastMode ? " · 快速" : ""}</span>}
          {acpModel && <span className="codex-app-server-permission-status">{acpModel.options?.find(option => option.value === acpModel.currentValue)?.name || acpModel.currentValue || "默认模型"}{acpEffort?.currentValue ? ` · ${acpEffort.options?.find(option => option.value === acpEffort.currentValue)?.name || acpEffort.currentValue}` : ""}</span>}
          <span className="codex-app-server-shortcuts">Enter 发送 · Shift+Enter 换行</span>
          <div className="codex-app-server-input-primary">
            <button type="button" className="codex-app-server-icon-button" title="新对话" aria-label="新对话" disabled={!snapshot.threadId || snapshot.busy || sending || pastingImage} onClick={() => void window.codexAppServerApi.newThread(sessionId)
              .then(value => { if (currentSessionRef.current === sessionId) { setSnapshot(value); setDraft(""); setAttachments([]); pastedImagesRef.current.clear(); setHistoryOpen(false); } })
              .catch(cause => { if (currentSessionRef.current === sessionId) setError(message(cause)); })}><Plus aria-hidden="true" /></button>
            {snapshot.busy && <button type="button" className="codex-app-server-send" title="停止" aria-label="停止" onClick={() => void window.codexAppServerApi.interrupt(sessionId).catch(cause => setError(message(cause)))}><Square aria-hidden="true" /></button>}
            {(!snapshot.busy || canSendWhileBusy) && <button type="submit" className="codex-app-server-send" title="发送" aria-label="发送" disabled={!snapshot.threadId || sending || pastingImage || (!draft.trim() && attachments.length === 0)}><ArrowUp aria-hidden="true" /></button>}
          </div>
        </div>
      </div>
    </form>
    {historyOpen && <div className="modal-overlay codex-app-server-history-overlay" onMouseDown={event => { if (event.target === event.currentTarget) closeHistory(); }}>
      <div className="modal-dialog codex-app-server-history-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-app-server-history-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeHistory(); return; }
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
      }}>
        <div className="codex-app-server-history-header"><h2 id="codex-app-server-history-title">历史会话</h2>
          <button type="button" aria-label="关闭历史会话" onClick={closeHistory}><X aria-hidden="true" /></button></div>
        <div className="codex-app-server-history-search"><input autoFocus type="search" aria-label="搜索历史会话" placeholder="搜索标题或会话 ID" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></div>
        <div className="codex-app-server-history" aria-label="历史会话列表">
          {visibleHistory.map(thread => <button type="button" key={thread.id} disabled={snapshot.busy || sending || pastingImage || resumingHistory || thread.id === snapshot.threadId} onClick={() => void selectHistory(thread.id)}>
            <strong>{thread.title}</strong><small>会话 ID：{thread.id}</small><span>{new Date(thread.updatedAt * 1000).toLocaleString()} · {thread.source}</span>
          </button>)}
          {visibleHistory.length === 0 && !loadingHistory && !historyError && <p>{normalizedHistoryQuery ? "没有匹配的历史会话。" : "当前项目没有历史会话。"}</p>}
          {historyError && <p className="codex-app-server-history-error" role="alert">{historyError}</p>}
          {loadingHistory && <p>正在加载历史会话…</p>}
          {!normalizedHistoryQuery && historyCursor && <button type="button" disabled={loadingHistory} onClick={() => void loadHistory(historyCursor)}>加载更多</button>}
        </div>
      </div>
    </div>}
    {previewFile && <div className="modal-overlay codex-app-server-preview-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewFile(null); }}>
      <div className="modal-dialog codex-app-server-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览 ${previewFile.name}`} onKeyDown={event => { if (event.key === "Escape") setPreviewFile(null); }}>
        <div className="codex-app-server-preview-header"><strong>{previewFile.name}</strong><button type="button" aria-label="关闭预览" onClick={() => setPreviewFile(null)}><X aria-hidden="true" /></button></div>
        <div className="codex-app-server-preview-content">
          {previewError ? <p role="alert">无法预览：{previewError}</p> : !preview ? <p>正在加载预览…</p>
            : preview.kind === "image" ? <img src={preview.dataUrl} alt={previewFile.name} />
            : preview.kind === "text" ? <pre>{preview.text}</pre>
            : preview.kind === "too_large" ? <p>文件过大，无法预览（上限 {Math.round(preview.limit / 1024 / 1024)} MB）。</p>
            : <p>此文件格式暂不支持预览。</p>}
        </div>
      </div>
    </div>}
  </section>;
});
