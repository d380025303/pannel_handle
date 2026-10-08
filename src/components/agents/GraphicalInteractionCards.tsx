import { useEffect, useId, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import type { CodexMcpElicitation, CodexQuestionAnswer, CodexQuestionRequest } from "../../vite-env";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const imageFile = (name: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);

export function AttachmentTile({ sessionId, file, onPreview, onRemove, disabled }: {
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

export function QuestionCard({ sessionId, request, provider }: { sessionId: string; request: CodexQuestionRequest; provider: "codex" | "codebuddy" | "claude" | "opencode" }) {
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
      if (question.required !== false && !choice.length && !note) { setActiveIndex(index); setError(`请回答「${question.header || question.question}」。`); return; }
      if (question.required !== false && question.options?.length && !choice.length && !question.isOther) {
        setActiveIndex(index); setError(`请选择「${question.header || question.question}」的选项。`); return;
      }
      answers[question.id] = { answers: provider === "codebuddy" || provider === "claude" || provider === "opencode"
        ? [...(question.multiSelect ? choice : note ? [] : choice), ...(note ? [note] : [])]
        : [...choice, ...(note ? [`user_note: ${note}`] : [])],
        ...(provider === "opencode" && note && question.options?.length ? { customAnswer: note } : {}) };
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
  const agentName = provider === "codebuddy" ? "CodeBuddy" : provider === "claude" ? "Claude" : provider === "opencode" ? "OpenCode" : "Codex";
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
             : [option.label] })); if (provider !== "codex" && !question.multiSelect) setNotes(current => ({ ...current, [question.id]: "" })); setError(""); }} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>)}
      {(provider !== "claude" && provider !== "opencode" || question.isOther) && <label className="codex-app-server-question-note">
        <span>{question.options?.length ? provider === "codebuddy" ? "自定义回答" : "补充说明或自定义回答" : "回答"}</span>
         {question.isSecret ? <input type="password" value={notes[question.id] || ""} disabled={sending || request.submitting}
           onChange={event => { setNotes(current => ({ ...current, [question.id]: event.target.value }));
             if (provider !== "codex" && !question.multiSelect) setChoices(current => ({ ...current, [question.id]: [] })); setError(""); }} />
          : <textarea value={notes[question.id] || ""} disabled={sending || request.submitting}
             onChange={event => { setNotes(current => ({ ...current, [question.id]: event.target.value }));
               if (provider !== "codex" && !question.multiSelect) setChoices(current => ({ ...current, [question.id]: [] })); setError(""); }} />}
      </label>}
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={sending || request.submitting || !questions.length} onClick={() => void answer()}>
      {sending || request.submitting ? "正在提交…" : "提交回答"}
    </button>
    {(provider === "codebuddy" || provider === "claude" || provider === "opencode") && <button type="button" disabled={sending || request.submitting} onClick={() => void cancel()}>取消提问</button>}
  </article>;
}

export function McpElicitationCard({ sessionId, request, onRespond, onOpenUrl }: { sessionId: string; request: CodexMcpElicitation;
  onRespond?: (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => Promise<void>;
  onOpenUrl?: (url: string) => Promise<void>;
}) {
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
    try { if (onRespond) await onRespond(action, content || undefined); else await window.codexAppServerApi.resolveElicitation(sessionId, request.requestId, action, content); }
    catch (cause) { setError(message(cause)); }
    finally { setSending(false); }
  }
  async function openUrl() {
    if (!params.url) return;
    if (onOpenUrl) await onOpenUrl(params.url); else await window.externalLinkApi.open(params.url);
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

