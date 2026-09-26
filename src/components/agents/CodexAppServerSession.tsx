import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ArrowUp, BookOpen, Cable, ChevronRight, CircleCheck, CircleX, Code2, Copy, Ellipsis, File as FileIcon, FileDiff, FileSearch, FileText, Globe2, History, Image as ImageIcon, Minimize2, Package, Paperclip, Plus, RefreshCw, Search, Sparkles, Square, Target, Terminal, Wrench, X } from "lucide-react";
import type { CodexAppServerHistory, CodexAppServerSnapshot, CodexCapabilityReference, CodexSessionCapabilities, CodexExecutionPermission, CodexQuestionRequest, CodexQuestionAnswer, CodexMcpElicitation, QuickCommand, WorkspaceEntrySearchResult } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";
import { CodexAccountPanel } from "./CodexAccountPanel";
import { CodexGoalDialog } from "./CodexGoalDialog";
import { CodexVersionControl } from "./CodexVersionControl";
import { CodexPluginDialog } from "./CodexPluginDialog";
import { TurnDiffCard } from "./TurnDiffCard";

const empty: CodexAppServerSnapshot = { threadId: null, mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null, items: [], approvals: [] };
const permissionLabels: Record<CodexExecutionPermission, string> = { readOnly: "只读", askApproval: "需要确认", fullAccess: "完全访问" };
const permissionDescriptions: Record<CodexExecutionPermission, string> = {
  readOnly: "可检查文件，不能修改或申请扩权",
  askApproval: "可修改工作区，越界操作先确认",
  fullAccess: "可访问文件与网络，不再请求批准"
};
const codeBuddyModeDescriptions: Record<string, string> = {
  default: "自主分析并执行任务，可读取与修改文件、运行命令。",
  standard: "自主分析并执行任务，可读取与修改文件、运行命令。",
  acceptedits: "自动接受代码修改，无需逐项确认。",
  plan: "先制定计划并等待你确认，再开始执行（只读，不直接改动文件）。",
  bypasspermissions: "跳过权限确认，直接执行操作。",
  fullaccess: "授予完整执行权限，直接运行命令与修改文件。",
  auto: "自主分析并执行任务，遇到需确认的操作自动放行。",
  dontask: "运行命令与修改文件均不再弹出确认。",
  delegate: "将子任务委派给子 Agent 并行处理。"
};
const normalizeModeKey = (value: string) => (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const effortLabels: Record<string, string> = {
  none: "无", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极致"
};
const effortLabel = (effort: string) => effortLabels[effort] || effort;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
async function hasRecordedCodeBuddyError(sessionId: string, detail: string, knownErrorIds: Set<string>) {
  try {
    const current = await window.codexAppServerApi.snapshot(sessionId);
    return current.provider === "codebuddy" && current.items.some(item => item.type === "turnError"
      && !knownErrorIds.has(item.id) && item.text === detail);
  } catch { return false; }
}
type FileMention = { start: number; end: number; query: string };
function fileMentionAtCaret(value: string, caret: number): FileMention | null {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { start: prefix.length - match[0].length + match[0].lastIndexOf("@"), end: caret, query: match[1] };
}
const statusLabels: Record<string, string> = { completed: "已完成", inProgress: "进行中", in_progress: "进行中", pending: "待处理", failed: "失败", declined: "已拒绝" };
const statusLabel = (status?: string) => statusLabels[status || ""] || status || "进行中";
type SessionItem = CodexAppServerSnapshot["items"][number];
type TeamMember = NonNullable<CodexAppServerSnapshot["team"]>["members"][number];
type ToolDisplayItem = { kind: "item"; item: SessionItem } | { kind: "tools"; items: SessionItem[] };
type DisplayItem = ToolDisplayItem
  | { kind: "diagnostic"; event: Diagnostic }
  | { kind: "diff"; diff: NonNullable<CodexAppServerSnapshot["turnDiffs"]>[number] };
const toolTypes = new Set(["commandExecution", "fileChange", "toolCall", "mcpToolCall", "dynamicToolCall", "webSearch"]);
const isTool = (item: SessionItem) => toolTypes.has(item.type);
type AttachmentPreview = Awaited<ReturnType<typeof window.codexAppServerApi.previewAttachment>>;
type Approval = CodexAppServerSnapshot["approvals"][number];
function approvalAllows(approval: Approval, decision: string) {
  const available = approval.params.availableDecisions;
  return !Array.isArray(available) || available.some(value => value === decision
    || (decision === "acceptWithExecpolicyAmendment" && value != null && typeof value === "object"
      && Object.prototype.hasOwnProperty.call(value, decision)));
}
function validExecpolicyAmendment(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(part => typeof part === "string" && part.trim());
}
type SelectionKind = "mode" | "model" | "effort" | "fastMode" | "permission" | "contextWindow" | "multitask";
type SlashCommand = { id: string; label: string; disabled?: boolean; source?: "codebuddy" };
const imageFile = (name: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
const sendableImageFile = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);
const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;
type InlineImage = { token: string; path: string | null };
function orderedDraft(draft: string, images: InlineImage[]) {
  const byToken = new Map(images.filter(image => image.path).map(image => [image.token, image.path!]));
  const parts: Array<{ type: "text"; text: string } | { type: "image"; path: string }> = [];
  const pattern = /〔图片 \d+〕/g;
  let offset = 0;
  const seen = new Set<string>();
  for (const match of draft.matchAll(pattern)) {
    const imagePath = byToken.get(match[0]);
    if (!imagePath || seen.has(match[0])) continue;
    if (match.index > offset) parts.push({ type: "text", text: draft.slice(offset, match.index) });
    parts.push({ type: "image", path: imagePath });
    seen.add(match[0]);
    offset = match.index + match[0].length;
  }
  if (offset < draft.length) parts.push({ type: "text", text: draft.slice(offset) });
  return { text: parts.filter(part => part.type === "text").map(part => part.text).join("").trim(), parts };
}
function userMessageCopyText(item: { text?: string; attachments?: Array<{ path: string }> }) {
  const attachments = item.attachments?.map(file => file.path) || [];
  return [item.text || "", attachments.length ? `附件：\n${attachments.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

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

function QuestionCard({ sessionId, request, provider }: { sessionId: string; request: CodexQuestionRequest; provider: "codex" | "codebuddy" }) {
  const tabId = useId();
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const questions = request.params.questions || [];
  const hasAnswer = (question: typeof questions[number]) => {
    const choice = choices[question.id]?.length;
    const note = notes[question.id]?.trim();
    return Boolean((choice || note) && (!question.options?.length || choice || question.isOther));
  };
  async function answer() {
    if (sending || request.submitting) return;
    const answers: Record<string, CodexQuestionAnswer> = {};
    for (const [index, question] of questions.entries()) {
      const choice = choices[question.id] || [];
      const note = notes[question.id]?.trim();
      if (!choice.length && !note) { setActiveIndex(index); setError(`请回答「${question.header || question.question}」。`); return; }
      if (question.options?.length && !choice.length && !question.isOther) {
        setActiveIndex(index); setError(`请选择「${question.header || question.question}」的选项。`); return;
      }
      answers[question.id] = { answers: provider === "codebuddy"
        ? [...(question.multiSelect ? choice : note ? [] : choice), ...(note ? [note] : [])]
        : [...choice, ...(note ? [`user_note: ${note}`] : [])] };
    }
    setSending(true); setError("");
    try { await window.codexAppServerApi.answerQuestion(sessionId, request.requestId, answers); }
    catch (cause) { setError(message(cause)); }
    finally { setSending(false); }
  }
  async function cancel() {
    if (sending || request.submitting) return;
    setSending(true); setError("");
    try { await window.codexAppServerApi.cancelQuestion(sessionId, request.requestId); }
    catch (cause) { setError(message(cause)); }
    finally { setSending(false); }
  }
  const agentName = provider === "codebuddy" ? "CodeBuddy" : "Codex";
  return <article className="codex-app-server-question" aria-label={`${agentName} 提问`}>
    <strong>{agentName} 提问</strong>
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
         <input type={question.multiSelect ? "checkbox" : "radio"} name={`question-${request.requestId}-${question.id}`} value={option.label}
           checked={choices[question.id]?.includes(option.label) || false} disabled={sending || request.submitting}
           onChange={() => { setChoices(current => ({ ...current, [question.id]: question.multiSelect
             ? current[question.id]?.includes(option.label) ? current[question.id].filter(value => value !== option.label) : [...(current[question.id] || []), option.label]
             : [option.label] })); if (provider === "codebuddy" && !question.multiSelect) setNotes(current => ({ ...current, [question.id]: "" })); setError(""); }} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>)}
      <label className="codex-app-server-question-note">
        <span>{question.options?.length ? provider === "codebuddy" ? "自定义回答" : "补充说明或自定义回答" : "回答"}</span>
         {question.isSecret ? <input type="password" value={notes[question.id] || ""} disabled={sending || request.submitting}
           onChange={event => { setNotes(current => ({ ...current, [question.id]: event.target.value }));
             if (provider === "codebuddy" && !question.multiSelect) setChoices(current => ({ ...current, [question.id]: [] })); setError(""); }} />
          : <textarea value={notes[question.id] || ""} disabled={sending || request.submitting}
             onChange={event => { setNotes(current => ({ ...current, [question.id]: event.target.value }));
               if (provider === "codebuddy" && !question.multiSelect) setChoices(current => ({ ...current, [question.id]: [] })); setError(""); }} />}
      </label>
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={sending || request.submitting || !questions.length} onClick={() => void answer()}>
      {sending || request.submitting ? "正在提交…" : "提交回答"}
    </button>
    {provider === "codebuddy" && <button type="button" disabled={sending || request.submitting} onClick={() => void cancel()}>取消提问</button>}
  </article>;
}

function McpElicitationCard({ sessionId, request }: { sessionId: string; request: CodexMcpElicitation }) {
  const { params } = request;
  const [values, setValues] = useState<Record<string, string>>({});
  const [rawJson, setRawJson] = useState("{}");
  const [sending, setSending] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const schema = params.requestedSchema;
  const properties = schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? Object.entries(schema.properties as Record<string, unknown>) : [];
  const required = Array.isArray(schema?.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const isForm = params.mode !== "url";

  function formContent(): Record<string, unknown> {
    if (!properties.length) {
      const parsed: unknown = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请输入 JSON 对象。");
      for (const name of required) if (!Object.prototype.hasOwnProperty.call(parsed, name)) throw new Error(`请填写「${name}」。`);
      return parsed as Record<string, unknown>;
    }
    const content: Record<string, unknown> = Object.create(null);
    for (const [name, rawField] of properties) {
      const field = rawField && typeof rawField === "object" ? rawField as Record<string, unknown> : {};
      const value = values[name] ?? "";
      if (!value.trim()) { if (required.includes(name)) throw new Error(`请填写「${String(field.title || name)}」。`); continue; }
      if (field.type === "boolean") content[name] = value === "true";
      else if (field.type === "number" || field.type === "integer") {
        const number = Number(value);
        if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) throw new Error(`「${String(field.title || name)}」需要有效数字。`);
        content[name] = number;
      } else if (field.type === "object" || field.type === "array") {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { throw new Error(`「${String(field.title || name)}」需要有效 JSON。`); }
        if (field.type === "array" ? !Array.isArray(parsed) : !parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error(`「${String(field.title || name)}」的数据类型不正确。`);
        content[name] = parsed;
      } else content[name] = value;
      if (Array.isArray(field.enum) && !field.enum.includes(content[name])) throw new Error(`「${String(field.title || name)}」不在可选范围内。`);
      if (typeof field.minLength === "number" && typeof content[name] === "string" && content[name].length < field.minLength)
        throw new Error(`「${String(field.title || name)}」内容太短。`);
      if (typeof field.maxLength === "number" && typeof content[name] === "string" && content[name].length > field.maxLength)
        throw new Error(`「${String(field.title || name)}」内容太长。`);
      if (typeof field.minimum === "number" && typeof content[name] === "number" && content[name] < field.minimum)
        throw new Error(`「${String(field.title || name)}」小于允许值。`);
      if (typeof field.maximum === "number" && typeof content[name] === "number" && content[name] > field.maximum)
        throw new Error(`「${String(field.title || name)}」大于允许值。`);
    }
    return content;
  }
  async function respond(action: "accept" | "decline" | "cancel") {
    if (sending || request.submitting) return;
    let content: Record<string, unknown> | null = null;
    try { if (action === "accept" && isForm) content = formContent(); }
    catch (cause) { setError(message(cause)); return; }
    setSending(true); setError("");
    try { await window.codexAppServerApi.resolveElicitation(sessionId, request.requestId, action, content); }
    catch (cause) { setError(message(cause)); }
    finally { setSending(false); }
  }
  async function openUrl() {
    if (!params.url) return;
    await window.externalLinkApi.open(params.url);
    setOpened(true); setError("");
  }
  return <article className="codex-app-server-elicitation" aria-label="MCP 交互请求">
    <strong>{params.serverName} · {isForm ? "需要填写信息" : "需要打开链接"}</strong>
    <p>{params.message}</p>
    {isForm ? properties.length ? <div className="codex-app-server-elicitation-fields">{properties.map(([name, rawField]) => {
      const field = rawField && typeof rawField === "object" ? rawField as Record<string, unknown> : {};
      const label = String(field.title || name);
      const value = values[name] ?? "";
      const disabled = sending || request.submitting;
      const update = (next: string) => { setValues(current => ({ ...current, [name]: next })); setError(""); };
      return <label key={name}><span>{label}{required.includes(name) ? " *" : ""}</span>
        {typeof field.description === "string" && <small>{field.description}</small>}
        {Array.isArray(field.enum) ? <select value={value} disabled={disabled} onChange={event => update(event.target.value)}>
          <option value="">请选择</option>{field.enum.map(option => <option key={JSON.stringify(option)} value={String(option)}>{String(option)}</option>)}
        </select> : field.type === "boolean" ? <select value={value} disabled={disabled} onChange={event => update(event.target.value)}>
          <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
        </select> : field.type === "object" || field.type === "array" ? <textarea value={value} disabled={disabled}
          placeholder={field.type === "array" ? "[]" : "{}"} onChange={event => update(event.target.value)} />
          : <input type={field.writeOnly === true || field.format === "password" ? "password" : field.type === "number" || field.type === "integer" ? "number" : "text"}
            value={value} disabled={disabled} onChange={event => update(event.target.value)} />}
      </label>;
    })}</div> : <label className="codex-app-server-elicitation-fields"><span>JSON 表单内容</span>
      <textarea value={rawJson} disabled={sending || request.submitting} onChange={event => { setRawJson(event.target.value); setError(""); }} />
    </label> : <div className="codex-app-server-elicitation-url"><code>{params.url}</code>
      <button type="button" disabled={sending || request.submitting} onClick={() => void openUrl().catch(cause => setError(message(cause)))}>打开链接</button>
      {opened && <small>链接已打开。完成外部操作后再确认。</small>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <div className="codex-app-server-elicitation-actions">
      <button type="button" disabled={sending || request.submitting} onClick={() => void respond("cancel")}>取消</button>
      <button type="button" disabled={sending || request.submitting} onClick={() => void respond("decline")}>拒绝</button>
      <button type="button" className="primary" disabled={sending || request.submitting || (!isForm && !opened)} onClick={() => void respond("accept")}>{isForm ? "提交" : "已完成"}</button>
    </div>
  </article>;
}

function groupTools(items: SessionItem[]): ToolDisplayItem[] {
  const result: ToolDisplayItem[] = [];
  const isHidden = (item: SessionItem) => !isTool(item) && !["userMessage", "agentMessage", "plan", "turnPlan", "questionAnswer", "backgroundTurn", "turnError"].includes(item.type);
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

function toolPresentation(item: SessionItem) {
  const kind = item.type === "fileChange" || ["read", "edit", "delete", "move"].includes(item.toolKind || "") ? "file"
    : item.type === "webSearch" || item.toolKind === "search" ? "search"
      : item.toolKind === "fetch" ? "web" : item.type === "commandExecution" || item.toolKind === "execute" ? "command" : "other";
  const Icon = kind === "file" ? FileDiff : kind === "search" ? Search : kind === "web" ? Globe2 : kind === "command" ? Terminal : Wrench;
  const label = kind === "file" ? "文件变更" : kind === "search" ? "搜索" : kind === "web" ? "网页读取" : kind === "command" ? "执行命令" : "工具调用";
  return { kind, Icon, label };
}

function toolDetails(item: SessionItem) {
  if (item.type === "fileChange" && Array.isArray(item.changes)) return <><div className="codex-app-server-tool-files">{item.changes.map((change, index) => {
    const value = change && typeof change === "object" ? change as Record<string, unknown> : {};
    return <div key={`${String(value.path || "file")}-${index}`}><FileText aria-hidden="true" /><span>{String(value.path || value.filePath || "未知文件")}</span><small>{String(value.kind || value.type || "变更")}</small></div>;
  })}</div><details className="codex-app-server-tool-raw"><summary>原始变更</summary><pre>{JSON.stringify(item.changes, null, 2)}</pre></details></>;
  if (item.locations?.length) return <div className="codex-app-server-tool-files">{item.locations.map((location, index) => <div key={index}><FileSearch aria-hidden="true" /><span>{location.path || location.uri || "相关位置"}</span></div>)}</div>;
  return null;
}

function ToolCard({ item }: { item: SessionItem }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { kind, Icon, label } = toolPresentation(item);
  const firstChange = Array.isArray(item.changes) ? item.changes[0] : null;
  const changedFile = firstChange && typeof firstChange === "object" ? String((firstChange as Record<string, unknown>).path || (firstChange as Record<string, unknown>).filePath || "") : "";
  const summary = item.command?.trim().split(/\r?\n/, 1)[0] || item.query || item.locations?.[0]?.path || changedFile || item.server || "";
  return <div className="codex-app-server-tool">
    <button type="button" className="codex-app-server-tool-heading" data-kind={kind} data-status={item.status}
      aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setExpanded(current => !current)}>
      <ChevronRight className="codex-app-server-tool-chevron" aria-hidden="true" /><Icon aria-hidden="true" />
      <strong>{item.toolName || item.tool || label}</strong>{summary && <span className="codex-app-server-tool-summary" title={summary}>{summary}</span>}
      <span className="codex-app-server-tool-status">{item.status === "completed" ? <CircleCheck aria-hidden="true" /> : item.status === "failed" || item.status === "declined" ? <CircleX aria-hidden="true" /> : <span className="codex-app-server-tool-spinner" aria-hidden="true" />}{statusLabel(item.status)}</span>
    </button>
    {expanded && <div id={detailsId} className="codex-app-server-tool-details">
      {item.command && <pre className="codex-app-server-tool-command">{item.command}</pre>}
      {item.server && <p className="codex-app-server-tool-query">{item.server}</p>}
      {item.query && <p className="codex-app-server-tool-query">{item.query}</p>}
      {item.arguments != null && <pre className="codex-app-server-tool-command">{typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments, null, 2)}</pre>}
      {toolDetails(item)}
      {item.output && <pre className="codex-app-server-tool-output">{item.output}</pre>}
      {item.result != null && <pre className="codex-app-server-tool-output">{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre>}
      {item.changes != null && !Array.isArray(item.changes) && <pre>{JSON.stringify(item.changes, null, 2)}</pre>}
      {!item.command && !item.output && !item.query && !item.arguments && !item.locations?.length && item.changes == null && item.result == null && <p className="codex-app-server-tool-placeholder">等待工具返回内容…</p>}
    </div>}
  </div>;
}

function ToolGroup({ items, expanded, onToggle }: { items: SessionItem[]; expanded: boolean; onToggle: () => void }) {
  const status = toolGroupStatus(items);
  return <section className="codex-app-server-event" data-status={status}>
    <button type="button" className="codex-app-server-event-summary" aria-expanded={expanded} onClick={onToggle}>
      <ChevronRight className="codex-app-server-event-chevron" aria-hidden="true" />
      <span className="codex-app-server-event-glyph"><Code2 aria-hidden="true" /></span>
      <strong>工具调用 · {items.length} 项</strong><span className="codex-app-server-event-status">{status}</span>
    </button>
    {expanded && items.map(item => <ToolCard item={item} key={item.id} />)}
  </section>;
}

const teamStatusLabels: Record<string, string> = {
  running: "运行中", idle: "空闲", paused: "已暂停", completed: "已完成", failed: "失败",
  cancelled: "已取消", killed: "已终止", unresumable: "无法恢复", removed: "已离队", unknown: "状态未知"
};

function TeamMemberTimeline({ member, onLinkClick }: { member: TeamMember; onLinkClick?: (href: string) => void }) {
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  return <div className="codex-app-server-team-timeline" aria-label={`${member.name} 的消息时间线`}>
    {!member.items.length && <p className="codex-app-server-team-empty">暂无成员消息。</p>}
    {groupTools(member.items).map(entry => {
      if (entry.kind === "tools") {
        const groupId = entry.items[0].id;
        return <ToolGroup key={groupId} items={entry.items} expanded={expandedGroupId === groupId}
          onToggle={() => setExpandedGroupId(current => current === groupId ? null : groupId)} />;
      }
      const item = entry.item;
      if (item.type === "userMessage" || item.type === "agentMessage") return <article className={`codex-app-server-message ${item.type}`} key={item.id}>
        {item.type === "userMessage" ? <p>{item.text}</p>
          : item.text && <MarkdownBlock className="codex-app-server-markdown" content={item.text} externalLinks={!onLinkClick} onLinkClick={onLinkClick} linkActions />}
      </article>;
      if (item.type === "turnPlan") return <article className="codex-app-server-message turnPlan" key={item.id}>
        <strong>计划进度</strong><ol>{item.plan?.map((step, index) => <li key={index}>{step.step} <span>{statusLabel(step.status)}</span></li>)}</ol>
      </article>;
      return null;
    })}
  </div>;
}

function toolGroupStatus(items: SessionItem[]) {
  if (items.some(item => item.status === "failed" || item.status === "declined")) return "有失败";
  if (items.every(item => item.status === "completed")) return "已完成";
  return "进行中";
}

type Diagnostic = NonNullable<CodexAppServerSnapshot["diagnostics"]>[number];
const diagnosticNames: Record<string, string> = {
  configWarning: "配置警告", warning: "运行警告",
  "model/rerouted": "模型重路由", "model/safetyBuffering/updated": "模型安全缓冲",
  "model/verification": "模型验证", error: "运行错误"
};
const errorNames: Record<string, string> = {
  ContextWindowExceeded: "上下文窗口已满", UsageLimitExceeded: "用量限制", HttpConnectionFailed: "上游连接失败",
  ResponseStreamConnectionFailed: "响应流连接失败", ResponseStreamDisconnected: "响应流中断",
  ResponseTooManyFailedAttempts: "重试次数过多", BadRequest: "请求无效", Unauthorized: "身份验证失败",
  SandboxError: "沙箱错误", InternalServerError: "服务内部错误", Other: "其他错误"
};
function diagnosticSummary(event: Diagnostic) {
  const data = event.payload;
  if (event.kind === "configWarning") return String(data.summary || "配置需要检查");
  if (event.kind === "warning" || event.kind === "error") return String(data.message || "运行遇到问题");
  if (event.kind === "model/rerouted") return `${String(data.fromModel || "原模型")} → ${String(data.toModel || "目标模型")}`;
  if (event.kind === "model/verification") return "需要额外账户验证";
  return event.kind === "model/safetyBuffering/updated" ? "响应正在安全缓冲" : "查看详情";
}
function DiagnosticCard({ event }: { event: Diagnostic }) {
  const data = event.payload;
  const kind = event.kind === "error" || event.kind.includes("Warning") || event.kind === "warning" ? "warning" : "info";
  return <details className="codex-app-server-diagnostic" data-kind={kind}>
    <summary><span>{diagnosticNames[event.kind] || event.kind}</span><strong>{diagnosticSummary(event)}</strong>
      <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString()}</time></summary>
    {event.kind === "error" && typeof data.kind === "string" && <p>类别：{errorNames[data.kind] || data.kind}{typeof data.httpStatusCode === "number" ? ` · HTTP ${data.httpStatusCode}` : ""}</p>}
    {event.kind === "configWarning" && typeof data.path === "string" && <p>配置文件：{data.path}</p>}
    {event.kind === "configWarning" && typeof data.details === "string" && <p>{data.details}</p>}
    <pre>{JSON.stringify(data, null, 2)}</pre>
  </details>;
}
function groupTimeline(snapshot: CodexAppServerSnapshot): DisplayItem[] {
  const groups = groupTools(snapshot.items);
  const events = (snapshot.diagnostics || []).filter(event => !event.kind.startsWith("hook/"));
  const diffs = snapshot.turnDiffs || [];
  const lastIndex = new Map<string, number>();
  groups.forEach((group, index) => {
    const turnId = group.kind === "tools" ? group.items.at(-1)?.turnId : group.item.turnId;
    if (turnId) lastIndex.set(turnId, index);
  });
  const result: DisplayItem[] = events.filter(event => !event.turnId).map(event => ({ kind: "diagnostic", event }));
  groups.forEach((group, index) => {
    result.push(group);
    const turnId = group.kind === "tools" ? group.items.at(-1)?.turnId : group.item.turnId;
    if (!turnId || lastIndex.get(turnId) !== index) return;
    result.push(...events.filter(event => event.turnId === turnId).map(event => ({ kind: "diagnostic" as const, event })));
    const diff = diffs.find(value => value.turnId === turnId);
    if (diff) result.push({ kind: "diff", diff });
  });
  const seenTurns = new Set(lastIndex.keys());
  result.push(...events.filter(event => event.turnId && !seenTurns.has(event.turnId)).map(event => ({ kind: "diagnostic", event } as DisplayItem)));
  result.push(...diffs.filter(diff => !seenTurns.has(diff.turnId)).map(diff => ({ kind: "diff", diff } as DisplayItem)));
  return result;
}

export type CodexAppServerSessionHandle = {
  applyQuickCommand: (command: QuickCommand) => Promise<boolean>;
  appendFilePath: (path: string) => void;
};

type CodexAppServerSessionProps = {
  sessionId: string;
  sessionType?: "windows" | "wsl" | "ssh";
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  draftReferences?: CodexCapabilityReference[];
  setDraftReferences?: Dispatch<SetStateAction<CodexCapabilityReference[]>>;
  onLinkClick?: (href: string) => void;
};

export const CodexAppServerSession = forwardRef<CodexAppServerSessionHandle, CodexAppServerSessionProps>(function CodexAppServerSession({ sessionId, sessionType = "windows", draft, setDraft, draftReferences = [], setDraftReferences = () => {}, onLinkClick }, ref) {
  const [snapshot, setSnapshot] = useState<CodexAppServerSnapshot>(empty);
  const [selectedMemberName, setSelectedMemberName] = useState<string | null>(null);
  const [memberDraft, setMemberDraft] = useState("");
  const [sendingMember, setSendingMember] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const timelineRef = useRef<CodexAppServerSnapshot | null>(null);
  const [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState<{ scope: "main" | "history"; text: string } | null>(null);
  const [historyCopyingThreadId, setHistoryCopyingThreadId] = useState<string | null>(null);
  const [dismissedSnapshotError, setDismissedSnapshotError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string } | null>(null);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [pastingImage, setPastingImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const [changingMultitask, setChangingMultitask] = useState(false);
  const [changingPermission, setChangingPermission] = useState(false);
  const [resolvingPlan, setResolvingPlan] = useState(false);
  const [history, setHistory] = useState<CodexAppServerHistory[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyArchived, setHistoryArchived] = useState(false);
  const [historyMutation, setHistoryMutation] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectionKind, setSelectionKind] = useState<SelectionKind | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [selectionPending, setSelectionPending] = useState(false);
  const [modelMetadata, setModelMetadata] = useState<Awaited<ReturnType<typeof window.codexAppServerApi.listModelMetadata>>>([]);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilityTab, setCapabilityTab] = useState<"skills" | "apps" | "mcp">("skills");
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [capabilities, setCapabilities] = useState<CodexSessionCapabilities | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState("");
  const [fileMention, setFileMention] = useState<FileMention | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [fileResults, setFileResults] = useState<WorkspaceEntrySearchResult[]>([]);
  const [fileSearchStatus, setFileSearchStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [fileSearchError, setFileSearchError] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [resumingHistory, setResumingHistory] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileSearchRequestRef = useRef(0);
  const fileListId = useId();
  const slashListId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const selectionDialogRef = useRef<HTMLDivElement>(null);
  const capabilityButtonRef = useRef<HTMLButtonElement>(null);
  const capabilityRef = useRef<HTMLDivElement>(null);
  const historyRequestRef = useRef(0);
  const currentSessionRef = useRef(sessionId);
  const modelMetadataSessionRef = useRef<string | null>(null);
  const modelMetadataRequestRef = useRef(0);
  const loadedSessionIdRef = useRef<string | null>(null);
  const pastedImagesRef = useRef(new Set<string>());
  const inlineImagesRef = useRef<InlineImage[]>([]);
  const imageTokenCounterRef = useRef(0);
  const pastingRef = useRef(false);
  const changingModeRef = useRef(false);
  const changingModelRef = useRef(false);
  const changingPermissionRef = useRef(false);
  const resolvingPlanRef = useRef(false);
  currentSessionRef.current = sessionId;

  async function copyText(value: string, label: string, scope: "main" | "history" = "main") {
    try {
      const copied = await window.clipboardApi.writeText(value);
      if (currentSessionRef.current === sessionId) setCopyNotice({ scope, text: copied ? `${label} 已复制` : `${label} 复制失败` });
    } catch {
      if (currentSessionRef.current === sessionId) setCopyNotice({ scope, text: `${label} 复制失败` });
    }
  }

  async function copyInitialUserInput(threadId: string) {
    setHistoryCopyingThreadId(threadId);
    setCopyNotice(null);
    try {
      const input = await window.codexAppServerApi.readInitialUserInput(sessionId, threadId);
      if (currentSessionRef.current !== sessionId) return;
      const value = input && userMessageCopyText(input);
      if (value) await copyText(value, "首条用户输入", "history");
      else setCopyNotice({ scope: "history", text: "未找到首条用户输入" });
    } catch (cause) {
      if (currentSessionRef.current === sessionId) setCopyNotice({ scope: "history", text: `读取首条用户输入失败：${message(cause)}` });
    } finally {
      if (currentSessionRef.current === sessionId) setHistoryCopyingThreadId(null);
    }
  }

  useImperativeHandle(ref, () => ({
    appendFilePath(path) {
      setDraft(current => current + (current && !/\s$/.test(current) ? " " : "") + path);
      window.requestAnimationFrame(() => {
        if (currentSessionRef.current === sessionId) textareaRef.current?.focus();
      });
    },
    async applyQuickCommand(command) {
      if (loadedSessionIdRef.current !== sessionId || !snapshot.threadId) return false;
      if (command.mode !== "auto-enter") {
        setDraft(current => current + command.command);
        textareaRef.current?.focus();
        return true;
      }
      if (snapshot.compacting || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null) || sending || pastingImage) return false;
      const knownErrorIds = new Set(snapshot.items.filter(item => item.type === "turnError").map(item => item.id));
      setSending(true); setError("");
      try {
        await window.codexAppServerApi.submit(sessionId, command.command, []);
        return true;
      } catch (cause) {
        const recorded = snapshot.provider === "codebuddy" && await hasRecordedCodeBuddyError(sessionId, message(cause), knownErrorIds);
        if (currentSessionRef.current === sessionId && !recorded) setError(message(cause));
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
    timelineRef.current = null;
    setSnapshot(empty);
    setCopyNotice(null);
    setHistoryCopyingThreadId(null);
    setSelectedMemberName(null);
    setMemberDraft("");
    setSendingMember(false);
    setMemberError("");
    setExpandedGroupId(null);
    setError("");
    setDismissedSnapshotError(null);
    setAttachments([]);
    setInlineImages([]);
    inlineImagesRef.current = [];
    setDraft(current => current.replace(/〔图片 \d+〕/g, ""));
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
    setHistoryArchived(false);
    setHistoryMutation(null);
    setRenamingThreadId(null);
    setHistoryOpen(false);
    setGoalOpen(false);
    setMenuOpen(false);
    setSelectionKind(null);
    setSelectionError("");
    setSelectionPending(false);
    setCapabilityOpen(false);
    setFileMention(null);
    setSlashDismissed(false);
    setSelectedSlashIndex(0);
    setFileResults([]);
    setFileSearchStatus("idle");
    setFileSearchError("");
    setSelectedFileIndex(0);
    fileSearchRequestRef.current += 1;
    setCapabilities(null);
    setCapabilityQuery("");
    setHistoryQuery("");
    setHistoryError("");
    setLoadingHistory(false);
    setResumingHistory(false);
    historyRequestRef.current += 1;
    void window.codexAppServerApi.snapshot(sessionId).then(value => { if (active && !receivedChange) { loadedSessionIdRef.current = sessionId; timelineRef.current = value; setSnapshot(value); } })
      .catch(cause => { if (active) setError(message(cause)); });
    const off = window.codexAppServerApi.onChanged(payload => {
      if (active && payload.id === sessionId) {
        receivedChange = true;
        loadedSessionIdRef.current = sessionId;
        const next = payload.snapshot;
        const previous = timelineRef.current;
        if (previous?.threadId !== next.threadId) setExpandedGroupId(null);
        timelineRef.current = next;
        setSnapshot(next);
      }
    });
    return () => { active = false; off(); };
  }, [sessionId]);
  useEffect(() => {
    if (!snapshot.error) setDismissedSnapshotError(null);
  }, [snapshot.error]);
  useEffect(() => {
    const names = snapshot.team?.members.map(member => member.name) || [];
    if (!names.length) { setSelectedMemberName(null); return; }
    if (!selectedMemberName || !names.includes(selectedMemberName)) setSelectedMemberName(names[0]);
  }, [snapshot.team?.name, snapshot.team?.members, selectedMemberName]);
  useEffect(() => { setMemberDraft(""); setMemberError(""); }, [snapshot.threadId, snapshot.team?.name]);
  useEffect(() => {
    if (!fileMention) return;
    const requestId = ++fileSearchRequestRef.current;
    setFileSearchStatus("loading");
    setFileSearchError("");
    setFileResults([]);
    setSelectedFileIndex(0);
    const timer = window.setTimeout(() => {
      window.projectSearchApi.searchWorkspaceEntries(sessionId, fileMention.query).then(response => {
        if (fileSearchRequestRef.current !== requestId) return;
        setFileResults(response.results.filter(entry => entry.type === "file"));
        setFileSearchStatus("ready");
      }).catch(cause => {
        if (fileSearchRequestRef.current !== requestId) return;
        setFileResults([]);
        setFileSearchError(message(cause));
        setFileSearchStatus("error");
      });
    }, 180);
    return () => { window.clearTimeout(timer); fileSearchRequestRef.current += 1; };
  }, [sessionId, fileMention?.query, fileMention?.start, fileMention?.end]);
  useEffect(() => {
    if (fileMention && fileResults[selectedFileIndex]) fileResultRefs.current[selectedFileIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [fileMention, fileResults, selectedFileIndex]);
  useLayoutEffect(() => {
    const messages = messagesRef.current;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }, [snapshot.items, snapshot.approvals.length, snapshot.questions?.length, snapshot.elicitations?.length, snapshot.pendingPlan, error, snapshot.error]);
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
  }, [historyOpen, historyQuery, historyArchived, sessionId]);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);
  useEffect(() => {
    if (selectionKind) (selectionDialogRef.current?.querySelector<HTMLButtonElement>('button[role="radio"]:not(:disabled)')
      || selectionDialogRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }, [selectionKind]);
  useEffect(() => {
    if (snapshot.provider !== "codebuddy" || !snapshot.threadId) {
      modelMetadataRequestRef.current += 1;
      modelMetadataSessionRef.current = null;
      setModelMetadata([]);
      return;
    }
    const key = `${sessionId}:${snapshot.threadId}`;
    if (!menuOpen && modelMetadataSessionRef.current === key) return;
    if (modelMetadataSessionRef.current !== key) setModelMetadata([]);
    modelMetadataSessionRef.current = key;
    const requestId = ++modelMetadataRequestRef.current;
    void Promise.resolve().then(() => window.codexAppServerApi.listModelMetadata?.(sessionId) ?? []).then(value => {
      if (modelMetadataRequestRef.current === requestId && currentSessionRef.current === sessionId)
        setModelMetadata(Array.isArray(value) ? value : []);
    }).catch(() => { if (modelMetadataRequestRef.current === requestId && currentSessionRef.current === sessionId) setModelMetadata([]); });
  }, [sessionId, snapshot.provider, snapshot.threadId, menuOpen]);
  useEffect(() => {
    if (!capabilityOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!capabilityRef.current?.contains(event.target as Node) && !capabilityButtonRef.current?.contains(event.target as Node)) setCapabilityOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [capabilityOpen]);

  async function loadCapabilities(refresh = false) {
    const threadId = snapshot.threadId;
    setCapabilityLoading(true); setCapabilityError("");
    try {
      const value = await window.codexAppServerApi.listCapabilities(sessionId, refresh);
      if (currentSessionRef.current === sessionId && timelineRef.current?.threadId === threadId) setCapabilities(value);
    } catch (cause) { if (currentSessionRef.current === sessionId) setCapabilityError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setCapabilityLoading(false); }
  }
  function insertCapability(token: string, reference?: CodexCapabilityReference) {
    if (reference && draftReferences.filter(value => draft.includes(value.token) && value.token !== token).length >= 10) {
      setCapabilityError("每条消息最多选择 10 个 Skills 或 Apps。");
      return;
    }
    const input = textareaRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const next = before + prefix + token + suffix + after;
    setDraft(next);
    setDraftReferences(current => {
      const retained = current.filter(value => next.includes(value.token) && value.token !== token);
      return reference ? [...retained, reference] : retained;
    });
    setCapabilityOpen(false);
    window.requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + prefix.length + token.length, start + prefix.length + token.length); });
  }
  function closeFileMention() {
    fileSearchRequestRef.current += 1;
    setFileMention(null);
    setFileResults([]);
    setFileSearchStatus("idle");
    setFileSearchError("");
    setSelectedFileIndex(0);
  }
  function addInlineImage(start: number, end: number, path: string | null) {
    const number = ++imageTokenCounterRef.current;
    const token = `〔图片 ${number}〕`;
    const image = { token, path };
    inlineImagesRef.current = [...inlineImagesRef.current, image];
    setInlineImages(inlineImagesRef.current);
    setDraft(current => current.slice(0, start) + token + current.slice(end));
    window.requestAnimationFrame(() => {
      const caret = start + token.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
    return token;
  }
  function changeDraft(next: string) {
    const removed = inlineImagesRef.current.filter(image => !next.includes(image.token));
    if (removed.length) {
      inlineImagesRef.current = inlineImagesRef.current.filter(image => next.includes(image.token));
      setInlineImages(inlineImagesRef.current);
      setAttachments(current => current.filter(filePath => !removed.some(image => image.path === filePath)));
      for (const image of removed) if (image.path && pastedImagesRef.current.delete(image.path))
        void window.codexAppServerApi.discardImage(sessionId, image.path).catch(cause => setError(message(cause)));
    }
    setDraft(next);
  }
  function selectFile(entry: WorkspaceEntrySearchResult) {
    if (!fileMention) return;
    const token = `@${entry.relativePath} `;
    const next = draft.slice(0, fileMention.start) + token + draft.slice(fileMention.end);
    const caret = fileMention.start + token.length;
    setDraft(next);
    setDraftReferences(current => current.filter(value => next.includes(value.token)));
    closeFileMention();
    window.requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(caret, caret); });
  }

  async function submit() {
    const submittedDraft = draft;
    const ordered = orderedDraft(draft, inlineImages);
    const text = ordered.text;
    const knownErrorIds = new Set(snapshot.items.filter(item => item.type === "turnError").map(item => item.id));
    if (snapshot.archived || (!text && attachments.length === 0) || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null)
      || sending || pastingRef.current) return;
    setSending(true);
    closeFileMention();
    setDraft(""); setError("");
    try {
      const references = draftReferences.filter(value => text.includes(value.token));
      if (inlineImages.length) await window.codexAppServerApi.submit(sessionId, text, attachments, references, ordered.parts);
      else await window.codexAppServerApi.submit(sessionId, text, attachments, references);
      if (currentSessionRef.current === sessionId) { setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; setDraftReferences(current => current.filter(value => !text.includes(value.token))); pastedImagesRef.current.clear(); }
    }
    catch (cause) {
      const recorded = snapshot.provider === "codebuddy" && await hasRecordedCodeBuddyError(sessionId, message(cause), knownErrorIds);
      if (recorded) {
        if (currentSessionRef.current === sessionId) { setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; setDraftReferences(current => current.filter(value => !text.includes(value.token))); pastedImagesRef.current.clear(); }
      } else {
        setDraft(current => current || submittedDraft);
        if (currentSessionRef.current === sessionId) setError(message(cause));
      }
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
        let timeoutId: number | undefined;
        const page = await Promise.race([
          window.codexAppServerApi.listHistory(sessionId, nextCursor, historyArchived),
          new Promise<never>((_resolve, reject) => {
            timeoutId = window.setTimeout(() => reject(new Error("加载历史会话超时，请重试。")), 35000);
          })
        ]).finally(() => window.clearTimeout(timeoutId));
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
    historyRequestRef.current += 1;
    setLoadingHistory(false);
    menuButtonRef.current?.focus();
  }
  async function selectHistory(threadId: string) {
    setResumingHistory(true); setHistoryError("");
    try { const value = await window.codexAppServerApi.resume(sessionId, threadId);
      if (currentSessionRef.current === sessionId) { timelineRef.current = value; setExpandedGroupId(null); setSnapshot(value); closeHistory(); setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; pastedImagesRef.current.clear(); setDraft(""); setDraftReferences([]); setCapabilities(null); setCapabilityOpen(false); } }
    catch (cause) { if (currentSessionRef.current === sessionId) setHistoryError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setResumingHistory(false); }
  }
  async function mutateHistory(threadId: string, action: "rename" | "pin" | "fork" | "archive" | "unarchive", value?: string | boolean) {
    const thread = history.find(item => item.id === threadId);
    if (!thread || historyMutation) return;
    if (action === "archive" && !window.confirm(`归档“${thread.title}”？衍生会话也可能被归档。`)) return;
    setHistoryMutation(threadId); setHistoryError("");
    try {
      if (action === "rename") await window.codexAppServerApi.renameThread(sessionId, threadId, String(value));
      if (action === "pin") {
        const result = await window.codexAppServerApi.pinThread(sessionId, threadId, Boolean(value));
        if (currentSessionRef.current === sessionId) {
          historyRequestRef.current += 1;
          setLoadingHistory(false);
          setHistoryCursor(null);
          setHistory(current => current.map(item => item.id === threadId ? { ...item, isPinned: result.isPinned } : item));
        }
        return;
      }
      if (action === "archive") await window.codexAppServerApi.archiveThread(sessionId, threadId);
      if (action === "unarchive") await window.codexAppServerApi.unarchiveThread(sessionId, threadId);
      if (action === "fork") {
        const next = await window.codexAppServerApi.forkThread(sessionId, threadId);
        if (currentSessionRef.current === sessionId) {
          timelineRef.current = next; setExpandedGroupId(null); setSnapshot(next);
          setDraft(""); setDraftReferences([]); setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; pastedImagesRef.current.clear();
          setCapabilities(null); setCapabilityOpen(false); closeHistory();
        }
      } else if (currentSessionRef.current === sessionId) {
        setRenamingThreadId(null);
        await loadHistory(null, historyQuery);
      }
    } catch (cause) { if (currentSessionRef.current === sessionId) setHistoryError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setHistoryMutation(null); }
  }
  async function addFiles() {
    setError("");
    const input = textareaRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    try { const paths = await window.codexAppServerApi.chooseFiles(sessionId);
      if (currentSessionRef.current === sessionId) {
        const added = paths.filter(filePath => !attachments.includes(filePath)).slice(0, Math.max(0, 10 - attachments.length));
        setAttachments(current => [...new Set([...current, ...added])].slice(0, 10));
        let caret = start;
        for (const filePath of added.filter(sendableImageFile)) {
          const token = addInlineImage(caret, caret === start ? end : caret, filePath);
          caret += token.length;
        }
      } }
    catch (cause) { if (currentSessionRef.current === sessionId) setError(message(cause)); }
  }
  async function pasteImage() {
    if (pastingRef.current || (snapshot.busy && snapshot.provider !== "codex" && snapshot.provider != null)
      || sending || !snapshot.threadId) return;
    if (attachments.length >= 10) { setError("最多附加 10 个文件。"); return; }
    pastingRef.current = true;
    setPastingImage(true);
    setError("");
    const input = textareaRef.current;
    const token = addInlineImage(input?.selectionStart ?? draft.length, input?.selectionEnd ?? draft.length, null);
    try {
      const result = await window.codexAppServerApi.pasteImage(sessionId);
      if (result.status === "no_image") throw new Error("剪贴板中没有可用的图片。");
      if (currentSessionRef.current !== sessionId || !inlineImagesRef.current.some(image => image.token === token)) {
        await window.codexAppServerApi.discardImage(sessionId, result.path);
        return;
      }
      pastedImagesRef.current.add(result.path);
      inlineImagesRef.current = inlineImagesRef.current.map(image => image.token === token ? { ...image, path: result.path } : image);
      setInlineImages(inlineImagesRef.current);
      setAttachments(current => [...current, result.path]);
    } catch (cause) {
      if (currentSessionRef.current === sessionId) {
        setError(message(cause));
        inlineImagesRef.current = inlineImagesRef.current.filter(image => image.token !== token);
        setInlineImages(inlineImagesRef.current);
        setDraft(current => current.replace(token, ""));
      }
    }
    finally { pastingRef.current = false; if (currentSessionRef.current === sessionId) setPastingImage(false); }
  }
  async function removeAttachment(filePath: string) {
    if (pastedImagesRef.current.has(filePath)) {
      try { await window.codexAppServerApi.discardImage(sessionId, filePath); pastedImagesRef.current.delete(filePath); }
      catch (cause) { setError(message(cause)); return; }
    }
    const image = inlineImagesRef.current.find(value => value.path === filePath);
    if (image) {
      inlineImagesRef.current = inlineImagesRef.current.filter(value => value !== image);
      setInlineImages(inlineImagesRef.current);
      setDraft(current => current.replace(image.token, ""));
    }
    setAttachments(current => current.filter(value => value !== filePath));
  }
  async function resolve(requestId: number | string, approved: boolean | string) {
    setError("");
    try { await window.codexAppServerApi.resolveApproval(sessionId, requestId, approved); }
    catch (cause) { setError(message(cause)); }
  }
  function reportChangeError(cause: unknown) {
    if (currentSessionRef.current !== sessionId) return;
    if (selectionKind) setSelectionError(message(cause));
    else setError(message(cause));
  }
  async function changeMode(mode: "default" | "plan") {
    if (!snapshot.threadId || snapshot.busy || changingModeRef.current || mode === snapshot.mode) return false;
    changingModeRef.current = true;
    setChangingMode(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setMode(sessionId, mode);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) {
      reportChangeError(cause);
      return false;
    } finally {
      if (currentSessionRef.current === sessionId) {
        changingModeRef.current = false;
        setChangingMode(false);
      }
    }
  }
  async function changeNativeMode(modeId: string) {
    if (!snapshot.threadId || snapshot.busy || changingModeRef.current || modeId === snapshot.nativeMode
      && !(snapshot.provider === "codebuddy" && modeId === "plan" && !snapshot.readOnlyProtected)) return false;
    changingModeRef.current = true;
    setChangingMode(true); setError("");
    try {
      const value = await window.codexAppServerApi.setNativeMode(sessionId, modeId);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { changingModeRef.current = false; if (currentSessionRef.current === sessionId) setChangingMode(false); }
  }
  async function changePermission(permission: CodexExecutionPermission) {
    if (!snapshot.threadId || snapshot.busy || changingPermissionRef.current || permission === snapshot.executionPermission) return false;
    changingPermissionRef.current = true;
    setChangingPermission(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setExecutionPermission(sessionId, permission);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) {
      reportChangeError(cause);
      return false;
    } finally {
      if (currentSessionRef.current === sessionId) {
        changingPermissionRef.current = false;
        setChangingPermission(false);
      }
    }
  }
  async function changeModel(modelId: string) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || modelId === snapshot.model) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setModel(sessionId, modelId);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
  }
  async function changeEffort(effort: string) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || attachments.length || effort === snapshot.effort) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setEffort(sessionId, effort);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { if (currentSessionRef.current === sessionId) { changingModelRef.current = false; setChangingModel(false); } }
  }
  async function changeContextWindow(value: string) {
    if (!snapshot.threadId || snapshot.busy || changingModelRef.current) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const next = await window.codexAppServerApi.setContextWindow(sessionId, value);
      if (currentSessionRef.current === sessionId) setSnapshot(next);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { changingModelRef.current = false; if (currentSessionRef.current === sessionId) setChangingModel(false); }
  }
  async function changeMultitask(enabled: boolean) {
    if (!snapshot.threadId || changingMultitask) return false;
    setChangingMultitask(true); setError("");
    try {
      const value = await window.codexAppServerApi.setMultitask(sessionId, enabled);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
    finally { if (currentSessionRef.current === sessionId) setChangingMultitask(false); }
  }
  async function sendMemberMessage() {
    const teamName = snapshot.team?.name;
    const memberName = selectedMemberName || snapshot.team?.members[0]?.name;
    const content = memberDraft.trim();
    if (!snapshot.threadId || !teamName || !memberName || !content || sendingMember) return;
    setSendingMember(true); setMemberError("");
    try {
      await window.codexAppServerApi.sendTeamMessage(sessionId, teamName, memberName, content);
      if (currentSessionRef.current === sessionId && timelineRef.current?.threadId === snapshot.threadId
        && timelineRef.current?.team?.name === teamName) setMemberDraft("");
    } catch (cause) { if (currentSessionRef.current === sessionId) setMemberError(message(cause)); }
    finally { if (currentSessionRef.current === sessionId) setSendingMember(false); }
  }
  async function changeFastMode(enabled: boolean) {
    if (!snapshot.threadId || snapshot.busy || sending || changingModelRef.current || attachments.length || enabled === snapshot.fastMode) return false;
    changingModelRef.current = true;
    setChangingModel(true);
    setError("");
    try {
      const value = await window.codexAppServerApi.setFastMode(sessionId, enabled);
      if (currentSessionRef.current === sessionId) setSnapshot(value);
      return true;
    } catch (cause) { reportChangeError(cause); return false; }
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
  const visibleHistory = (normalizedHistoryQuery
    ? history.filter(thread => `${thread.title} ${thread.id}`.toLocaleLowerCase().includes(normalizedHistoryQuery))
    : [...history]).sort((a, b) => Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned)) || b.updatedAt - a.updatedAt);

  const agentName = snapshot.provider === "codebuddy" ? "CodeBuddy" : snapshot.provider === "opencode" ? "OpenCode" : "Codex";
  const canSendWhileBusy = agentName === "Codex" && !snapshot.compacting;
  const acpModel = snapshot.provider === "opencode" || snapshot.provider === "codebuddy"
    ? snapshot.acpOptions?.find(option => option.id === "model" && option.type === "select" && option.options?.length) : undefined;
  const modelDetails = (modelId: string) => {
    if (snapshot.provider !== "codebuddy") return "";
    const metadata = modelMetadata.find(model => model.id === modelId);
    return [metadata?.creditMultiplier ? `倍率 ${metadata.creditMultiplier}` : "", ...(metadata?.promotions.map(promotion => promotion.label) || [])].filter(Boolean).join(" · ");
  };
  const acpEffort = snapshot.provider === "opencode" ? snapshot.acpOptions?.find(option => option.id === "effort" && option.type === "select") : undefined;
  const acpContextWindow = snapshot.provider === "codebuddy" ? snapshot.acpOptions?.find(option => option.id === "context_window" && option.type === "select" && (option.options?.length ?? 0) > 1) : undefined;
  const multitaskOption = snapshot.provider === "codebuddy" && snapshot.capabilities?.multitask === true
    ? snapshot.acpOptions?.find(option => option.id === "multitask" && option.type === "boolean") : undefined;
  const isAcp = snapshot.provider === "codebuddy" || snapshot.provider === "opencode";
  const currentModel = (snapshot.models || []).find(model => model.id === snapshot.model);
  const selectionTitles: Record<SelectionKind, string> = {
    mode: isAcp ? `${agentName} 模式` : "模式", model: "模型", effort: "思考强度",
    fastMode: "快速模式", permission: "执行权限", contextWindow: "上下文窗口", multitask: "Multitask"
  };
  type SelectionOption = { value: string; label: string; description?: string; selected: boolean; disabled?: boolean };
  const selectionOptions: SelectionOption[] = selectionKind === "mode"
    ? isAcp ? (snapshot.nativeModes || []).map(mode => {
      const translation = snapshot.provider === "codebuddy"
        ? (codeBuddyModeDescriptions[normalizeModeKey(mode.id)] || codeBuddyModeDescriptions[normalizeModeKey(mode.name)])
        : undefined;
      return {
        value: mode.id,
        label: mode.name,
        description: snapshot.provider === "codebuddy" ? (translation ?? mode.description) : mode.description,
        selected: snapshot.nativeMode === mode.id && !(snapshot.provider === "codebuddy" && mode.id === "plan" && !snapshot.readOnlyProtected),
        disabled: snapshot.busy || changingMode
      };
    })
      : [{ value: "default", label: "Exec", selected: snapshot.mode === "default", disabled: snapshot.busy || changingMode },
        { value: "plan", label: "Plan", selected: snapshot.mode === "plan", disabled: snapshot.busy || changingMode || snapshot.capabilities?.plan === false }]
    : selectionKind === "model"
      ? acpModel ? (acpModel.options || []).map(option => ({ value: option.value, label: option.name,
        description: modelDetails(option.value), selected: acpModel.currentValue === option.value, disabled: snapshot.busy || changingModel }))
        : (snapshot.models || []).map(model => ({ value: model.id, label: model.displayName, selected: snapshot.model === model.id,
          disabled: snapshot.busy || sending || changingModel || attachments.length > 0 }))
    : selectionKind === "effort"
      ? acpEffort ? (acpEffort.options || []).map(option => ({ value: option.value, label: option.name,
        selected: acpEffort.currentValue === option.value, disabled: snapshot.busy || changingModel }))
        : (currentModel?.supportedReasoningEfforts || []).map(option => ({ value: option.reasoningEffort,
          label: effortLabel(option.reasoningEffort), description: option.description || undefined,
          selected: snapshot.effort === option.reasoningEffort, disabled: snapshot.busy || sending || changingModel || attachments.length > 0 }))
    : selectionKind === "fastMode" ? [false, true].map(value => ({ value: String(value), label: value ? "开启" : "关闭",
      description: value ? "用量成本更高" : undefined, selected: Boolean(snapshot.fastMode) === value,
      disabled: snapshot.busy || sending || changingModel || attachments.length > 0 || !currentModel?.fastAvailable }))
    : selectionKind === "permission" ? (["readOnly", "askApproval", "fullAccess"] as const).map(value => ({ value,
      label: permissionLabels[value], description: permissionDescriptions[value], selected: snapshot.executionPermission === value,
      disabled: snapshot.busy || changingPermission || Boolean(snapshot.capabilities?.supportedPermissions && !snapshot.capabilities.supportedPermissions.includes(value)) }))
    : selectionKind === "contextWindow" ? (acpContextWindow?.options || []).map(option => ({ value: option.value,
      label: option.name, selected: acpContextWindow?.currentValue === option.value, disabled: snapshot.busy || changingModel }))
    : selectionKind === "multitask" ? [false, true].map(value => ({ value: String(value), label: value ? "开启" : "关闭",
      selected: multitaskOption?.currentValue === value, disabled: snapshot.busy || changingMultitask })) : [];
  const selectionNextTurn = selectionKind === "model" || selectionKind === "effort" || selectionKind === "fastMode"
    || selectionKind === "permission" || selectionKind === "contextWindow";
  function openSelection(kind: SelectionKind) { setMenuOpen(false); setSelectionError(""); setSelectionKind(kind); }
  function openCapabilities(tab: "skills" | "apps" | "mcp") {
    setCapabilityTab(tab); setCapabilityQuery(""); setCapabilityOpen(true);
    if (!capabilities) void loadCapabilities();
  }
  function openHistory() { setMenuOpen(false); setHistoryQuery(""); setCopyNotice(null); setHistoryOpen(true); }
  function openGoal() {
    setMenuOpen(false); setGoalOpen(true);
    void window.codexAppServerApi.getGoal(sessionId).catch(cause => {
      if (currentSessionRef.current === sessionId) setError(message(cause));
    });
  }
  function compactConversation() {
    setMenuOpen(false); setError("");
    void window.codexAppServerApi.compactThread(sessionId).catch(cause => {
      if (currentSessionRef.current === sessionId) setError(message(cause));
    });
  }
  function startNewConversation() {
    void window.codexAppServerApi.newThread(sessionId)
      .then(value => { if (currentSessionRef.current === sessionId) { timelineRef.current = value; setExpandedGroupId(null); setSnapshot(value); setDraft(""); setDraftReferences([]); setAttachments([]); setInlineImages([]); inlineImagesRef.current = []; pastedImagesRef.current.clear(); setHistoryOpen(false); setCapabilities(null); setCapabilityOpen(false); } })
      .catch(cause => { if (currentSessionRef.current === sessionId) setError(message(cause)); });
  }
  function closeSelection() { if (selectionPending) return; setSelectionKind(null); setSelectionError(""); menuButtonRef.current?.focus(); }
  async function selectOption(value: string) {
    if (!selectionKind || selectionPending) return;
    const selected = selectionOptions.find(option => option.value === value);
    if (!selected || selected.disabled || selected.selected) return;
    const kind = selectionKind;
    setSelectionPending(true); setSelectionError("");
    let succeeded = false;
    try {
      if (kind === "mode") succeeded = isAcp ? await changeNativeMode(value) : await changeMode(value as "default" | "plan");
      else if (kind === "model") succeeded = await changeModel(value);
      else if (kind === "effort") succeeded = await changeEffort(value);
      else if (kind === "fastMode") succeeded = await changeFastMode(value === "true");
      else if (kind === "permission") succeeded = await changePermission(value as CodexExecutionPermission);
      else if (kind === "contextWindow") succeeded = await changeContextWindow(value);
      else succeeded = await changeMultitask(value === "true");
      if (succeeded && currentSessionRef.current === sessionId) { setSelectionKind(null); menuButtonRef.current?.focus(); }
    } finally { if (currentSessionRef.current === sessionId) setSelectionPending(false); }
  }
  const isCodex = snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode";
  const canAttach = (!snapshot.busy || canSendWhileBusy) && !sending && !pastingImage && attachments.length < 10;
  const localSlashCommands: SlashCommand[] = [
    { id: "new", label: "新对话", disabled: snapshot.busy || sending || pastingImage },
    { id: "history", label: "历史会话", disabled: snapshot.busy || snapshot.capabilities?.history === false },
    ...(isCodex ? [
      { id: "skills", label: "Skills 列表" }, { id: "apps", label: "Apps 列表" }, { id: "mcp", label: "MCP 列表" },
      { id: "plugins", label: "插件管理" },
      { id: "compact", label: "压缩对话", disabled: snapshot.busy || sending },
      { id: "goal", label: "目标管理" }
    ] : []),
    { id: "mode", label: "模式" },
    ...(multitaskOption ? [{ id: "multitask", label: "Multitask" }] : []),
    ...(acpModel || (!isAcp && snapshot.backend === "openai") ? [{ id: "model", label: "模型" }] : []),
    ...(acpContextWindow ? [{ id: "contextWindow", label: "上下文窗口" }] : []),
    ...(acpEffort || (!isAcp && snapshot.backend === "openai" && Boolean(currentModel?.supportedReasoningEfforts?.length)) ? [{ id: "effort", label: "思考强度" }] : []),
    ...(!isAcp && snapshot.backend === "openai" ? [{ id: "fastMode", label: "快速模式" }] : []),
    ...(!isAcp ? [{ id: "permission", label: "执行权限" }] : []),
    { id: "files", label: "附加文件", disabled: !canAttach }
  ];
  const localCommandNames = new Set(localSlashCommands.map(command => command.id.toLocaleLowerCase()));
  const slashCommands: SlashCommand[] = snapshot.provider === "codebuddy"
    ? [...localSlashCommands, ...(snapshot.availableCommands || [])
      .filter(command => !localCommandNames.has(command.name.toLocaleLowerCase()))
      .map(command => ({ id: command.name, label: command.description || "CodeBuddy 命令", source: "codebuddy" as const }))]
    : localSlashCommands;
  const slashQuery = !slashDismissed && /^\/[^\s]*$/.test(draft) ? draft.slice(1).toLocaleLowerCase() : null;
  const visibleSlashCommands = slashQuery === null ? [] : slashCommands.filter(command => `${command.id} ${command.label}`.toLocaleLowerCase().includes(slashQuery));
  function executeSlashCommand(command: SlashCommand) {
    if (command.disabled) return;
    if (command.source === "codebuddy") {
      setSlashDismissed(true); setSelectedSlashIndex(0);
      setDraft(`/${command.id} `);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setSlashDismissed(true); setSelectedSlashIndex(0); setDraft("");
    if (command.id === "new") startNewConversation();
    else if (command.id === "history") openHistory();
    else if (command.id === "skills" || command.id === "apps" || command.id === "mcp") openCapabilities(command.id);
    else if (command.id === "plugins") setPluginOpen(true);
    else if (command.id === "compact") compactConversation();
    else if (command.id === "goal") openGoal();
    else if (command.id === "files") void addFiles();
    else openSelection(command.id as SelectionKind);
  }
  const matchesCapability = (name: string, description: string) => `${name} ${description}`.toLocaleLowerCase().includes(capabilityQuery.trim().toLocaleLowerCase());
  const selectedMember = snapshot.team?.members.find(member => member.name === selectedMemberName) || snapshot.team?.members[0];
  const timeline = useMemo(() => groupTimeline(snapshot), [snapshot]);
  return <section className="codex-app-server-session" aria-label={`${agentName} 图形会话`}>
    {snapshot.provider === "codebuddy" && snapshot.codexInheritance && <div className="codex-inheritance-status" aria-label="Codex 配置继承状态">
      已为此会话准备 Codex Skills {snapshot.codexInheritance.skills.length} 项、MCP {snapshot.codexInheritance.mcpServers.length} 项。
      {snapshot.codexInheritance.skills.length > 0 && <span>技能使用 /codex:名称 调用。</span>}
      <span>修改配置后重启会话以刷新。</span>
      {snapshot.codexInheritance.warnings.map(warning => <span key={warning} role="status">{warning}</span>)}
    </div>}
    {isCodex && (snapshot.backend || "openai") === "openai" && snapshot.account?.status === "signedOut" && <CodexAccountPanel key={sessionId} account={snapshot.account} preferDeviceCode={sessionType !== "windows"} busy={snapshot.busy} actions={{
      readAccount: () => window.codexAppServerApi.readAccount(sessionId),
      startLogin: type => window.codexAppServerApi.startLogin(sessionId, type),
      cancelLogin: () => window.codexAppServerApi.cancelLogin(sessionId),
      logout: () => window.codexAppServerApi.logout(sessionId),
      refreshAccountUsage: () => window.codexAppServerApi.refreshAccountUsage(sessionId)
    }} />}
    <div className={`codex-app-server-conversation-layout${snapshot.provider === "codebuddy" && snapshot.team ? " has-team" : ""}`}>
      <div className="codex-app-server-main-pane">
    {snapshot.provider === "codebuddy" && snapshot.team && <div className="codex-app-server-pane-heading">团队领导 · {snapshot.team.name || "团队加载中"}{snapshot.team.isAutoTeam ? " · 自动团队" : ""}</div>}
    <div ref={messagesRef} className="codex-app-server-messages" aria-live="polite">
      {snapshot.items.length === 0 && !snapshot.busy && <div className="codex-app-server-empty"><span className="codex-app-server-empty-icon"><Sparkles aria-hidden="true" /></span><h2>有什么需要完成？</h2><p>描述你的任务，{agentName} 会在当前项目中协助你。</p><span className="codex-app-server-empty-hint">支持附加文件、粘贴图片与规划模式</span>{(isCodex || snapshot.provider === "codebuddy") && snapshot.threadId && <CodexVersionControl sessionId={sessionId} provider={snapshot.provider === "codebuddy" ? "codebuddy" : "codex"} />}</div>}
      {timeline.map(entry => {
        if (entry.kind === "diagnostic") return <DiagnosticCard key={`diagnostic-${entry.event.id}`} event={entry.event} />;
        if (entry.kind === "diff") return <TurnDiffCard key={`diff-${entry.diff.turnId}`} diff={entry.diff} />;
        if (entry.kind === "tools") {
          const groupId = entry.items[0].id;
          return <ToolGroup key={groupId} items={entry.items} expanded={expandedGroupId === groupId}
            onToggle={() => setExpandedGroupId(current => current === groupId ? null : groupId)} />;
        }
        const item = entry.item;
        if (item.type === "backgroundTurn") return <div className="codex-app-server-background-turn" key={item.id} role="status">后台任务汇总</div>;
        if (item.type === "turnError") return <article className="codex-app-server-message turnError" key={item.id} role="alert">
          <strong>CodeBuddy 运行错误</strong><p>{item.text}</p>
        </article>;
        if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan") return <article className={`codex-app-server-message ${item.type}`} key={item.id}>
          {item.type === "plan" && <strong>计划</strong>}
          {item.type === "userMessage" ? <>{item.parts?.length ? item.parts.map((part, index) => part.type === "text"
            ? <p key={`text-${index}`}>{part.text}</p>
            : <div className="codex-app-server-attachments" key={`image-${index}`}><AttachmentTile sessionId={sessionId}
                file={{ path: part.path, name: part.name }} onPreview={() => setPreviewFile({ path: part.path, name: part.name })} /></div>)
            : item.text && <p>{item.text}</p>}{Boolean(item.attachments?.length) &&
            <div className="codex-app-server-attachments">{item.attachments?.filter(file => !item.parts?.some(part => part.type === "image" && part.path === file.path))
              .map(file => <AttachmentTile key={file.path} sessionId={sessionId} file={file} onPreview={() => setPreviewFile(file)} />)}</div>}</>
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
        if (item.type === "questionAnswer") return <article className="codex-app-server-message questionAnswer" key={item.id} aria-label={`已回答的 ${agentName} 提问`}>
          <strong>{agentName} 提问与回答{item.status === "submitted" ? snapshot.provider === "codebuddy" ? " · 已发送" : " · 正在确认" : item.status === "failed" ? " · 轮次失败" : ""}</strong>
          {item.questions?.map(question => <div className="codex-app-server-answered-question" key={question.id}>
            {question.header && <small>{question.header}</small>}
            <p className="codex-app-server-answered-prompt">{question.question}</p>
            {question.answers.map((answer, index) => <p key={index} className="codex-app-server-answered-answer">
              {answer.startsWith("user_note: ") ? `补充说明：${answer.slice(11)}` : answer}
            </p>)}
          </div>)}
        </article>;
        if (item.type === "contextCompaction") return <article className="codex-app-server-message contextCompaction" key={item.id} role="status">
          {item.status === "failed" ? "上下文压缩失败" : item.status === "completed" ? "上下文压缩完成" : "正在压缩上下文…"}
        </article>;
        return null;
      })}
      {snapshot.compacting && <div className="codex-app-server-compaction-status" role="status">正在压缩当前会话，请等待完成…</div>}
      {!snapshot.compacting && snapshot.compactionStatus === "failed" && !snapshot.error &&
        <div className="codex-app-server-compaction-status" role="alert">上下文压缩失败，请查看会话记录。</div>}
      {snapshot.approvals.map(approval => <article className="codex-app-server-approval" key={approval.requestId}>
        <strong>{approval.params.networkApprovalContext ? "网络访问确认" : approval.method.includes("fileChange") ? "文件修改确认" : "操作确认"}</strong>
        {approval.params.reason && <p>{approval.params.reason}</p>}
        {approval.params.networkApprovalContext && <p>{approval.params.networkApprovalContext.protocol}://{approval.params.networkApprovalContext.host}{approval.params.networkApprovalContext.port ? `:${approval.params.networkApprovalContext.port}` : ""}</p>}
        {approval.params.cwd && <p>{approval.params.cwd}</p>}
        {isCodex && approval.method === "item/fileChange/requestApproval" && approval.params.grantRoot && <p>授权目录：{approval.params.grantRoot}</p>}
        {isCodex && approval.method === "item/permissions/requestApproval" && <pre>{JSON.stringify(approval.params.permissions || {}, null, 2)}</pre>}
        {(approval.params.command || snapshot.items.find(item => item.id === approval.params.itemId)?.command) &&
          <pre>{approval.params.command || snapshot.items.find(item => item.id === approval.params.itemId)?.command}</pre>}
        {(approval.params.changes ?? snapshot.items.find(item => item.id === approval.params.itemId)?.changes) != null &&
          <pre>{JSON.stringify(approval.params.changes ?? snapshot.items.find(item => item.id === approval.params.itemId)?.changes, null, 2)}</pre>}
        {isCodex && approval.method === "item/commandExecution/requestApproval"
          && validExecpolicyAmendment(approval.params.proposedExecpolicyAmendment)
          && approvalAllows(approval, "acceptWithExecpolicyAmendment")
          && <p>建议放行的命令前缀：<code>{JSON.stringify(approval.params.proposedExecpolicyAmendment)}</code></p>}
        <div>{!isCodex && approval.params.choices?.length ? approval.params.choices.map(choice =>
          <button type="button" key={choice.id} onClick={() => void resolve(approval.requestId, choice.id)}>{choice.label}</button>) : <>
          {(!isCodex || approvalAllows(approval, "decline")) && <button type="button" onClick={() => void resolve(approval.requestId, isCodex ? "decline" : false)}>拒绝</button>}
          {isCodex && approval.method !== "item/permissions/requestApproval" && approvalAllows(approval, "cancel") &&
            <button type="button" onClick={() => void resolve(approval.requestId, "cancel")}>取消并停止本回合</button>}
          {(!isCodex || approvalAllows(approval, "accept")) && <button type="button" onClick={() => void resolve(approval.requestId, isCodex ? "accept" : true)}>{isCodex && approval.method === "item/permissions/requestApproval" ? "本回合允许" : "批准一次"}</button>}
          {isCodex && approvalAllows(approval, "acceptForSession") && <button type="button" onClick={() => void resolve(approval.requestId, "acceptForSession")}>本会话允许</button>}
          {isCodex && approval.method === "item/commandExecution/requestApproval"
            && validExecpolicyAmendment(approval.params.proposedExecpolicyAmendment)
            && approvalAllows(approval, "acceptWithExecpolicyAmendment")
            && <button type="button" onClick={() => void resolve(approval.requestId, "acceptWithExecpolicyAmendment")}>批准并应用命令规则</button>}
        </>}</div>
      </article>)}
      {snapshot.questions?.filter(question => !question.submitting || !snapshot.items.some(item => item.id === `question-answer:${question.params.turnId}:${question.requestId}`))
        .map(question => <QuestionCard key={question.requestId} sessionId={sessionId} request={question}
          provider={snapshot.provider === "codebuddy" ? "codebuddy" : "codex"} />)}
      {snapshot.elicitations?.map(request => <McpElicitationCard key={request.requestId} sessionId={sessionId} request={request} />)}
      {(error || (snapshot.error !== dismissedSnapshotError && snapshot.error)) &&
        <div className="codex-app-server-error" role="alert">
          <span>{error || snapshot.error}</span>
          <button type="button" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => {
            setError("");
            setDismissedSnapshotError(snapshot.error);
          }}><X aria-hidden="true" /></button>
        </div>}
    </div>
    <form className="codex-app-server-composer" onSubmit={event => {
      event.preventDefault();
      if (slashQuery !== null) {
        const command = visibleSlashCommands[selectedSlashIndex];
        if (command && !command.disabled) executeSlashCommand(command);
      } else void submit();
    }}>
      {attachments.length > 0 && <div className="codex-app-server-attachments">{attachments.map(filePath => <AttachmentTile key={filePath} sessionId={sessionId}
        file={{ path: filePath, name: fileName(filePath) }} onPreview={() => setPreviewFile({ path: filePath, name: fileName(filePath) })}
        onRemove={() => void removeAttachment(filePath)} disabled={(snapshot.busy && !canSendWhileBusy) || sending || pastingImage} />)}</div>}
      {slashQuery !== null && <div id={slashListId} className="codex-app-server-slash-commands" role="listbox" aria-label="会话操作联想">
        <div className="codex-app-server-file-mentions-heading">会话操作</div>
        {visibleSlashCommands.length === 0 ? <div className="codex-app-server-file-mentions-empty">没有匹配的操作</div>
          : visibleSlashCommands.map((command, index) => <button key={command.id} type="button" role="option"
              id={`${slashListId}-option-${index}`} aria-label={`/${command.id} ${command.label}`} aria-selected={index === selectedSlashIndex} disabled={command.disabled}
              className={index === selectedSlashIndex ? "selected" : ""} onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setSelectedSlashIndex(index)} onClick={() => executeSlashCommand(command)}>
              <span>/{command.id}</span><small>{command.label}</small>
            </button>)}
      </div>}
      {fileMention && slashQuery === null && <div id={fileListId} className="codex-app-server-file-mentions" role="listbox" aria-label="搜索工作区文件">
        <div className="codex-app-server-file-mentions-heading">搜索工作区文件{fileSearchStatus === "loading" ? " · 搜索中..." : ""}</div>
        {fileSearchStatus === "error" ? <div className="codex-app-server-file-mentions-empty" role="alert">搜索失败：{fileSearchError}</div>
          : fileSearchStatus === "ready" && fileResults.length === 0 ? <div className="codex-app-server-file-mentions-empty">没有匹配文件</div>
          : fileResults.map((entry, index) => <button key={entry.path} ref={element => { fileResultRefs.current[index] = element; }}
              id={`${fileListId}-option-${index}`} type="button" role="option" aria-selected={index === selectedFileIndex}
              className={index === selectedFileIndex ? "selected" : ""} onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setSelectedFileIndex(index)} onClick={() => selectFile(entry)}>
              <FileIcon aria-hidden="true" /><span>{entry.name}</span><small>{entry.relativePath}</small>
            </button>)}
      </div>}
      <div className={`codex-app-server-input-border${snapshot.busy ? " is-running" : ""}`} data-mode={snapshot.mode}><textarea ref={textareaRef} value={draft} onChange={event => {
        const next = event.target.value;
        changeDraft(next);
        setSlashDismissed(false); setSelectedSlashIndex(0);
        setDraftReferences(current => current.filter(value => next.includes(value.token)));
        const mention = fileMentionAtCaret(next, event.target.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onClick={event => {
        const mention = fileMentionAtCaret(draft, event.currentTarget.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onCompositionEnd={event => {
        const mention = fileMentionAtCaret(event.currentTarget.value, event.currentTarget.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onKeyUp={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const mention = fileMentionAtCaret(event.currentTarget.value, event.currentTarget.selectionStart);
        if (mention) setFileMention(mention);
        else closeFileMention();
      }} onPaste={event => {
        if (!Array.from(event.clipboardData.items).some(item => item.type.startsWith("image/"))) return;
        event.preventDefault();
        void pasteImage();
      }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (slashQuery !== null && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedSlashIndex(current => visibleSlashCommands.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + visibleSlashCommands.length) % visibleSlashCommands.length : 0);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const command = visibleSlashCommands[selectedSlashIndex];
            if (command && !command.disabled) executeSlashCommand(command);
            return;
          }
          if (event.key === "Escape") { event.preventDefault(); setSlashDismissed(true); return; }
        }
        if (fileMention && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedFileIndex(current => fileResults.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + fileResults.length) % fileResults.length : 0);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab" && fileResults.length > 0) {
            event.preventDefault();
            if (fileResults[selectedFileIndex]) selectFile(fileResults[selectedFileIndex]);
            return;
          }
          if (event.key === "Escape") { event.preventDefault(); closeFileMention(); return; }
        }
        if (snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void changeMode(snapshot.mode === "plan" ? "default" : "plan");
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} aria-label="图形对话输入" aria-autocomplete="list" aria-controls={slashQuery !== null ? slashListId : fileMention ? fileListId : undefined}
        aria-expanded={slashQuery !== null || Boolean(fileMention)} aria-activedescendant={slashQuery !== null && visibleSlashCommands[selectedSlashIndex] ? `${slashListId}-option-${selectedSlashIndex}` : fileMention && fileResults[selectedFileIndex] ? `${fileListId}-option-${selectedFileIndex}` : undefined}
        placeholder={snapshot.account?.status === "signedOut" ? "请先登录 Codex 账号" : snapshot.archived ? "此会话已归档，请先恢复归档" : `向 ${agentName} 发送消息`} disabled={!snapshot.threadId || snapshot.account?.status === "signedOut" || snapshot.archived || (snapshot.busy && !canSendWhileBusy)} />
        <div className="codex-app-server-input-actions">
          {isCodex && <div className="codex-app-server-capability-anchor">
            <button ref={capabilityButtonRef} type="button" className="codex-app-server-icon-button" title="Skills、Apps 和 MCP" aria-label="Skills、Apps 和 MCP" aria-expanded={capabilityOpen} disabled={!snapshot.threadId}
              onClick={() => { if (capabilityOpen) setCapabilityOpen(false); else openCapabilities(capabilityTab); }}><BookOpen aria-hidden="true" /></button>
            {capabilityOpen && <div ref={capabilityRef} className="codex-app-server-capability-picker" role="dialog" aria-label="选择会话能力" onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); setCapabilityOpen(false); capabilityButtonRef.current?.focus(); }
            }}>
              <div className="codex-app-server-capability-tabs" role="tablist" aria-label="能力类型">
                {(["skills", "apps", "mcp"] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={capabilityTab === tab}
                  onClick={() => { setCapabilityTab(tab); setCapabilityQuery(""); }}>{tab === "skills" ? "Skills" : tab === "apps" ? "Apps" : "MCP"}</button>)}
              </div>
              <div className="codex-app-server-capability-search"><input autoFocus type="search" value={capabilityQuery} onChange={event => setCapabilityQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} placeholder="搜索能力" aria-label="搜索能力" />
                <button type="button" aria-label="刷新能力" title="刷新能力" disabled={capabilityLoading} onClick={() => void loadCapabilities(true)}><RefreshCw aria-hidden="true" /></button></div>
              <div className="codex-app-server-capability-list">
                {capabilityLoading && <p>正在读取当前会话能力…</p>}
                {capabilityError && <p role="alert">{capabilityError}</p>}
                {capabilities?.errors[capabilityTab] && <p role="alert">{capabilities.errors[capabilityTab]}</p>}
                {!capabilityLoading && capabilityTab === "skills" && capabilities?.skills.filter(skill => matchesCapability(skill.name, skill.description)).map(skill =>
                  <button key={skill.path} type="button" disabled={!skill.enabled} onClick={() => insertCapability(`$${skill.name}`, { kind: "skill", name: skill.name, path: skill.path, token: `$${skill.name}` })}>
                    <BookOpen aria-hidden="true" /><span><strong>{skill.name}</strong><small>{skill.description || skill.scope}</small></span>{!skill.enabled && <em>已停用</em>}</button>)}
                {!capabilityLoading && capabilityTab === "apps" && capabilities?.apps.filter(app => matchesCapability(app.name, app.description)).map(app =>
                  <button key={app.id} type="button" disabled={!app.accessible || !app.enabled || !app.callable} onClick={() => insertCapability(`$${app.id}`, { kind: "app", name: app.name, path: `app://${app.id}`, token: `$${app.id}` })}>
                    <Globe2 aria-hidden="true" /><span><strong>{app.name}</strong><small>{app.description}</small></span>{(!app.accessible || !app.enabled || !app.callable) && <em>不可用</em>}</button>)}
                {!capabilityLoading && capabilityTab === "mcp" && capabilities?.mcp.filter(server => matchesCapability(server.name, server.tools.map(tool => `${tool.name} ${tool.description}`).join(" "))).map(server =>
                  <div className="codex-app-server-capability-server" key={server.name}><strong><Cable aria-hidden="true" />{server.name}<small>{server.status}</small></strong>
                    {server.toolsError && <p role="alert">{server.toolsError}</p>}
                    {server.tools.filter(tool => matchesCapability(server.name, `${tool.name} ${tool.description}`)).map(tool =>
                      <button key={tool.name} type="button" disabled={server.status !== "connected"} onClick={() => insertCapability(`请使用 MCP 工具 mcp__${server.name}__${tool.name}`)}>
                        <Wrench aria-hidden="true" /><span><strong>{tool.name}</strong><small>{tool.description}</small></span></button>)}
                  </div>)}
                {!capabilityLoading && capabilities && !capabilities.errors[capabilityTab] &&
                  ((capabilityTab === "skills" && !capabilities.skills.some(skill => matchesCapability(skill.name, skill.description)))
                    || (capabilityTab === "apps" && !capabilities.apps.some(app => matchesCapability(app.name, app.description)))
                    || (capabilityTab === "mcp" && !capabilities.mcp.some(server => matchesCapability(server.name, server.tools.map(tool => `${tool.name} ${tool.description}`).join(" "))))) && <p>没有匹配的能力。</p>}
              </div>
            </div>}
          </div>}
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
              <button type="button" role="menuitem" disabled={snapshot.busy || snapshot.capabilities?.history === false} title={snapshot.capabilities?.history === false ? `当前 ${agentName} CLI 不支持历史会话恢复` : undefined} onClick={openHistory}><History aria-hidden="true" />历史会话</button>
              {snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && <>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setPluginOpen(true); }}><Package aria-hidden="true" />插件管理</button>
                <button type="button" role="menuitem" disabled={snapshot.busy || sending} onClick={compactConversation}><Minimize2 aria-hidden="true" />压缩对话</button>
                <button type="button" role="menuitem" onClick={openGoal}><Target aria-hidden="true" />目标管理</button>
              </>}
              <button type="button" role="menuitem" onClick={() => openSelection("mode")}>模式 <small>{isAcp ? snapshot.provider === "codebuddy" && snapshot.nativeMode === "plan" && !snapshot.readOnlyProtected
                ? "Plan · 只读未生效" : snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || "默认"
                : snapshot.mode === "plan" ? "Plan" : "Exec"}</small></button>
              {multitaskOption && <button type="button" role="menuitem" onClick={() => openSelection("multitask")}>Multitask <small>{multitaskOption.currentValue === true ? "开启" : "关闭"}</small></button>}
              {(acpModel || (!isAcp && snapshot.backend === "openai")) && <button type="button" role="menuitem" onClick={() => openSelection("model")}>模型 <small>{acpModel ? acpModel.options?.find(option => option.value === acpModel.currentValue)?.name || acpModel.currentValue : currentModel?.displayName || "默认模型"}</small></button>}
              {acpContextWindow && <button type="button" role="menuitem" onClick={() => openSelection("contextWindow")}>上下文窗口 <small>{acpContextWindow.options?.find(option => option.value === acpContextWindow.currentValue)?.name || acpContextWindow.currentValue}</small></button>}
              {(acpEffort || (!isAcp && snapshot.backend === "openai" && Boolean(currentModel?.supportedReasoningEfforts?.length))) && <button type="button" role="menuitem" onClick={() => openSelection("effort")}>思考强度 <small>{acpEffort ? acpEffort.options?.find(option => option.value === acpEffort.currentValue)?.name || acpEffort.currentValue : snapshot.effort ? effortLabel(snapshot.effort) : "默认"}</small></button>}
              {!isAcp && snapshot.backend === "openai" && <button type="button" role="menuitem" onClick={() => openSelection("fastMode")}>快速模式 <small>{snapshot.fastMode ? "开启" : "关闭"}</small></button>}
              {!isAcp && <button type="button" role="menuitem" onClick={() => openSelection("permission")}>执行权限 <small>{permissionLabels[snapshot.executionPermission]}</small></button>}
              <button type="button" role="menuitem" disabled={!canAttach} onClick={() => { setMenuOpen(false); textareaRef.current?.focus(); void addFiles(); }}><Paperclip aria-hidden="true" />附加文件</button>
            </div>}
          </div>
          <span className="codex-app-server-permission-status" data-permission={snapshot.executionPermission}>{snapshot.provider === "codebuddy" || snapshot.provider === "opencode"
            ? `模式：${snapshot.nativeModes?.find(mode => mode.id === snapshot.nativeMode)?.name || snapshot.nativeMode || "默认"}${snapshot.provider === "codebuddy" && snapshot.nativeMode === "plan" && !snapshot.readOnlyProtected ? " · 只读未生效" : ""}`
            : `执行权限：${permissionLabels[snapshot.executionPermission] || "需要确认"}`}</span>
          {snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && snapshot.goal && <button type="button" className="codex-app-server-goal-chip"
            title={snapshot.goal.objective} onClick={() => setGoalOpen(true)}><Target aria-hidden="true" />{snapshot.goal.status === "active" ? "目标进行中" : snapshot.goal.status === "paused" ? "目标已暂停" : "目标已结束"}</button>}
          {snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && snapshot.backend === "openai" && <span className="codex-app-server-permission-status">{(snapshot.models || []).find(model => model.id === snapshot.model)?.displayName || snapshot.model || "默认模型"}{snapshot.effort ? ` · ${effortLabel(snapshot.effort)}` : ""}{snapshot.fastMode ? " · 快速" : ""}</span>}
          {acpModel && <span className="codex-app-server-permission-status">{acpModel.options?.find(option => option.value === acpModel.currentValue)?.name || acpModel.currentValue || "默认模型"}{typeof acpModel.currentValue === "string" && modelDetails(acpModel.currentValue) ? ` · ${modelDetails(acpModel.currentValue)}` : ""}{acpEffort?.currentValue ? ` · ${acpEffort.options?.find(option => option.value === acpEffort.currentValue)?.name || acpEffort.currentValue}` : ""}{acpContextWindow?.currentValue ? ` · ${acpContextWindow.options?.find(option => option.value === acpContextWindow.currentValue)?.name || acpContextWindow.currentValue}` : ""}</span>}
          {!acpModel && acpContextWindow?.currentValue && <span className="codex-app-server-permission-status">上下文窗口：{acpContextWindow.options?.find(option => option.value === acpContextWindow.currentValue)?.name || acpContextWindow.currentValue}</span>}
          <span className="codex-app-server-shortcuts">Enter 发送 · Shift+Enter 换行</span>
          {copyNotice?.scope === "main" && <span className="codex-app-server-copy-notice" role="status">{copyNotice.text}</span>}
          <div className="codex-app-server-input-primary">
            <button type="button" className="codex-app-server-icon-button" title="复制会话 ID" aria-label="复制会话 ID" disabled={!snapshot.threadId}
              onClick={() => { if (snapshot.threadId) void copyText(snapshot.threadId, "会话 ID"); }}><Copy aria-hidden="true" /></button>
            <button type="button" className="codex-app-server-icon-button" title="新对话" aria-label="新对话" disabled={!snapshot.threadId || snapshot.busy || sending || pastingImage} onClick={startNewConversation}><Plus aria-hidden="true" /></button>
            {snapshot.busy && <button type="button" className="codex-app-server-send" title="停止" aria-label="停止" onClick={() => void window.codexAppServerApi.interrupt(sessionId).catch(cause => setError(message(cause)))}><Square aria-hidden="true" /></button>}
            {(!snapshot.busy || canSendWhileBusy) && <button type="submit" className="codex-app-server-send" title="发送" aria-label="发送" disabled={!snapshot.threadId || snapshot.account?.status === "signedOut" || snapshot.archived || sending || pastingImage || (!draft.trim() && attachments.length === 0)}><ArrowUp aria-hidden="true" /></button>}
          </div>
        </div>
      </div>
    </form>
      </div>
      {snapshot.provider === "codebuddy" && snapshot.team && <aside className="codex-app-server-team-pane" aria-label="Agent Teams">
        <div className="codex-app-server-team-heading"><strong>Agent Teams</strong><span>{snapshot.team.name || "团队加载中"}{snapshot.team.isAutoTeam ? " · 自动团队" : ""}</span></div>
        <div className="codex-app-server-team-members" role="tablist" aria-label="团队成员">
          {snapshot.team.members.map(member => <button key={member.name} type="button" role="tab" aria-selected={selectedMember?.name === member.name}
            onClick={() => { if (member.name !== selectedMember?.name) setMemberDraft(""); setSelectedMemberName(member.name); setMemberError(""); }}>
            <span className="codex-app-server-team-dot" data-status={member.status} />
            <strong>{member.name}</strong><small>{teamStatusLabels[member.status] || member.status}</small>
          </button>)}
        </div>
        {selectedMember ? <>
          <div className="codex-app-server-team-member-detail"><strong>{selectedMember.name}</strong>
            <span>{teamStatusLabels[selectedMember.status] || selectedMember.status}</span>
            {selectedMember.description && <p>{selectedMember.description}</p>}
            {(selectedMember.tokenUsage || selectedMember.toolCallCount != null) && <small>
              {selectedMember.tokenUsage ? `输入 ${selectedMember.tokenUsage.inputTokens || 0} · 输出 ${selectedMember.tokenUsage.outputTokens || 0}` : ""}
              {selectedMember.toolCallCount != null ? ` · 工具 ${selectedMember.toolCallCount}` : ""}
            </small>}
          </div>
          <TeamMemberTimeline key={`${snapshot.threadId}:${snapshot.team.name}:${selectedMember.name}`} member={selectedMember} onLinkClick={onLinkClick} />
          <form className="codex-app-server-team-composer" onSubmit={event => { event.preventDefault(); void sendMemberMessage(); }}>
            <label htmlFor="codebuddy-team-message">发给 {selectedMember.name}</label>
            <textarea id="codebuddy-team-message" value={memberDraft} onChange={event => setMemberDraft(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMemberMessage(); } }}
              disabled={sendingMember || selectedMember.status === "removed"} placeholder="给成员发送消息…" />
            {memberError && <p role="alert">{memberError}</p>}
            <button type="submit" disabled={!memberDraft.trim() || sendingMember || selectedMember.status === "removed"}>{sendingMember ? "发送中…" : "发送给成员"}</button>
          </form>
        </> : <p className="codex-app-server-team-empty">团队尚无成员。</p>}
      </aside>}
    </div>
    {selectionKind && <div className="modal-overlay codex-app-server-selection-overlay" onMouseDown={event => { if (event.target === event.currentTarget) closeSelection(); }}>
      <div ref={selectionDialogRef} className="modal-dialog codex-app-server-selection-dialog" role="dialog" aria-modal="true"
        aria-labelledby="codex-app-server-selection-title" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSelection(); return; }
          if (event.key !== "Tab") return;
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
        }}>
        <div className="codex-app-server-selection-header"><h2 id="codex-app-server-selection-title">{selectionTitles[selectionKind]}</h2>
          <button type="button" aria-label={`关闭${selectionTitles[selectionKind]}`} disabled={selectionPending} onClick={closeSelection}><X aria-hidden="true" /></button></div>
        {selectionNextTurn && <p className="codex-app-server-selection-hint">下一轮生效{selectionKind === "fastMode" ? " · 开启后用量成本更高" : ""}</p>}
        <div className="codex-app-server-selection-options" role="radiogroup" aria-label={selectionTitles[selectionKind]}>
          {selectionOptions.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.selected}
            disabled={selectionPending || option.disabled} onClick={() => void selectOption(option.value)}>
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </button>)}
          {selectionOptions.length === 0 && <p>当前会话没有可选项。</p>}
        </div>
        {selectionError && <p className="codex-app-server-selection-error" role="alert">{selectionError}</p>}
        <div className="codex-app-server-selection-actions"><button type="button" disabled={selectionPending} onClick={closeSelection}>取消</button></div>
      </div>
    </div>}
    {goalOpen && snapshot.provider !== "codebuddy" && snapshot.provider !== "opencode" && <CodexGoalDialog
      key={`${sessionId}:${snapshot.threadId}`} sessionId={sessionId} snapshot={snapshot} onClose={() => setGoalOpen(false)}
      onUpdated={value => { if (currentSessionRef.current === sessionId && value.threadId === snapshot.threadId) setSnapshot(value); }} />}
    {pluginOpen && isCodex && <CodexPluginDialog key={sessionId} sessionId={sessionId} onClose={() => setPluginOpen(false)}
      onChanged={() => { setCapabilities(null); }} />}
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
        {isCodex && <div className="codex-app-server-history-tabs" role="tablist" aria-label="会话状态">
          <button type="button" role="tab" aria-selected={!historyArchived} onClick={() => setHistoryArchived(false)}>进行中</button>
          <button type="button" role="tab" aria-selected={historyArchived} onClick={() => setHistoryArchived(true)}>已归档</button>
        </div>}
        <div className="codex-app-server-history-search"><input autoFocus type="search" aria-label="搜索历史会话" placeholder="搜索标题或会话 ID" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></div>
        {copyNotice?.scope === "history" && <p className="codex-app-server-history-copy-notice" role="status">{copyNotice.text}</p>}
        <div className="codex-app-server-history" aria-label="历史会话列表">
          {visibleHistory.map(thread => <div className="codex-app-server-history-row" key={thread.id}>
            {renamingThreadId === thread.id ? <form className="codex-app-server-history-rename" onSubmit={event => { event.preventDefault(); if (renameDraft.trim()) void mutateHistory(thread.id, "rename", renameDraft); }}>
              <input autoFocus aria-label={`重命名 ${thread.title}`} value={renameDraft} onChange={event => setRenameDraft(event.target.value)} />
              <button type="submit" disabled={!renameDraft.trim() || Boolean(historyMutation)}>保存</button>
              <button type="button" onClick={() => setRenamingThreadId(null)}>取消</button>
            </form> : <button type="button" className="codex-app-server-history-select" disabled={snapshot.busy || sending || pastingImage || resumingHistory || Boolean(historyMutation) || Boolean(thread.archived) || thread.id === snapshot.threadId} onClick={() => void selectHistory(thread.id)}>
              <strong>{thread.isPinned ? "📌 " : ""}{thread.title}</strong><small>会话 ID：{thread.id}</small><span>{new Date(thread.updatedAt * 1000).toLocaleString()} · {thread.source}</span>
            </button>}
            <div className="codex-app-server-history-actions">
              <button type="button" aria-label={`复制会话 ID：${thread.id}`} onClick={() => void copyText(thread.id, "会话 ID", "history")}>复制 ID</button>
              {isCodex && <button type="button" disabled={Boolean(historyCopyingThreadId)} aria-label={`复制首条用户输入：${thread.id}`}
                onClick={() => void copyInitialUserInput(thread.id)}>{historyCopyingThreadId === thread.id ? "读取中…" : "复制首条输入"}</button>}
              {isCodex && <>
              <button type="button" disabled={Boolean(historyMutation)} onClick={() => { setRenamingThreadId(thread.id); setRenameDraft(thread.title); }}>重命名</button>
              <button type="button" disabled={Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "pin", !thread.isPinned)}>{thread.isPinned ? "取消置顶" : "置顶"}</button>
              {thread.archived ? <button type="button" disabled={Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "unarchive")}>恢复归档</button> : <>
                <button type="button" disabled={snapshot.busy || Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "fork")}>分叉</button>
                <button type="button" disabled={thread.id === snapshot.threadId && snapshot.busy || Boolean(historyMutation)} onClick={() => void mutateHistory(thread.id, "archive")}>归档</button>
              </>}
              </>}
            </div>
          </div>)}
          {visibleHistory.length === 0 && !loadingHistory && !historyError && <p>{normalizedHistoryQuery ? "没有匹配的历史会话。" : historyArchived ? "当前项目没有已归档会话。" : "当前项目没有历史会话。"}</p>}
          {historyError && <p className="codex-app-server-history-error" role="alert">{historyError}</p>}
          {historyError && <div className="codex-app-server-history-actions"><button type="button" onClick={() => void loadHistory(null, historyQuery)}>重试加载</button></div>}
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
