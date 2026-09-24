import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { CodexAppServerSnapshot } from "../../vite-env";

type Props = {
  sessionId: string;
  snapshot: CodexAppServerSnapshot;
  onClose: () => void;
  onUpdated: (value: CodexAppServerSnapshot) => void;
};

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const statusLabels: Record<string, string> = {
  active: "进行中", paused: "已暂停", complete: "已完成", blocked: "已阻塞",
  usageLimited: "用量受限", budgetLimited: "预算已用尽"
};

export function CodexGoalDialog({ sessionId, snapshot, onClose, onUpdated }: Props) {
  const goal = snapshot.goal;
  const [objective, setObjective] = useState(goal?.objective || "");
  const [budget, setBudget] = useState(goal?.tokenBudget == null ? "" : String(goal.tokenBudget));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (dirty) return;
    setObjective(goal?.objective || "");
    setBudget(goal?.tokenBudget == null ? "" : String(goal.tokenBudget));
  }, [goal, dirty]);

  const parsedBudget = budget.trim() === "" ? null : Number(budget);
  const invalidBudget = parsedBudget !== null && (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0);
  const changedObjective = Boolean(goal && objective.trim() !== goal.objective);
  const changedBudget = (goal?.tokenBudget ?? null) !== parsedBudget;
  const canSave = objective.trim().length > 0 && objective.trim().length <= 4000 && !invalidBudget
    && (!goal || changedObjective || changedBudget);

  async function save() {
    if (!canSave || pending) return;
    if (changedObjective && !confirmReplace) { setConfirmReplace(true); return; }
    setPending(true); setError("");
    try {
      const changes = !goal || changedObjective
        ? { objective: objective.trim(), status: "active" as const, tokenBudget: parsedBudget }
        : { tokenBudget: parsedBudget };
      onUpdated(await window.codexAppServerApi.setGoal(sessionId, changes));
      setDirty(false); setConfirmReplace(false);
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }

  async function setStatus(status: "active" | "paused") {
    if (pending) return;
    setPending(true); setError("");
    try { onUpdated(await window.codexAppServerApi.setGoal(sessionId, { status })); }
    catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }

  async function clear() {
    if (pending) return;
    if (!confirmClear) { setConfirmClear(true); return; }
    setPending(true); setError("");
    try {
      onUpdated(await window.codexAppServerApi.clearGoal(sessionId));
      setObjective(""); setBudget(""); setDirty(false); setConfirmClear(false);
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }

  return <div className="modal-overlay codex-app-server-goal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-dialog codex-app-server-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-goal-title"
      onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
      <div className="codex-app-server-history-header"><h2 id="codex-goal-title">目标管理</h2>
        <button type="button" aria-label="关闭目标管理" onClick={onClose}><X aria-hidden="true" /></button></div>
      <div className="codex-app-server-goal-content">
        {snapshot.goalLoading && <p role="status">正在读取目标…</p>}
        {snapshot.goalError && <p role="alert" className="codex-app-server-goal-error">读取目标失败：{snapshot.goalError}</p>}
        {goal ? <div className="codex-app-server-goal-summary" aria-label="当前目标状态">
          <strong>{statusLabels[goal.status] || goal.status}</strong>
          <span>已用 {goal.tokensUsed ?? 0} Token{goal.tokenBudget != null ? ` / ${goal.tokenBudget} Token` : ""}</span>
          <span>用时 {Math.round(goal.timeUsedSeconds ?? 0)} 秒</span>
        </div> : !snapshot.goalLoading && !snapshot.goalError && <p>当前线程尚未设置目标。</p>}
        <label>目标内容 <textarea value={objective} maxLength={4000} rows={5} disabled={pending || snapshot.goalLoading}
          onChange={event => { setObjective(event.target.value); setDirty(true); setConfirmReplace(false); }}
          placeholder="写下预期结果和完成条件" /></label>
        <small>{objective.length}/4000 字符</small>
        <label>Token 预算（可选） <input type="number" min="1" step="1" value={budget} disabled={pending || snapshot.goalLoading}
          onChange={event => { setBudget(event.target.value); setDirty(true); }} placeholder="不限制" /></label>
        {invalidBudget && <p role="alert" className="codex-app-server-goal-error">Token 预算须为正整数。</p>}
        {confirmReplace && <p role="status" className="codex-app-server-goal-warning">更换目标内容会重置已用 Token 和时间。再次点击“确认更换”继续。</p>}
        {confirmClear && <p role="status" className="codex-app-server-goal-warning">清除后将删除当前线程的目标。再次点击“确认清除”继续。</p>}
        {error && <p role="alert" className="codex-app-server-goal-error">{error}</p>}
        <div className="codex-app-server-goal-actions">
          {goal?.status === "active" && <button type="button" disabled={pending} onClick={() => void setStatus("paused")}>暂停</button>}
          {goal?.status === "paused" && <button type="button" disabled={pending} onClick={() => void setStatus("active")}>恢复</button>}
          {goal && <button type="button" disabled={pending} onClick={() => void clear()}>{confirmClear ? "确认清除" : "清除目标"}</button>}
          <button type="button" className="primary" disabled={!canSave || pending || snapshot.goalLoading} onClick={() => void save()}>
            {confirmReplace ? "确认更换" : goal ? "保存更改" : "创建目标"}</button>
        </div>
      </div>
    </div>
  </div>;
}
