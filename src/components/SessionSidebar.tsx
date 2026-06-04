import { useEffect, useState } from "react";
import { GripVertical, Library, Pencil, Plus, X } from "lucide-react";
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
  agentStatusesBySessionId,
  onSelectSession,
  onEditSession,
  onCloseSession,
  onOpenPicker,
  onOpenCreate,
  onReorder
}: SessionSidebarProps) {
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  const handleDragLeave = () => {
    setDragOverId(null);
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
          <h1>命令会话</h1>
          <span>{sessions.length} 个窗口</span>
        </div>
        <div className="sidebar-actions">
          <button className="icon-button" type="button" title="从库中启动" aria-label="从库中启动" onClick={onOpenPicker}>
            <Library aria-hidden="true" />
          </button>
          <button className="icon-button primary" type="button" title="新建会话" aria-label="新建会话" onClick={onOpenCreate}>
            <Plus aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="session-list">
        {sessions.map((session) => {
          const agentStatus = agentStatusesBySessionId[session.id];
          const agentStatusLabel = getAgentStatusLabel(agentStatus);
          return (
            <button
              className={`session-item ${session.id === activeId ? "active" : ""} ${dragOverId === session.id ? "drag-over" : ""}`}
              key={session.id}
              type="button"
              draggable={true}
              onClick={() => onSelectSession(session.id)}
              onDragStart={(e) => handleDragStart(e, session.id)}
              onDragOver={(e) => handleDragOver(e, session.id)}
              onDragLeave={handleDragLeave}
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
                  <Pencil aria-hidden="true" />
                </span>
                <span
                  className={`mini-action danger${pendingCloseId === session.id ? " confirm" : ""}`}
                  title={pendingCloseId === session.id ? "再次点击确认关闭" : "关闭"}
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
                  {pendingCloseId === session.id ? "确认?" : <X aria-hidden="true" />}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
