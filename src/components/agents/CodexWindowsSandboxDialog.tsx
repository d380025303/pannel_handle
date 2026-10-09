import { useRef, useState } from "react";
import { X } from "lucide-react";
import type { CodexWindowsSandboxSetup } from "../../vite-env";

type Props = { sessionId: string; setup: CodexWindowsSandboxSetup; disabled: boolean; onClose: () => void };

export function CodexWindowsSandboxDialog({ sessionId, setup, disabled, onClose }: Props) {
  const [mode, setMode] = useState(setup.mode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const running = pending || setup.status === "running";
  async function start() {
    if (submitting.current || running || disabled) return;
    submitting.current = true;
    setPending(true); setError("");
    try { await window.codexAppServerApi.setupWindowsSandbox(sessionId, mode); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current = false; setPending(false); }
  }
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-dialog codex-app-server-background-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-sandbox-title"
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="codex-app-server-history-header"><h2 id="codex-sandbox-title">Windows 沙箱初始化</h2>
        <button type="button" aria-label="关闭沙箱初始化" onClick={onClose}><X aria-hidden="true" /></button></div>
      <fieldset className="codex-app-server-sandbox-modes" disabled={running || disabled}><legend>初始化模式</legend>
        <label><input type="radio" name="sandbox-mode" checked={mode === "elevated"} onChange={() => setMode("elevated")} />管理员模式</label>
        <label><input type="radio" name="sandbox-mode" checked={mode === "unelevated"} onChange={() => setMode("unelevated")} />非管理员模式</label>
      </fieldset>
      <p>{mode === "elevated" ? "初始化管理员沙箱，可能出现 Windows 授权窗口，请按提示完成授权。" : "执行非管理员沙箱初始化与预检查。"}</p>
      {running && <p role="status">Windows 沙箱正在初始化…关闭此窗口后仍会继续。</p>}
      {!running && setup.status === "succeeded" && <p role="status">Windows 沙箱初始化成功，可以继续使用当前会话。</p>}
      {(error || setup.error) && <p role="alert" className="codex-app-server-history-error">{error || setup.error}</p>}
      {disabled && !running && <p>请等待当前会话操作完成后再初始化。</p>}
      <div className="codex-app-server-background-actions"><button type="button" autoFocus disabled={running || disabled || !setup.available} onClick={() => void start()}>
        {running ? "正在初始化…" : setup.status === "failed" || error ? "重试初始化" : "开始初始化"}</button>
        <button type="button" onClick={onClose}>关闭</button></div>
    </div>
  </div>;
}
