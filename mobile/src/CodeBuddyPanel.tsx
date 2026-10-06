import { useEffect, useState } from "react";
import { CodeBuddyGoalDialog } from "../../src/components/agents/CodeBuddyGoalDialog";
import { CodeBuddySideQuestionDialog } from "../../src/components/agents/CodeBuddySideQuestionDialog";
import { CodeBuddyScheduledTasksDialog } from "../../src/components/agents/CodeBuddyScheduledTasksDialog";
import { CodeBuddyJobsDialog } from "../../src/components/agents/CodeBuddyJobsDialog";
import { CodeBuddyPluginDialog } from "../../src/components/agents/CodeBuddyPluginDialog";
import { CodeBuddyMcpDialog } from "../../src/components/agents/CodeBuddyMcpDialog";
import { CodexVersionControl } from "../../src/components/agents/CodexVersionControl";
import type { CodexAppServerSnapshot, TerminalSession } from "../../src/vite-env";
import { copyMobileText } from "./clipboard";
import type { useGraphicalSession } from "./useGraphicalSession";
import { useCodeBuddyApi } from "./useCodeBuddyApi";
import "./codebuddy.css";

export function CodeBuddyPanel({ controller }: { controller: ReturnType<typeof useGraphicalSession> }) {
  const remote = useCodeBuddyApi(controller), { snapshot, session, activeSheet, buddyRequest, setError } = controller;
  const close = () => controller.setActiveSheet(null);
  const [pending, setPending] = useState(false);
  const run = async (operation: () => Promise<unknown>) => { if (pending) return; setPending(true); try { await operation(); } catch (cause) { setError(String(cause)); } finally { setPending(false); } };
  useEffect(() => { if (activeSheet === "buddy-config") void buddyRequest("main-agents").catch(cause => setError(String(cause))); }, [activeSheet, snapshot?.threadId]);
  if (!snapshot || snapshot.provider !== "codebuddy" || !activeSheet?.startsWith("buddy-")) return null;
  const state = snapshot as unknown as CodexAppServerSnapshot;
  const common = { sessionId: session.id, api: remote.api, onClose: close, snapshot: state, onUpdated: () => {} };
  return <div ref={controller.sheetRef} tabIndex={-1} className="mobile-codebuddy-panel" onKeyDown={event => { if (event.key === "Escape" && ["buddy-version", "buddy-config"].includes(activeSheet)) close(); }}>
    {activeSheet === "buddy-goal" && <CodeBuddyGoalDialog {...common} />}
    {activeSheet === "buddy-side" && <CodeBuddySideQuestionDialog {...common} copyText={async text => { await copyMobileText(text); return true; }} />}
    {activeSheet === "buddy-tasks" && snapshot.threadId && <CodeBuddyScheduledTasksDialog {...common} threadId={snapshot.threadId} />}
    {activeSheet === "buddy-jobs" && <CodeBuddyJobsDialog {...common} cwd={session.cwd || ""} />}
    {activeSheet === "buddy-plugins" && <CodeBuddyPluginDialog sessionId={session.id} api={remote.plugins} onClose={close} />}
    {activeSheet === "buddy-mcp" && <CodeBuddyMcpDialog session={session as TerminalSession} snapshot={state} api={remote.mcp} configApi={remote.config} onClose={close} onRestart={async () => { if (!window.confirm("重启当前会话并应用 MCP 配置？")) throw new Error("已取消重启。"); await buddyRequest("mcp-restart"); }} />}
    {(activeSheet === "buddy-version" || activeSheet === "buddy-config") && <div className="modal-overlay" onClick={close}><section className="modal-dialog" role="dialog" aria-modal="true" aria-label={activeSheet === "buddy-version" ? "CodeBuddy CLI 版本" : "CodeBuddy 会话配置"} onClick={event => event.stopPropagation()}><header><strong>{activeSheet === "buddy-version" ? "CLI 版本" : "会话配置"}</strong><button onClick={close}>关闭</button></header>
      {controller.error && <p role="alert">{controller.error}</p>}
      {activeSheet === "buddy-version" ? <CodexVersionControl sessionId={session.id} provider="codebuddy" api={remote.version} /> : <>
        {snapshot.mainAgent && <label>主 Agent<select aria-label="主 Agent" value={snapshot.mainAgent.currentAgentName || ""} disabled={pending || snapshot.busy || !snapshot.mainAgent.sessionBlank} onChange={event => void run(() => buddyRequest("main-agent", { name: event.target.value }))}><option value="">默认</option>{snapshot.mainAgent.agents.map(agent => <option key={agent.name} value={agent.name} disabled={Boolean(agent.broken)}>{agent.displayName || agent.name}</option>)}</select>{!snapshot.mainAgent.sessionBlank && <small>新建对话后可切换主 Agent。</small>}{snapshot.mainAgent.error && <p role="alert">{snapshot.mainAgent.error}</p>}</label>}
        {snapshot.acpOptions?.filter(option => ["multitask", "context_window", "effort", "reasoning_effort"].includes(option.id)).map(option => <label key={option.id}>{option.id === "multitask" ? "Multitask" : option.id === "context_window" ? "上下文窗口" : "思考强度"}{option.id === "multitask" ? <input type="checkbox" checked={option.currentValue === true || option.currentValue === "true"} disabled={pending || snapshot.busy} onChange={event => void run(() => buddyRequest("multitask", { enabled: event.target.checked }))} /> : <select value={String(option.currentValue || "")} disabled={pending || snapshot.busy} onChange={event => void run(() => buddyRequest(option.id === "context_window" ? "context-window" : "effort", { value: event.target.value }))}>{option.options.map(value => <option key={value.value} value={value.value}>{value.name}</option>)}</select>}</label>)}
      </>}
    </section></div>}
  </div>;
}
