import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { CodexAppServerSnapshot } from "../../vite-env";

type Props = { api?: typeof window.codexAppServerApi; sessionId: string; snapshot: CodexAppServerSnapshot; onClose: () => void;
  onUpdated: (value: CodexAppServerSnapshot) => void };

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

export function CodeBuddyGoalDialog({ api = window.codexAppServerApi, sessionId, snapshot, onClose, onUpdated }: Props) {
  const goal = snapshot.codeBuddyGoal;
  const [condition, setCondition] = useState(goal?.active?.condition || "");
  const [dirty, setDirty] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!dirty) setCondition(goal?.active?.condition || ""); }, [goal?.active?.condition, dirty]);
  useEffect(() => {
    if (!goal?.active || goal.active.paused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [goal?.active, goal?.active?.paused]);

  const busy = pending || goal?.pendingAction === "clear";
  const canSet = Boolean(condition.trim() && condition.trim().length <= 4000
    && condition.trim() !== goal?.active?.condition && (!snapshot.busy || goal?.active) && !busy);
  async function setGoal() {
    if (!canSet) return;
    if (goal?.active && !confirmReplace) { setConfirmReplace(true); return; }
    setPending(true); setError("");
    try {
      onUpdated(await api.setGoal(sessionId, { objective: condition.trim(), status: "active" }));
      setDirty(false); setConfirmReplace(false);
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }
  async function clearGoal() {
    if (!goal?.active || busy) return;
    if (!confirmClear) { setConfirmClear(true); return; }
    setPending(true); setError("");
    try {
      onUpdated(await api.clearGoal(sessionId));
      setConfirmClear(false); setDirty(false);
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }
  async function refresh() {
    if (snapshot.busy || busy) return;
    setPending(true); setError("");
    try { onUpdated(await api.refreshGoal(sessionId)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }
  const active = goal?.active;
  const latest = goal?.latest;
  const elapsed = active ? active.durationMs + (active.paused ? 0 : Math.max(0, now - goal.updatedAt)) : 0;
  return <div className="modal-overlay codex-app-server-goal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <div className="modal-dialog codex-app-server-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="codebuddy-goal-title"
      tabIndex={-1} onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); if (!pending) onClose(); }
        if (event.key === "Tab") {
          const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)"));
          if (!elements.length) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === event.currentTarget)) {
            event.preventDefault(); elements.at(-1)?.focus();
          } else if (!event.shiftKey && (document.activeElement === elements.at(-1) || document.activeElement === event.currentTarget)) {
            event.preventDefault(); elements[0]?.focus();
          }
        }
      }}>
      <div className="codex-app-server-history-header"><h2 id="codebuddy-goal-title">CodeBuddy 目标管理</h2>
        <button type="button" autoFocus aria-label="关闭目标管理" disabled={pending} onClick={onClose}><X aria-hidden="true" /></button></div>
      <div className="codex-app-server-goal-content">
        {active ? <div className="codex-app-server-goal-summary" aria-label="当前目标状态">
          <strong>{active.paused ? "已暂停" : "进行中"}</strong>
          <span>用时 {duration(elapsed)}</span><span>已评估 {active.turnCount} 轮</span><span>消耗 {active.tokenDelta} Token</span>
        </div> : latest ? <div className="codex-app-server-goal-summary" aria-label="最近目标结果">
          <strong>{latest.ok ? "已达成" : "不可达"}</strong>
          <span>用时 {duration(latest.durationMs)}</span><span>已评估 {latest.turnCount} 轮</span><span>消耗 {latest.tokenDelta} Token</span>
        </div> : <p>{goal?.available ? "当前会话没有进行中的目标。" : "当前 CLI 尚未提供目标状态。"}</p>}
        {active?.reason && <p>最近评估：{active.reason}</p>}
        {!active && latest && <><p>最近目标：{latest.condition}</p>{latest.reason && <p>评估结果：{latest.reason}</p>}</>}
        <label>完成条件 <textarea value={condition} maxLength={4000} rows={5} disabled={busy}
          onChange={event => { setCondition(event.target.value); setDirty(true); setConfirmReplace(false); }}
          placeholder="写下可验证的完成条件" /></label>
        <small>{condition.length}/4000 字符</small>
        {goal?.pendingAction && <p role="status">{goal.pendingAction === "set" ? "目标命令已发送，等待 CodeBuddy 状态…"
          : goal.pendingAction === "clear" ? "正在清除目标…" : "正在读取目标状态…"}</p>}
        {confirmReplace && <p role="status" className="codex-app-server-goal-warning">替换目标会重新开始评估。再次点击“确认替换”继续。</p>}
        {confirmClear && <p role="status" className="codex-app-server-goal-warning">清除目标会停止当前目标任务。再次点击“确认清除”继续。</p>}
        {(error || goal?.error) && <p role="alert" className="codex-app-server-goal-error">{error || goal?.error}</p>}
        <div className="codex-app-server-goal-actions">
          <button type="button" disabled={snapshot.busy || busy} onClick={() => void refresh()}>刷新状态</button>
          {active && <button type="button" disabled={busy} onClick={() => void clearGoal()}>{confirmClear ? "确认清除" : "清除目标"}</button>}
          <button type="button" className="primary" disabled={!canSet} onClick={() => void setGoal()}>
            {confirmReplace ? "确认替换" : active ? "替换目标" : "创建目标"}</button>
        </div>
      </div>
    </div>
  </div>;
}
