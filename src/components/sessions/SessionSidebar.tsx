import { useEffect, useMemo, useState } from "react";
import { GripVertical, Library, Pencil, Plus, Search, Webhook, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentStatusPayload, TerminalSession } from "../../vite-env";
import { getAgentStatusClass, getAgentStatusLabel } from "../../utils/agentStatus";

type SessionSidebarProps = {
  sessions: TerminalSession[];
  activeId?: string;
  showInstanceIds?: boolean;
  agentStatusesBySessionId: Record<string, AgentStatusPayload>;
  onSelectSession: (id: string) => void;
  onEditSession: (session: TerminalSession) => void;
  onInstallHooks: (session: TerminalSession) => void;
  onCloseSession: (id: string) => void;
  onOpenPicker: () => void;
  onOpenCreate: () => void;
  onReorder: (orderedIds: string[]) => void;
};

function getSessionTypeLabel(session: TerminalSession) {
  if (session.type === "ssh") return "SSH";
  if (session.type === "wsl") return session.wslDistro || "WSL";
  return "PS";
}

export function SessionSidebar({
  sessions,
  activeId,
  showInstanceIds = false,
  agentStatusesBySessionId,
  onSelectSession,
  onEditSession,
  onInstallHooks,
  onCloseSession,
  onOpenPicker,
  onOpenCreate,
  onReorder
}: SessionSidebarProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const isFiltering = searchQuery.trim().length > 0;

  const filteredSessions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return sessions;
    return sessions.filter((session) => {
      const tags = (session.tags ?? []).map((tag) => tag.toLowerCase());
      return (
        session.title.toLowerCase().includes(query) ||
        session.type.toLowerCase().includes(query) ||
        session.shell.toLowerCase().includes(query) ||
        session.cwd.toLowerCase().includes(query) ||
        Boolean(session.wslDistro?.toLowerCase().includes(query)) ||
        Boolean(session.sshConfig?.host?.toLowerCase().includes(query)) ||
        Boolean(session.sshConfig?.username?.toLowerCase().includes(query)) ||
        session.id.toLowerCase().includes(query) ||
        Boolean(session.templateId?.toLowerCase().includes(query)) ||
        tags.some((tag) => tag.includes(query))
      );
    });
  }, [sessions, searchQuery]);

  useEffect(() => {
    if (!pendingCloseId) return;
    const handleClick = () => setPendingCloseId(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [pendingCloseId]);

  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", sessionId);
    (e.currentTarget as HTMLElement).classList.add("dragging");
  };

  const handleDragOver = (e: React.DragEvent, sessionId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(sessionId);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    if (!draggedId || draggedId === targetId) {
      setDragOverId(null);
      return;
    }

    const orderedIds = sessions.map(s => s.id);
    const fromIndex = orderedIds.indexOf(draggedId);
    const toIndex = orderedIds.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) {
      setDragOverId(null);
      return;
    }

    const [moved] = orderedIds.splice(fromIndex, 1);
    orderedIds.splice(toIndex, 0, moved);
    onReorder(orderedIds);
    setDragOverId(null);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("dragging");
    setDragOverId(null);
  };

  return (
    <aside className="session-sidebar">
      <div className="sidebar-header">
        <div>
          <h1>{t("sidebar.title")}</h1>
          <span>
            {isFiltering
              ? t("sidebar.countFiltered", { count: sessions.length, filtered: filteredSessions.length })
              : t("sidebar.count", { count: sessions.length })}
          </span>
        </div>
        <div className="sidebar-actions">
          <button className="icon-button" type="button" title={t("sidebar.openLibrary")} aria-label={t("sidebar.openLibrary")} onClick={onOpenPicker}>
            <Library aria-hidden="true" />
          </button>
          <button className="icon-button primary" type="button" title={t("sidebar.newSession")} aria-label={t("sidebar.newSession")} onClick={onOpenCreate}>
            <Plus aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="sidebar-search">
        <Search className="sidebar-search-icon" aria-hidden="true" />
        <input
          className="modal-input sidebar-search-input"
          type="text"
          placeholder={t("sidebar.searchPlaceholder")}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {isFiltering && (
          <button className="sidebar-search-clear" type="button" onClick={() => setSearchQuery("")} aria-label={t("sidebar.clearSearch")}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="session-list">
        {filteredSessions.length === 0 ? (
          <div className="sidebar-empty"><p>{t("sidebar.empty")}</p></div>
        ) : (
          filteredSessions.map((session) => {
            const agentStatus = agentStatusesBySessionId[session.id];
            const agentStatusLabel = getAgentStatusLabel(agentStatus, t);
            return (
              <button
                className={`session-item ${session.id === activeId ? "active" : ""} ${dragOverId === session.id ? "drag-over" : ""}`}
                key={session.id}
                type="button"
                draggable={!isFiltering}
                onClick={() => onSelectSession(session.id)}
                onDragStart={(e) => handleDragStart(e, session.id)}
                onDragOver={(e) => handleDragOver(e, session.id)}
                onDragLeave={() => setDragOverId(null)}
                onDrop={(e) => handleDrop(e, session.id)}
                onDragEnd={handleDragEnd}
              >
                <span
                  className="session-drag-handle"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <GripVertical aria-hidden="true" />
                </span>
                <span className="session-main">
                  <span className="session-title">
                    {session.title}
                    <span className={`session-type-badge ${session.type}`}>
                      {getSessionTypeLabel(session)}
                    </span>
                  </span>
                  {showInstanceIds && (
                    <span className="session-instance-id" title={`Instance ${session.id}${session.templateId ? ` / Template ${session.templateId}` : ""}`}>
                      ID {session.id}{session.templateId ? ` / Template ${session.templateId}` : ""}
                    </span>
                  )}
                  {agentStatusLabel && (
                    <span className={`agent-status-badge ${getAgentStatusClass(agentStatus)}`}>
                      {agentStatusLabel}
                    </span>
                  )}
                </span>
                <span className="session-actions">
                  <span
                    className="mini-action"
                    title={t("sidebar.installHooks")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onInstallHooks(session);
                    }}
                  >
                    <Webhook aria-hidden="true" />
                  </span>
                  <span
                    className="mini-action"
                    title={t("sidebar.editSession")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onEditSession(session);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </span>
                  <span
                    className={`mini-action danger${pendingCloseId === session.id ? " confirm" : ""}`}
                    title={pendingCloseId === session.id ? t("sidebar.confirmClose") : t("sidebar.closeSession")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (pendingCloseId === session.id) {
                        setPendingCloseId(null);
                        onCloseSession(session.id);
                      } else {
                        setPendingCloseId(session.id);
                      }
                    }}
                  >
                    {pendingCloseId === session.id ? t("common.confirm") : <X aria-hidden="true" />}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
