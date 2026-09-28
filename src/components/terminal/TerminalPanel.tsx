import { useEffect, useMemo, useState } from "react";
import type { MouseEvent, WheelEvent } from "react";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import type { RemoteAgentAuditEvent, TerminalSession } from "../../vite-env";
import { useI18n } from "../../i18n";

type TerminalBackgroundConfig = {
  imageUrl: string;
  opacity: number;
  blur: number;
};

type TerminalPanelProps = {
  sessions: TerminalSession[];
  activeId?: string;
  isVisible?: boolean;
  hostRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
  sizeOwner: string;
  onClaimSize: () => void;
  terminalBackground?: TerminalBackgroundConfig;
};

export function TerminalPanel({
  sessions,
  activeId,
  isVisible = true,
  hostRefs,
  onContextMenu,
  onWheel,
  sizeOwner,
  onClaimSize,
  terminalBackground
}: TerminalPanelProps) {
  const { t } = useI18n();
  const activeSession = sessions.find((session) => session.id === activeId);
  const isLocalRemoteAgent = activeSession?.type === "ssh" && activeSession.agentLocation === "local";
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditEvents, setAuditEvents] = useState<RemoteAgentAuditEvent[]>([]);

  useEffect(() => {
    if (!activeId || !isLocalRemoteAgent) {
      setAuditEvents([]);
      setAuditOpen(false);
      return;
    }
    let disposed = false;
    void window.remoteAgentApi.listAudit(activeId).then((events) => {
      if (!disposed) setAuditEvents(events.slice(-100));
    });
    const remove = window.remoteAgentApi.onAudit((event) => {
      if (event.sessionId !== activeId) return;
      setAuditEvents((current) => [...current, event].slice(-100));
    });
    return () => {
      disposed = true;
      remove();
    };
  }, [activeId, isLocalRemoteAgent]);

  const visibleAuditEvents = useMemo(() => auditEvents.slice(-100), [auditEvents]);

  return (
    <section className="terminal-panel" style={{ display: isVisible ? undefined : "none" }}>
      {isLocalRemoteAgent && (
        <button
          className={`remote-agent-audit-toggle${auditOpen ? " active" : ""}`}
          type="button"
          aria-expanded={auditOpen}
          onClick={() => setAuditOpen((current) => !current)}
        >
          <Activity aria-hidden="true" />
          {t("remoteAgent.auditTitle")}
          {auditOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      )}
      {activeId && (
        <button className={`terminal-size-owner${sizeOwner === "desktop" ? " active" : ""}`} type="button" onClick={onClaimSize}>
          {sizeOwner === "desktop" ? "PC 尺寸" : "适配本机"}
        </button>
      )}
      <div
        className={`terminal-hosts-container${terminalBackground ? " has-bg" : ""}`}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
      >
        {terminalBackground && (
          <div
            className="terminal-bg-layer"
            aria-hidden="true"
            style={{
              backgroundImage: `url("${terminalBackground.imageUrl}")`,
              opacity: terminalBackground.opacity / 100,
              filter: terminalBackground.blur > 0 ? `blur(${terminalBackground.blur}px)` : undefined,
              inset: -terminalBackground.blur
            }}
          />
        )}
        {sessions.filter((session) => session.runtimeMode !== "app-server").map((session) => (
          <div
            key={session.id}
            className="terminal-host"
            data-session-id={session.id}
            style={{ display: session.id === activeId ? undefined : "none" }}
            ref={(el) => {
              if (el) {
                hostRefs.current.set(session.id, el);
              } else {
                hostRefs.current.delete(session.id);
              }
            }}
          />
        ))}
      </div>
      {isLocalRemoteAgent && auditOpen && (
        <aside className="remote-agent-audit" aria-label={t("remoteAgent.auditTitle")}>
          <header>
            <strong>{t("remoteAgent.auditTitle")}</strong>
            <span>{t("remoteAgent.auditEphemeral")}</span>
          </header>
          <div className="remote-agent-audit-list">
            {visibleAuditEvents.length === 0 ? (
              <p className="remote-agent-audit-empty">{t("remoteAgent.auditWaiting")}</p>
            ) : visibleAuditEvents.map((event, index) => (
              <article className={`remote-agent-audit-event ${event.status}`} key={`${event.operationId}-${event.timestamp}-${index}`}>
                <div>
                  <strong>{event.tool}</strong>
                  <span>{event.status}</span>
                  <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                </div>
                {event.summary && <code>{event.summary}</code>}
                {event.output && <pre className={event.stream === "stderr" ? "stderr" : ""}>{event.output}</pre>}
                {event.error && <p>{event.error}</p>}
              </article>
            ))}
          </div>
        </aside>
      )}
    </section>
  );
}
