import { GraphicalUsage } from "./GraphicalUsage";
import { GraphicalIcon } from "./GraphicalIcon";
import { effortLabel, modelLabel, permissionLabel, providerLabel } from "./GraphicalPresentation";
import { QuickCommandPicker } from "./QuickCommandPicker";
import { useGraphicalSession, type GraphicalViewProps } from "./useGraphicalSession";
import { GraphicalTimeline } from "./GraphicalTimeline";
import { GraphicalComposer } from "./GraphicalComposer";
import { GraphicalActionSheet } from "./GraphicalActionSheet";

export function GraphicalView(props: GraphicalViewProps) {
  const { session, send, onGraphicalMessage, draft, setDraft } = props;
  const controller = useGraphicalSession(props);
  const { snapshot, isSending, error, activeSheet, setActiveSheet, switchingTo, moreButtonRef, runQuickCommand } = controller;
  if (!snapshot) return <section className="graphical-shell graphical-loading">正在加载图形会话…</section>;
  const context = snapshot.contextUsage;
  const contextPercent = context && context.size > 0 ? Math.min(100, Math.max(0, context.used / context.size * 100)) : null;
  return <section className="graphical-shell">
    <header className="graphical-header">
      <div className="graphical-header-details">
        <strong>{session.title}</strong>
        <span>{providerLabel(snapshot.provider)} · {snapshot.busy ? "运行中" : "就绪"}</span>
        <div className="graphical-current-config">
          <span>模型：{modelLabel(snapshot)}</span>
          <span>强度：{effortLabel(snapshot)}</span>
          {snapshot.provider === "codex" && permissionLabel(snapshot.executionPermission)
            && <span>执行权限：{permissionLabel(snapshot.executionPermission)}</span>}
          {snapshot.fastMode && <span>快速模式</span>}
          {context && contextPercent !== null && <span aria-label="上下文用量">上下文：{contextPercent.toFixed(1)}% · {context.used.toLocaleString()} / {context.size.toLocaleString()}</span>}
        </div>
      </div>
      {switchingTo && <span className="graphical-switching">切换中…</span>}
      <button ref={moreButtonRef} type="button" className="graphical-more-button" aria-label="更多操作" aria-haspopup="dialog"
        aria-expanded={Boolean(activeSheet)} onClick={() => setActiveSheet("menu")}><GraphicalIcon name="more" /></button>
    </header>
    <GraphicalUsage sessionId={session.id} sessionType={session.type} snapshot={snapshot} send={send} onGraphicalMessage={onGraphicalMessage} />
    {snapshot.error && <div className="graphical-error" role="alert">{snapshot.error}</div>}
    {error && !activeSheet && <div className="graphical-error" role="alert">{error}</div>}
    <GraphicalTimeline snapshot={snapshot} controller={controller} />
    <QuickCommandPicker commands={session.quickCommands || []} onSelect={runQuickCommand}
      disabled={command => !snapshot?.threadId || !!snapshot.archived || (command.mode !== "write" && isSending)
        || (command.mode === "auto-enter" && !!snapshot.busy && snapshot.provider !== "codex")} />
    <GraphicalComposer snapshot={snapshot} controller={controller} draft={draft} setDraft={setDraft} />
    <GraphicalActionSheet snapshot={snapshot} session={session} controller={controller} />
  </section>;
}
