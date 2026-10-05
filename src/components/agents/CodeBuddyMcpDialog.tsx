import { useCallback, useEffect, useRef, useState } from "react";
import { McpManager } from "../mcp/McpManager";
import type { CodeBuddyMcpRuntime, CodexAppServerSnapshot, TerminalSession } from "../../vite-env";
import "./codebuddy-mcp.css";

const statusNames: Record<string, string> = { connecting: "正在连接", ready: "首轮连接成功", failed: "连接失败", timeout: "首轮等待超时" };
export function CodeBuddyMcpDialog({ session, snapshot, onClose, onRestart }: {
  session: TerminalSession; snapshot: CodexAppServerSnapshot;
  onClose: () => void; onRestart: () => Promise<void>;
}) {
  const [runtime, setRuntime] = useState<CodeBuddyMcpRuntime | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const alive = useRef(true);
  const save = useRef<(() => Promise<boolean>) | null>(null);
  const registerSave = useCallback((handler: (() => Promise<boolean>) | null) => { save.current = handler; }, []);
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);
  const refresh = useCallback(async () => {
    try {
      const value = await window.codeBuddyMcpApi.runtime(session.id);
      if (alive.current) { setRuntime(value); setError(""); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [session.id]);
  useEffect(() => {
    alive.current = true; void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  const close = () => { if (!dirty.current || window.confirm("放弃未保存的 MCP 配置？")) onClose(); };
  const restart = async () => {
    setBusy(true); setError("");
    try {
      if (dirty.current && !await save.current?.()) return;
      await onRestart();
      if (alive.current) { setNotice("会话已重启，配置将由新进程读取。"); await refresh(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  const tools = [...new Set(snapshot.items.map(item => item.tool || item.toolName || "").filter(name => name.startsWith("mcp__")))];
  return <div className="modal-overlay" onClick={close}>
    <div className="modal-dialog codebuddy-mcp-dialog" role="dialog" aria-modal="true" aria-label="CodeBuddy MCP 管理" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <div className="codex-app-server-history-header"><h2>CodeBuddy MCP 管理</h2><button type="button" aria-label="关闭 MCP 管理" onClick={close}>关闭</button></div>
      <section className="codebuddy-mcp-runtime" aria-label="MCP 运行状态">
        <button type="button" onClick={() => void refresh()}>刷新记录</button>
        <button type="button" disabled={busy || snapshot.busy || Boolean(snapshot.approvals.length || snapshot.questions?.length || snapshot.pendingPlan)} onClick={() => void restart()}>重启会话并应用配置</button>
        <p>{runtime?.reason || "正在读取当前会话状态…"}</p>
        {runtime && !runtime.statuses.length && <p>CLI 尚未推送 MCP 连接记录；配置启用不代表连接成功。</p>}
        <ul>{runtime?.statuses.map(server => <li key={server.name}>{server.name} · {statusNames[server.status] || server.status} · {new Date(server.updatedAt).toLocaleTimeString()}{server.error && <p role="alert">{server.error}</p>}</li>)}</ul>
        <h3>本对话已观察到的 MCP 工具</h3>
        {tools.length ? <ul>{tools.map(tool => <li key={tool}>{tool}</li>)}</ul> : <p>尚未观察到工具调用。公开接口未提供完整工具列表查询。</p>}
        <button type="button" disabled title="当前公开接口未提供此操作">热重载／重连</button>
        <button type="button" disabled title="当前公开接口未提供 OAuth 管理">OAuth 登录</button>
        {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
      </section>
      <McpManager session={session} embeddedCodeBuddy runtimeStatuses={runtime?.statuses}
        onDirtyChange={onDirtyChange} onRegisterSave={registerSave}
        onCommitted={() => { setNotice("配置已保存；需重启当前会话生效。"); void refresh(); }} />
    </div>
  </div>;
}
