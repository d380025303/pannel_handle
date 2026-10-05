import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CodexAppServerSnapshot } from "../../vite-env";
import { MarkdownBlock } from "../shared/MarkdownBlock";

type Props = { sessionId: string; snapshot: CodexAppServerSnapshot; initialQuestion?: string;
  onClose: () => void; onUpdated: (snapshot: CodexAppServerSnapshot) => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CodeBuddySideQuestionDialog({ sessionId, snapshot, initialQuestion = "", onClose, onUpdated }: Props) {
  const state = snapshot.sideQuestion;
  const [question, setQuestion] = useState(initialQuestion || state?.question || "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const initialized = useRef(false);
  const request = useRef(state?.status === "running" ? state.requestId : null);
  const pendingRef = useRef(false);
  const running = pending || state?.status === "running";

  useEffect(() => { request.current = state?.status === "running" ? state.requestId : null; }, [state]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (request.current) void window.codexAppServerApi.cancelSideQuestion(sessionId, request.current).catch(() => {});
    };
  }, [sessionId]);

  async function ask(value = question) {
    if (!value.trim() || value.length > 8000 || pendingRef.current || state?.status === "running") return;
    pendingRef.current = true; setPending(true); setError("");
    try {
      const updated = await window.codexAppServerApi.askSideQuestion(sessionId, value);
      request.current = updated.sideQuestion?.status === "running" ? updated.sideQuestion.requestId : null;
      if (!mounted.current) {
        if (request.current) await window.codexAppServerApi.cancelSideQuestion(sessionId, request.current);
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
    if (!request.current) return;
    setPending(true); setError("");
    try {
      const updated = await window.codexAppServerApi.cancelSideQuestion(sessionId, request.current);
      if (mounted.current) onUpdated(updated);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setPending(false); }
  }

  return <div className="modal-overlay" onClick={onClose}>
    <section className="modal-dialog codex-app-server-goal-dialog" role="dialog" aria-modal="true" aria-label="CodeBuddy 旁问"
      onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="codex-app-server-history-header"><h2>CodeBuddy 旁问</h2><button type="button" aria-label="关闭旁问" onClick={onClose}><X aria-hidden="true" /></button></div>
      <div className="codex-app-server-goal-content">
      <p>基于当前可见对话独立回答，主任务继续运行。旁问不会写入主会话。</p>
      <form onSubmit={event => { event.preventDefault(); void ask(); }}>
        <label>问题<textarea autoFocus aria-label="旁问问题" value={question} maxLength={8000} rows={4}
          disabled={running} onChange={event => setQuestion(event.target.value)} /></label>
        <div className="codex-app-server-goal-actions"><button type="submit" disabled={running || !question.trim()}>{state?.status === "failed" ? "重试旁问" : "发送旁问"}</button>
          {state?.status === "running" && <button type="button" disabled={pending} onClick={() => void cancel()}>取消旁问</button>}</div>
      </form>
      {running && <p role="status">正在回答旁问…</p>}
      {state?.truncated && <p>上下文较长，仅使用最近的可见内容。</p>}
      {state?.status === "cancelled" && <p role="status">旁问已取消。</p>}
      {(error || state?.error) && <p className="codex-app-server-goal-error" role="alert">{error || state?.error}</p>}
      {state?.status === "completed" && <div aria-label="旁问答案"><MarkdownBlock content={state.answer} />
        <div className="codex-app-server-goal-actions"><button type="button" onClick={() => void window.clipboardApi.writeText(state.answer)
          .then(copied => { if (!copied) setError("复制失败，请重试。"); }).catch(cause => setError(errorText(cause)))}>复制答案</button></div></div>}
      </div>
    </section>
  </div>;
}
