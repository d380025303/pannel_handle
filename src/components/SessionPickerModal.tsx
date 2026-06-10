import { useEffect, useMemo, useState } from "react";
import { GripVertical, Pencil, Search, Trash2, X } from "lucide-react";
import type { TerminalSession } from "../vite-env";
import { TagInput } from "./TagInput";

type SessionPickerModalProps = {
  pendingSessions: TerminalSession[];
  runningSessions: TerminalSession[];
  pickerManual: boolean;
  onLaunch: (sessions: TerminalSession[]) => void;
  onStartFresh: () => void;
  onDelete: (id: string) => void;
  onReorder: (sessions: TerminalSession[]) => void;
  onUpdateTags: (id: string, tags: string[]) => void;
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
  onUpdateTags,
  onCancel
}: SessionPickerModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set());
  const [editingTagsId, setEditingTagsId] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState<string[]>([]);

  const runningCounts = useMemo(() => {
    return runningSessions.reduce((counts, session) => {
      if (session.templateId) {
        counts.set(session.templateId, (counts.get(session.templateId) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>());
  }, [runningSessions]);

  const availableTags = useMemo(() => {
    const tags = new Map<string, string>();
    for (const session of pendingSessions) {
      for (const tag of session.tags ?? []) {
        const key = tag.toLowerCase();
        if (!tags.has(key)) tags.set(key, tag);
      }
    }
    return Array.from(tags.values()).sort((a, b) => a.localeCompare(b));
  }, [pendingSessions]);

  useEffect(() => {
    const availableKeys = new Set(availableTags.map((tag) => tag.toLowerCase()));
    setSelectedTags((current) => {
      const next = new Set(Array.from(current).filter((tag) => availableKeys.has(tag.toLowerCase())));
      return next.size === current.size ? current : next;
    });
  }, [availableTags]);

  const filteredSessions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return pendingSessions.filter((session) => {
      const tags = (session.tags ?? []).map((tag) => tag.toLowerCase());
      const matchesTags = Array.from(selectedTags).every((tag) => tags.includes(tag.toLowerCase()));
      const matchesSearch = !query || (
        session.title.toLowerCase().includes(query) ||
        session.type.toLowerCase().includes(query) ||
        session.shell.toLowerCase().includes(query) ||
        session.cwd.toLowerCase().includes(query) ||
        Boolean(session.wslDistro?.toLowerCase().includes(query)) ||
        Boolean(session.sshConfig?.host?.toLowerCase().includes(query)) ||
        Boolean(session.sshConfig?.username?.toLowerCase().includes(query)) ||
        tags.some((tag) => tag.includes(query))
      );
      return matchesTags && matchesSearch;
    });
  }, [pendingSessions, searchQuery, selectedTags]);

  const isFiltering = searchQuery.trim() !== "" || selectedTags.size > 0;
  const toLaunch = pendingSessions.filter((session) => selectedIds.has(session.id));

  const toggleFilterTag = (tag: string) => {
    setSelectedTags((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const handleDragStart = (event: React.DragEvent, sessionId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sessionId);
    (event.currentTarget as HTMLElement).classList.add("dragging");
  };

  const handleDrop = (event: React.DragEvent, targetSessionId: string) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("text/plain");
    if (!draggedId || draggedId === targetSessionId) {
      setDragOverId(null);
      return;
    }
    const fromIndex = pendingSessions.findIndex((session) => session.id === draggedId);
    const toIndex = pendingSessions.findIndex((session) => session.id === targetSessionId);
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

  return (
    <div className="modal-overlay">
      <div className="modal-dialog session-picker-dialog">
        <div className="modal-header">
          <h3>{pickerManual ? "会话库" : "恢复会话"}</h3>
        </div>
        <div className="modal-body">
          {pendingSessions.length === 0 ? (
            <div className="picker-empty"><p>没有已保存的会话</p></div>
          ) : (
            <>
              <div className="picker-search">
                <Search className="picker-search-icon" aria-hidden="true" />
                <input
                  className="modal-input picker-search-input"
                  type="text"
                  placeholder="搜索会话或标签..."
                  value={searchQuery}
                  autoFocus
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                {searchQuery.trim() && (
                  <button className="picker-search-clear" type="button" onClick={() => setSearchQuery("")} aria-label="清除搜索">
                    <X aria-hidden="true" />
                  </button>
                )}
              </div>

              {availableTags.length > 0 && (
                <div className="picker-tag-filters">
                  <span className="picker-tag-filter-label">标签筛选</span>
                  {availableTags.map((tag) => (
                    <button
                      type="button"
                      className={`tag-chip filter${selectedTags.has(tag) ? " active" : ""}`}
                      key={tag}
                      onClick={() => toggleFilterTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                  {selectedTags.size > 0 && (
                    <button type="button" className="picker-tag-clear" onClick={() => setSelectedTags(new Set())}>清除</button>
                  )}
                </div>
              )}

              {editingTagsId && (
                <div className="picker-tag-editor">
                  <div className="picker-tag-editor-header">
                    <strong>维护标签</strong>
                    <button type="button" className="picker-search-clear" aria-label="关闭标签编辑" onClick={() => setEditingTagsId(null)}>
                      <X aria-hidden="true" />
                    </button>
                  </div>
                  <TagInput tags={editingTags} suggestions={availableTags} onChange={setEditingTags} compact />
                  <div className="picker-tag-editor-actions">
                    <button type="button" className="modal-button" onClick={() => setEditingTagsId(null)}>取消</button>
                    <button
                      type="button"
                      className="modal-button primary"
                      onClick={() => {
                        onUpdateTags(editingTagsId, editingTags);
                        setEditingTagsId(null);
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>
              )}

              {filteredSessions.length === 0 ? (
                <div className="picker-empty"><p>没有匹配的会话</p></div>
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
                        draggable={!isFiltering}
                        onDragStart={(event) => handleDragStart(event, session.id)}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDragOverId(session.id);
                        }}
                        onDragLeave={() => setDragOverId(null)}
                        onDrop={(event) => handleDrop(event, session.id)}
                        onDragEnd={(event) => {
                          (event.currentTarget as HTMLElement).classList.remove("dragging");
                          setDragOverId(null);
                        }}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          onLaunch([session]);
                        }}
                      >
                        <span className={`picker-drag-handle${isFiltering ? " disabled" : ""}`} onClick={(event) => event.stopPropagation()}>
                          <GripVertical aria-hidden="true" />
                        </span>
                        <input
                          type="checkbox"
                          className="picker-checkbox"
                          checked={isChecked}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => {
                            setConfirmDeleteId(null);
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (next.has(session.id)) next.delete(session.id);
                              else next.add(session.id);
                              return next;
                            });
                          }}
                        />
                        <span className="picker-item-content">
                          <span className="picker-item-info">
                            <span className="picker-item-title">{session.title}</span>
                            <span className={`session-type-badge ${session.type}`}>{getSessionTypeLabel(session)}</span>
                            {isRunning && <span className="picker-running-badge">运行中 {runningCount}</span>}
                          </span>
                          {(session.tags ?? []).length > 0 && (
                            <span className="picker-item-tags">
                              {(session.tags ?? []).map((tag) => (
                                <button
                                  type="button"
                                  className="tag-chip"
                                  key={tag}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedTags((current) => new Set(current).add(tag));
                                  }}
                                >
                                  {tag}
                                </button>
                              ))}
                            </span>
                          )}
                        </span>
                        <span
                          className="picker-edit-tags-btn"
                          title="维护标签"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditingTagsId(session.id);
                            setEditingTags(session.tags ?? []);
                          }}
                        >
                          <Pencil aria-hidden="true" />
                        </span>
                        <span
                          className={`picker-delete-btn${confirmDeleteId === session.id ? " confirm" : ""}`}
                          title={confirmDeleteId === session.id ? "再次点击确认删除" : "从库中删除"}
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            if (confirmDeleteId === session.id) {
                              onDelete(session.id);
                              setSelectedIds((current) => {
                                const next = new Set(current);
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
          {!pickerManual && <button className="modal-button" type="button" onClick={onStartFresh}>重新开始</button>}
          <button className="modal-button" type="button" onClick={onCancel}>{pickerManual ? "关闭" : "取消"}</button>
          <button className="modal-button primary" type="button" onClick={() => onLaunch(toLaunch)} disabled={toLaunch.length === 0}>
            启动所选 ({toLaunch.length})
          </button>
        </div>
      </div>
    </div>
  );
}
