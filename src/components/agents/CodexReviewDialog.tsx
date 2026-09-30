import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CodexReviewTarget } from "../../vite-env";

type Props = { sessionId: string; disabled: boolean; onClose: () => void };

export function CodexReviewDialog({ sessionId, disabled, onClose }: Props) {
  const [type, setType] = useState<CodexReviewTarget["type"]>("uncommittedChanges");
  const [branch, setBranch] = useState("");
  const [sha, setSha] = useState("");
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const [error, setError] = useState("");
  const valid = type === "uncommittedChanges" || Boolean((type === "baseBranch" ? branch : type === "commit" ? sha : instructions).trim());
  const close = () => { if (!pendingRef.current) onClose(); };

  async function submit() {
    if (disabled || !valid || pendingRef.current) return;
    const target: CodexReviewTarget = type === "baseBranch" ? { type, branch: branch.trim() }
      : type === "commit" ? { type, sha: sha.trim() }
        : type === "custom" ? { type, instructions: instructions.trim() } : { type };
    pendingRef.current = true; setPending(true); setError("");
    try { await window.codexAppServerApi.startReview(sessionId, target); if (mountedRef.current) onClose(); }
    catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pendingRef.current = false; if (mountedRef.current) setPending(false); }
  }

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-dialog codex-app-server-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-review-title"
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); close(); }
        if (event.key === "Tab") {
          const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)"));
          if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
        }
      }}>
      <div className="codex-app-server-history-header"><h2 id="codex-review-title">代码审查</h2>
        <button type="button" aria-label="关闭代码审查" disabled={pending} onClick={close}><X aria-hidden="true" /></button></div>
      <form className="codex-app-server-goal-content" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p>审查结果将显示在当前会话中。</p>
        <label>审查目标<select autoFocus value={type} disabled={pending} onChange={event => { setType(event.target.value as CodexReviewTarget["type"]); setError(""); }}>
          <option value="uncommittedChanges">未提交修改</option><option value="baseBranch">对比分支</option>
          <option value="commit">指定提交</option><option value="custom">自定义审查要求</option>
        </select></label>
        {type === "baseBranch" && <label>基准分支<input value={branch} disabled={pending} onChange={event => setBranch(event.target.value)} placeholder="例如 main 或 origin/main" /></label>}
        {type === "commit" && <label>提交 SHA<input value={sha} disabled={pending} onChange={event => setSha(event.target.value)} placeholder="输入提交的完整或短 SHA" /></label>}
        {type === "custom" && <label>审查要求<textarea rows={5} value={instructions} disabled={pending} onChange={event => setInstructions(event.target.value)} placeholder="描述需要审查的代码范围和关注点" /></label>}
        {error && <p role="alert" className="codex-app-server-goal-error">{error}</p>}
        <div className="codex-app-server-goal-actions"><button type="button" disabled={pending} onClick={close}>取消</button>
          <button type="submit" className="primary" disabled={disabled || pending || !valid}>{pending ? "正在启动…" : "开始审查"}</button></div>
      </form>
    </div>
  </div>;
}
