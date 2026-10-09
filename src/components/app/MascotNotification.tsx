import { useState } from "react";
import { I18nProvider, useI18n } from "../../i18n";
import { getAgentStatusLabel } from "../../utils/agentStatus";
import { ApprovalCard, McpElicitationCard, QuestionCard } from "../agents/GraphicalInteractionCards";
import type { DesktopMascotNotification, DesktopMascotOperation, Locale } from "../../vite-env";

export function MascotNotificationLabel({ notification, locale }: { notification: DesktopMascotNotification; locale: Locale }) {
  return <I18nProvider locale={locale}><StatusLabel notification={notification} /></I18nProvider>;
}
function StatusLabel({ notification }: { notification: DesktopMascotNotification }) {
  const { t, locale } = useI18n();
  return <>{notification.agentStatus ? getAgentStatusLabel(notification.agentStatus, t)
    : locale === "zh-CN" ? notification.status === "completed" ? "任务已完成" : "任务失败"
      : notification.status === "completed" ? "Task completed" : "Task failed"}</>;
}

export function MascotNotificationActions({ notification }: { notification: DesktopMascotNotification }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const action = notification.action;
  const process = (operation: DesktopMascotOperation) => window.desktopMascotApi!.processNotification(notification.id, operation);
  async function plan(operation: "execute" | "dismiss") {
    if (sending) return;
    setSending(true); setError("");
    try { await process({ type: operation }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSending(false); }
  }
  const provider = notification.agentStatus?.provider;
  if (!action) return null;
  return <div className="desktop-mascot-request">
    {action.kind === "plan" && <>
      <pre>{action.text}</pre>
      <div className="desktop-mascot-request-actions">
        <button disabled={sending} onClick={() => void plan("dismiss")}>取消计划</button>
        <button disabled={sending} onClick={() => void plan("execute")}>{sending ? "正在提交…" : "执行计划"}</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </>}
    {action.kind === "approval" && <ApprovalCard approval={action.request} items={action.items} isCodex={!provider || provider === "codex"}
      onResolve={decision => process({ type: "approve", decision })} />}
    {action.kind === "question" && <QuestionCard sessionId={notification.sessionId} request={action.request}
      provider={provider === "codebuddy" || provider === "claude" || provider === "opencode" ? provider : "codex"}
      onAnswer={answers => process({ type: "answer", answers })} onCancel={() => process({ type: "cancel" })} />}
    {action.kind === "elicitation" && <McpElicitationCard sessionId={notification.sessionId} request={action.request}
      onRespond={(choice, content) => process({ type: "respond", action: choice, content })}
      onOpenUrl={() => process({ type: "openUrl" })} />}
  </div>;
}
