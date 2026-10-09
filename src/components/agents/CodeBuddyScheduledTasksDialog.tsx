import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CodeBuddyScheduledTask } from "../../vite-env";

type Props = { api?: typeof window.codexAppServerApi; sessionId: string; threadId: string; onClose: () => void };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function CodeBuddyScheduledTasksDialog({ api = window.codexAppServerApi, sessionId, threadId, onClose }: Props) {
  const [tasks, setTasks] = useState<CodeBuddyScheduledTask[]>([]);
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState("*/5 * * * *");
  const [recurring, setRecurring] = useState(true);
  const [durable, setDurable] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const generation = useRef(0);
  const working = useRef(false);
  const refreshing = useRef(false);
  const sequence = useRef(0);

  async function refresh(token = generation.current) {
    if (refreshing.current) return;
    refreshing.current = true;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const rows = await api.listScheduledTasks(sessionId, threadId);
      if (token === generation.current && request === sequence.current) { setTasks(rows); setLoaded(true); setError(""); }
    } catch (cause) {
      if (token === generation.current && request === sequence.current) setError(message(cause));
    } finally {
      if (token === generation.current && request === sequence.current) { refreshing.current = false; setLoading(false); }
    }
  }
  useEffect(() => {
    const token = ++generation.current;
    refreshing.current = false; working.current = false;
    setTasks([]); setPrompt(""); setCron("*/5 * * * *"); setRecurring(true); setDurable(false);
    setPending(false); setLoaded(false); setError(""); setConfirmDelete(null);
    void refresh(token);
    const timer = window.setInterval(() => { if (!working.current) void refresh(token); }, 10000);
    return () => { generation.current++; sequence.current++; window.clearInterval(timer); };
  }, [sessionId, threadId]);

  async function run(action: () => Promise<void>, created = false) {
    if (working.current || refreshing.current) return;
    const token = generation.current;
    working.current = true; setPending(true); setError("");
    try {
      await action();
      if (token !== generation.current) return;
      if (created) setPrompt("");
      setConfirmDelete(null);
      await refresh(token);
    } catch (cause) { if (token === generation.current) setError(message(cause)); }
    finally { if (token === generation.current) { working.current = false; setPending(false); } }
  }
  const disabled = pending || loading;
  return <div className="modal-overlay codex-app-server-goal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-dialog codex-app-server-goal-dialog" role="dialog" aria-modal="true" aria-labelledby="codebuddy-scheduled-title"
      onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
      <div className="codex-app-server-history-header"><h2 id="codebuddy-scheduled-title">CodeBuddy 定时任务</h2>
        <button type="button" aria-label="关闭定时任务" onClick={onClose}><X aria-hidden="true" /></button></div>
      <div className="codex-app-server-goal-content">
        <p>任务在当前 CodeBuddy 对话运行且空闲时执行，触发时间可能有偏移。重启后保留不代表应用关闭后仍会执行；任务过期规则由 CLI 管理。</p>
        <button type="button" disabled={disabled} onClick={() => void refresh()}>刷新列表</button>
        {loading && <p role="status">正在加载定时任务…</p>}
        {error && <p role="alert" className="codex-app-server-goal-error">{error}</p>}
        {loaded && !loading && !error && tasks.length === 0 && <p>当前对话没有定时任务。</p>}
        <ul className="codebuddy-scheduled-list">{tasks.map(task => <li key={task.id}>
          <p className="codebuddy-scheduled-prompt">{task.prompt}</p>
          <p><code>{task.cron}</code> · {task.recurring ? "重复执行" : "一次性"} · {task.durable ? "重启后保留" : "仅当前运行"}{!task.enabled && " · 已禁用"}</p>
          {task.createdAt != null && <p>创建时间：{new Date(task.createdAt).toLocaleString()}</p>}
          {task.lastFiredAt != null && <p>最近触发：{new Date(task.lastFiredAt).toLocaleString()}</p>}
          {confirmDelete === task.id ? <div><span>确认删除此任务？</span>
            <button disabled={disabled} onClick={() => void run(() => api.deleteScheduledTask(sessionId, threadId, task.id))}>确认删除</button>
            <button disabled={disabled} onClick={() => setConfirmDelete(null)}>取消</button></div>
            : <button disabled={disabled} aria-label={`删除任务 ${task.prompt}`} onClick={() => setConfirmDelete(task.id)}>删除</button>}
        </li>)}</ul>
        <h3>创建定时任务</h3>
        <form className="codebuddy-scheduled-form" onSubmit={event => {
          event.preventDefault();
          void run(() => api.createScheduledTask(sessionId, threadId, { prompt, cron, recurring, durable }), true);
        }}>
          <label>任务内容<textarea aria-label="任务内容" rows={3} value={prompt} maxLength={16000} required disabled={pending} onChange={event => setPrompt(event.target.value)} /></label>
          <label>Cron 表达式<input aria-label="Cron 表达式" value={cron} maxLength={200} required disabled={pending} onChange={event => setCron(event.target.value)} /></label>
          <p>五段格式：分钟 小时 日 月 星期，按 CodeBuddy 进程本地时区执行。一次性任务在表达式下次匹配时执行一次。</p>
          <div>{[["每 5 分钟", "*/5 * * * *"], ["每天 9 点", "0 9 * * *"], ["每周一 9 点", "0 9 * * 1"]].map(([label, value]) =>
            <button type="button" key={value} disabled={pending} onClick={() => setCron(value)}>{label}</button>)}</div>
          <label className="codebuddy-scheduled-toggle"><input type="checkbox" checked={recurring} disabled={pending} onChange={event => setRecurring(event.target.checked)} />重复执行</label>
          <label className="codebuddy-scheduled-toggle"><input type="checkbox" checked={durable} disabled={pending} onChange={event => setDurable(event.target.checked)} />重启后保留</label>
          <button type="submit" className="primary" disabled={disabled || !prompt.trim() || cron.trim().split(/\s+/).length !== 5}>创建任务</button>
        </form>
      </div>
    </div>
  </div>;
}
