import type { AgentStatusPayload, TerminalSession } from "../vite-env";
import { getAgentStatusClass, getAgentStatusLabel } from "../utils/agentStatus";

type SessionSidebarProps = {
  sessions: TerminalSession[];
  activeId?: string;
  agentStatusesBySessionId: Record<string, AgentStatusPayload>;
  onSelectSession: (id: string) => void;
  onEditSession: (session: TerminalSession) => void;
  onCloseSession: (id: string) => void;
  onOpenPicker: () => void;
  onOpenCreate: () => void;
};

export function SessionSidebar({
  sessions,
  activeId,
  agentStatusesBySessionId,
  onSelectSession,
  onEditSession,
  onCloseSession,
  onOpenPicker,
  onOpenCreate
}: SessionSidebarProps) {
  return (
    <aside className="session-sidebar">
      <div className="sidebar-header">
        <div>
          <h1>命令会话</h1>
          <span>{sessions.length} 个窗口</span>
        </div>
        <button className="icon-button" type="button" title="从库中启动" onClick={onOpenPicker}>
          {"☰"}
        </button>
        <button className="icon-button primary" type="button" title="新建会话" onClick={onOpenCreate}>
          +
        </button>
      </div>

      <div className="session-list">
        {sessions.map((session) => {
          const agentStatus = agentStatusesBySessionId[session.id];
          const agentStatusLabel = getAgentStatusLabel(agentStatus);
          return (
            <button
              className={`session-item ${session.id === activeId ? "active" : ""}`}
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
            >
              <span className="session-main">
                <span className="session-title">
                  {session.title}
                  <span className={`session-type-badge ${session.type}`}>
                    {session.type === "wsl" ? (session.wslDistro || "WSL") : "PS"}
                  </span>
                </span>
                {agentStatusLabel && (
                  <span className={`agent-status-badge ${getAgentStatusClass(agentStatus)}`}>
                    {agentStatusLabel}
                  </span>
                )}
              </span>
              <span className="session-actions">
                <span
                  className="mini-action"
                  title="编辑会话"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditSession(session);
                  }}
                >
                  R
                </span>
                <span
                  className="mini-action danger"
                  title="关闭"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseSession(session.id);
                  }}
                >
                  X
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
