import { LayoutGrid, Server, Terminal } from "lucide-react";
import { useI18n } from "../../i18n";
import { getAgentStatusClass, getAgentStatusLabel } from "../../utils/agentStatus";
import type { AgentStatusPayload, TerminalSession } from "../../vite-env";

type SessionOverviewProps = {
  sessions: TerminalSession[];
  selectedSessionId?: string;
  agentStatusesBySessionId: Record<string, AgentStatusPayload>;
  onSelectSession: (id: string) => void;
};

export function SessionOverview({ sessions, selectedSessionId, agentStatusesBySessionId, onSelectSession }: SessionOverviewProps) {
  const { t } = useI18n();

  return (
    <section className="session-overview-page" aria-label={t("sessionOverview.title")}>
      <header className="session-overview-header">
        <span className="session-overview-icon"><LayoutGrid aria-hidden="true" /></span>
        <div>
          <h1>{t("sessionOverview.title")}</h1>
          <p>{t("sessionOverview.description", { count: sessions.length })}</p>
        </div>
      </header>

      {sessions.length === 0 ? (
        <div className="session-overview-empty">
          <LayoutGrid aria-hidden="true" />
          <strong>{t("sessionOverview.empty")}</strong>
          <p>{t("sessionOverview.emptyHint")}</p>
        </div>
      ) : (
        <div className="session-overview-grid">
          {sessions.map((session) => {
            const agentStatus = agentStatusesBySessionId[session.id];
            const summary = agentStatus?.activitySummary?.trim();
            const location = session.type === "ssh"
              ? `${session.sshConfig?.username ? `${session.sshConfig.username}@` : ""}${session.sshConfig?.host || session.title}${session.sshConfig?.port ? `:${session.sshConfig.port}` : ""}`
              : session.cwd;
            const typeLabel = session.type === "ssh" ? "SSH" : session.type === "wsl" ? session.wslDistro || "WSL" : "Windows";
            const connectionLabel = session.type !== "ssh"
              ? t("sessionOverview.open")
              : session.sshConnectionState === "connected"
                ? t("sessionOverview.connected")
                : session.sshConnectionState === "reconnecting"
                  ? t("sessionOverview.reconnecting")
                  : session.sshConnectionState === "disconnected"
                    ? t("sessionOverview.disconnected")
                    : t("sessionOverview.connecting");
            const agentLabel = agentStatus
              ? getAgentStatusLabel(agentStatus, t)
              : session.agentProvider ? t("sessionOverview.noAgentStatus") : t("sessionOverview.noAgent");

            return (
              <button className={`session-overview-card${session.id === selectedSessionId ? " selected" : ""}`} key={session.id} type="button" onClick={() => onSelectSession(session.id)} aria-label={t("sessionOverview.selectSession", { name: session.title })} aria-pressed={session.id === selectedSessionId}>
                <span className="session-overview-card-top">
                  <span className="session-overview-card-icon">{session.type === "ssh" ? <Server aria-hidden="true" /> : <Terminal aria-hidden="true" />}</span>
                  <span className="session-overview-card-title"><strong title={session.title}>{session.title}</strong><small>{typeLabel}</small></span>
                </span>
                <span className="session-overview-location" title={location}>{location}</span>
                <span className="session-overview-statuses">
                  <span className={`session-overview-connection ${session.type === "ssh" ? session.sshConnectionState || "connecting" : "open"}`}>{connectionLabel}</span>
                  <span className={`session-overview-agent ${getAgentStatusClass(agentStatus)}`}>{agentLabel}</span>
                </span>
                <span className="session-overview-summary-label">{t("sessionOverview.summary")}</span>
                <span className={`session-overview-summary${summary ? "" : " empty"}`} title={summary}>{summary || t("sessionOverview.noSummary")}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
