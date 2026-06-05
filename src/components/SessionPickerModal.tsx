import { useMemo, useState } from "react";
import { GripVertical, Search, Trash2, X } from "lucide-react";
import type { TerminalSession } from "../vite-env";

type SessionPickerModalProps = {
  pendingSessions: TerminalSession[];
  runningSessions: TerminalSession[];
  pickerManual: boolean;
  onLaunch: (sessions: TerminalSession[]) => void;
  onStartFresh: () => void;
  onDelete: (id: string) => void;
  onReorder: (sessions: TerminalSession[]) => void;
  onCancel: () => void;
};

function getSessionTypeLabel(session: TerminalSession) {
  if (session.type === "ssh") return "SSH";
  if (session.type === "wsl") return session.wslDistro || "WSL";
  return "PS";
}

export function SessionPickerModal({
  pendingSessions,
  runningSessions,
  pickerManual,
  onLaunch,
  onStartFresh,
  onDelete,
  onReorder,
  onCancel
}: SessionPickerModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set()
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const runningCounts = useMemo(() => {
    return runningSessions.reduce((counts, session) => {
      if (!session.templateId) {
        return counts;
      }
      counts.set(session.templateId, (counts.get(session.templateId) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
  }, [runningSessions]);
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return pendingSessions;
    const q = searchQuery.toLowerCase().trim();
    return pendingSessions.filter((s) => {
      return (
        s.title.toLowerCase().includes(q) ||
        s.type.toLowerCase().includes(q) ||
        s.shell.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        (s.wslDistro && s.wslDistro.toLowerCase().includes(q)) ||
        (s.sshConfig?.host && s.sshConfig.host.toLowerCase().includes(q)) ||
        (s.sshConfig?.username && s.sshConfig.username.toLowerCase().includes(q))
      );
    });
  }, [pendingSessions, searchQuery]);

  const isSearching = searchQuery.trim() !== "";

  const toLaunch = pendingSessions.filter((session) => selectedIds.has(session.id));

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

  const handleDrop = (e: React.DragEvent, targetSessionId: string) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    if (!draggedId || draggedId === targetSessionId) {
      setDragOverId(null);
      return;
    }
    const fromIndex = pendingSessions.findIndex(s => s.id === draggedId);
    const toIndex = pendingSessions.findIndex(s => s.id === targetSessionId);
    if (fromIndex === -1 || toIndex === -1) {
      setDragOverId(null);
      return;
    }
    const reordered = [...pendingSessions];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    onReorder(reordered);
    setDragOverId(null);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("dragging");
    setDragOverId(null);
  };

  return (
    <div className="modal-overlay" onClick={() => { setConfirmDeleteId(null); onCancel(); }}>
      <div className="modal-dialog session-picker-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{pickerManual ? "会话库" : "恢复会话"}</h3>
          <p className="modal-subtitle">
            {pickerManual ? "选择要从库中启动的会话" : "选择要启动的会话"}
          </p>
        </div>
        <div className="modal-body">
          {pendingSessions.length === 0 ? (
            <div className="picker-empty">
              <p>没有已保存的会话</p>
            </div>
          ) : (
            <>
              <div className="picker-search">
                <Search className="picker-search-icon" aria-hidden="true" />
                <input
                  className="modal-input picker-search-input"
                  type="text"
                  placeholder="搜索会话..."
                  value={searchQuery}
                  autoFocus
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {isSearching && (
                  <button
                    className="picker-search-clear"
                    onClick={() => setSearchQuery("")}
                    aria-label="清除搜索"
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
              </div>
              {filteredSessions.length === 0 ? (
                <div className="picker-empty">
                  <p>没有匹配的会话</p>
                </div>
              ) : (
                <div className="picker-list">
                  {filteredSessions.map((session) => {
                const runningCount = runningCounts.get(session.id) ?? 0;
                const isRunning = runningCount > 0;
                const isChecked = selectedIds.has(session.id);
                return (
                  <div
                    key={session.id}
                    className={`picker-item ${isChecked ? "checked" : ""} ${isRunning ? "running" : ""} ${dragOverId === session.id ? "drag-over" : ""}`}
                    draggable={!isSearching}
                    onDragStart={(e) => handleDragStart(e, session.id)}
                    onDragOver={(e) => handleDragOver(e, session.id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, session.id)}
                    onDragEnd={handleDragEnd}
                    onClick={() => {
                      setConfirmDeleteId(null);
                      onLaunch([session]);
                    }}
                  >
                    <span
                      className={`picker-drag-handle${isSearching ? " disabled" : ""}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <GripVertical aria-hidden="true" />
                    </span>
                    <input
                      type="checkbox"
                      className="picker-checkbox"
                      checked={isChecked}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => {
                        setConfirmDeleteId(null);
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(session.id)) {
                            next.delete(session.id);
                          } else {
                            next.add(session.id);
                          }
                          return next;
                        });
                      }}
                    />
                    <span className="picker-item-info">
                      <span className="picker-item-title">{session.title}</span>
                      <span className={`session-type-badge ${session.type}`}>
                        {getSessionTypeLabel(session)}
                      </span>
                      {isRunning && (
                        <span className="picker-running-badge">运行中 {runningCount}</span>
                      )}
                    </span>
                    <span
                      className={`picker-delete-btn${confirmDeleteId === session.id ? " confirm" : ""}`}
                      title={confirmDeleteId === session.id ? "再次点击确认删除" : "从库中删除"}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (confirmDeleteId === session.id) {
                          onDelete(session.id);
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            next.delete(session.id);
                            return next;
                          });
                          setConfirmDeleteId(null);
                        } else {
                          setConfirmDeleteId(session.id);
                        }
                      }}
                    >
                      {confirmDeleteId === session.id ? "确认" : <Trash2 aria-hidden="true" />}
                    </span>
                  </div>
                );
              })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          {!pickerManual && (
            <button
              className="modal-button"
              type="button"
              onClick={onStartFresh}
            >
              重新开始
            </button>
          )}
          <button
            className="modal-button"
            type="button"
            onClick={onCancel}
          >
            {pickerManual ? "关闭" : "取消"}
          </button>
          <button
            className="modal-button primary"
            type="button"
            onClick={() => onLaunch(toLaunch)}
            disabled={toLaunch.length === 0}
          >
            启动所选 ({toLaunch.length})
          </button>
        </div>
      </div>
    </div>
  );
}
