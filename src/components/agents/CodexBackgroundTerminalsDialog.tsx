import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { CodexAppServerApi } from "../../vite-env";

type Terminal = Awaited<ReturnType<CodexAppServerApi["listBackgroundTerminals"]>>[number];
type Props = { sessionId: string; onClose: () => void };
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);

export function CodexBackgroundTerminalsDialog({ sessionId, onClose }: Props) {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const active = useRef(true);

  async function refresh() {
    const current = ++requestId.current;
    setLoading(true); setError("");
    try {
      const data = await window.codexAppServerApi.listBackgroundTerminals(sessionId);
      if (requestId.current === current) setTerminals(data);
    } catch (cause) {
      if (requestId.current === current) setError(errorText(cause));
    } finally {
      if (requestId.current === current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; requestId.current += 1; };
  }, [sessionId]);

  async function terminate(processId: string) {
    if (pending || loading) return;
    setPending(processId); setError("");
    try {
      await window.codexAppServerApi.terminateBackgroundTerminal(sessionId, processId);
      if (active.current) await refresh();
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { if (active.current) setPending(null); }
  }

  async function clean() {
    if (pending || loading || !terminals.length) return;
    if (!confirmClean) { setConfirmClean(true); return; }
    setPending("all"); setError("");
    try {
      await window.codexAppServerApi.cleanBackgroundTerminals(sessionId);
      if (active.current) { setConfirmClean(false); await refresh(); }
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { if (active.current) setPending(null); }
  }

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-dialog codex-app-server-background-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-background-title"
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"));
          if (!elements.includes(document.activeElement as HTMLElement)) {
            event.preventDefault();
            (event.shiftKey ? elements.at(-1) : elements[0])?.focus();
          }
          else if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
        }
      }}>
      <div className="codex-app-server-history-header"><h2 id="codex-background-title">后台终端</h2>
        <button type="button" autoFocus aria-label="关闭后台终端" onClick={onClose}><X aria-hidden="true" /></button></div>
      <div className="codex-app-server-background-actions">
        <button type="button" disabled={loading || Boolean(pending)} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />刷新</button>
        <button type="button" disabled={loading || Boolean(pending) || !terminals.length} onClick={() => void clean()}>
          {confirmClean ? "确认全部清理" : "全部清理"}</button>
        {confirmClean && <button type="button" disabled={Boolean(pending)} onClick={() => setConfirmClean(false)}>取消清理</button>}
      </div>
      {confirmClean && <p className="codex-app-server-background-confirm">将停止当前会话的全部后台终端（{terminals.length} 个）。</p>}
      {error && <p role="alert" className="codex-app-server-history-error">{error}</p>}
      {loading && <p role="status">正在读取后台终端…</p>}
      {!loading && !error && !terminals.length && <p>当前会话没有运行中的后台终端。</p>}
      <div className="codex-app-server-background-list" aria-label="后台终端列表">
        {terminals.map(terminal => <div className="codex-app-server-history-row codex-app-server-background-row" key={terminal.processId}>
          <strong>{terminal.command || "未提供命令"}</strong>
          <span>工作目录：{terminal.cwd || "未提供"}</span>
          <span>进程 ID：{terminal.processId}{terminal.osPid != null ? ` · 系统 PID：${terminal.osPid}` : ""}</span>
          {(terminal.cpuPercent != null || terminal.rssKb != null) && <span>
            {terminal.cpuPercent != null ? `CPU：${terminal.cpuPercent}%` : ""}
            {terminal.rssKb != null ? ` · 内存：${Math.round(terminal.rssKb / 1024)} MiB` : ""}
          </span>}
          <button type="button" disabled={loading || Boolean(pending)} onClick={() => void terminate(terminal.processId)}>
            {pending === terminal.processId ? "正在终止…" : "终止"}</button>
        </div>)}
      </div>
    </div>
  </div>;
}
