import { useEffect, useRef, useState } from "react";
import { Copy, LoaderCircle, MessageSquare, Send, X } from "lucide-react";
import type { CodexAppServerSnapshot } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";
import "./CodeBuddySideQuestionDialog.css";

type Props = { api?: typeof window.codexAppServerApi; copyText?: (text: string) => Promise<boolean>; sessionId: string; snapshot: CodexAppServerSnapshot; initialQuestion?: string;
  onClose: () => void; onUpdated: (snapshot: CodexAppServerSnapshot) => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodeBuddySideQuestionDialog({ api = window.codexAppServerApi, copyText = text => window.clipboardApi.writeText(text), sessionId, snapshot, initialQuestion = "", onClose, onUpdated }: Props) {
  const state = snapshot.sideQuestion;
  const [question, setQuestion] = useState(initialQuestion || state?.question || "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const initialized = useRef(false);
  const request = useRef(state?.status === "running" ? state.requestId : null);
  const pendingRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [copied, setCopied] = useState(false);
  const running = pending || state?.status === "running";

  useEffect(() => { request.current = state?.status === "running" ? state.requestId : null; }, [state]);
  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
    else dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) {
        dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      mounted.current = false;
      document.removeEventListener("focusin", containFocus);
      if (request.current) void api.cancelSideQuestion(sessionId, request.current).catch(() => {});
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [sessionId]);
  useEffect(() => {
    if (running && document.activeElement === inputRef.current) dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [running]);

  async function ask(value = question) {
    if (!value.trim() || value.length > 8000 || pendingRef.current || state?.status === "running") return;
    pendingRef.current = true; setPending(true); setError(""); setCopied(false);
    try {
      const updated = await api.askSideQuestion(sessionId, value);
      request.current = updated.sideQuestion?.status === "running" ? updated.sideQuestion.requestId : null;
      if (!mounted.current) {
        if (request.current) await api.cancelSideQuestion(sessionId, request.current);
        return;
      }
      onUpdated(updated);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  }
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      if (initialQuestion) void ask(initialQuestion);
    }
  });

  async function cancel() {
    if (!request.current || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setError("");
    try {
      const updated = await api.cancelSideQuestion(sessionId, request.current);
      if (mounted.current) onUpdated(updated);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  }

  return <div className="modal-overlay" onClick={onClose}>
    <section ref={dialogRef} className="modal-dialog codebuddy-side-dialog" role="dialog" aria-modal="true" aria-label="CodeBuddy 旁问"
      onClick={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape" && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); onClose(); }
        if (event.key === "Tab") {
          const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'));
          if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
        }
      }}>
      <div className="codebuddy-side-header"><h2><MessageSquare aria-hidden="true" />CodeBuddy 旁问</h2><button type="button" aria-label="关闭旁问" onClick={onClose}><X aria-hidden="true" /></button></div>
      <div className="codebuddy-side-content">
      <p className="codebuddy-side-description">基于当前对话回答，不影响主任务。</p>
      <form onSubmit={event => { event.preventDefault(); void ask(); }}>
        <label>问题<textarea ref={inputRef} aria-label="旁问问题" placeholder="对当前任务有什么疑问？" value={question} maxLength={8000} rows={4}
          disabled={running} onChange={event => setQuestion(event.target.value)}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); void ask();
            }
          }} /></label>
        <div className="codebuddy-side-footer"><span>Ctrl / ⌘ + Enter 发送 · Enter 换行</span><div className="codebuddy-side-actions">
          {state?.status === "running" && <button type="button" disabled={pending} onClick={() => void cancel()}>取消旁问</button>}
          <button className="primary" type="submit" disabled={running || !question.trim()}><Send aria-hidden="true" />{state?.status === "failed" ? "重试旁问" : "发送旁问"}</button>
        </div></div>
      </form>
      {running && <div className="codebuddy-side-status" role="status"><LoaderCircle className="codebuddy-side-spinner" aria-hidden="true" /><div>正在回答旁问…<small>主任务继续运行，关闭弹窗将取消本次旁问。</small></div></div>}
      {state?.truncated && <p className="codebuddy-side-notice">上下文较长，仅使用最近的可见内容。</p>}
      {state?.status === "cancelled" && <p className="codebuddy-side-notice" role="status">旁问已取消。</p>}
      {(error || state?.error) && <p className="codebuddy-side-error" role="alert">{error || state?.error}</p>}
      {state?.status === "completed" && <section className="codebuddy-side-answer" aria-label="旁问答案">
        <div className="codebuddy-side-answer-header"><h3>答案</h3><button type="button" aria-label="复制答案" onClick={() => void copyText(state.answer)
          .then(value => { if (mounted.current) { setCopied(value); setError(value ? "" : "复制失败，请重试。"); } }).catch(cause => { if (mounted.current) setError(errorText(cause)); })}><Copy aria-hidden="true" />{copied ? "已复制" : "复制答案"}</button></div>
        <div className="codebuddy-side-answer-body" tabIndex={0}><MarkdownBlock content={state.answer} /></div>
      </section>}
      </div>
    </section>
  </div>;
}
