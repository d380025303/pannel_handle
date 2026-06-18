import { useEffect, useMemo, useState } from "react";
import { Download, GripVertical, Search, Trash2, Upload, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { SessionLibraryFileResult, SessionLibraryImportResult, TerminalSession } from "../vite-env";

type SessionPickerModalProps = {
  pendingSessions: TerminalSession[];
  runningSessions: TerminalSession[];
  pickerManual: boolean;
  onLaunch: (sessions: TerminalSession[]) => void;
  onStartFresh: () => void;
  onDelete: (id: string) => void;
  onReorder: (sessions: TerminalSession[]) => void;
  onImport: () => Promise<SessionLibraryImportResult>;
  onExport: () => Promise<SessionLibraryFileResult>;
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
  onImport,
  onExport,
  onCancel
}: SessionPickerModalProps) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set());
  const [libraryStatus, setLibraryStatus] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

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

  const handleImport = async () => {
    setIsImporting(true);
    setLibraryStatus(null);
    try {
      const result = await onImport();
      if (result.canceled) {
        setLibraryStatus({ kind: "info", text: t("picker.importCanceled") });
      } else if (result.ok) {
        setSelectedIds(new Set());
        setLibraryStatus({ kind: "info", text: t("picker.imported", { count: result.importedCount }) });
      } else {
        setLibraryStatus({ kind: "error", text: t("picker.importFailed", { error: result.error }) });
      }
    } finally {
      setIsImporting(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    setLibraryStatus(null);
    try {
      const result = await onExport();
      if (result.canceled) {
        setLibraryStatus({ kind: "info", text: t("picker.exportCanceled") });
      } else if (result.ok) {
        setLibraryStatus({ kind: "info", text: t("picker.exported", { count: result.exportedCount, path: result.filePath }) });
      } else {
        setLibraryStatus({ kind: "error", text: t("picker.exportFailed", { error: result.error }) });
      }
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog session-picker-dialog">
        <div className="modal-header">
          <h3>{pickerManual ? t("picker.libraryTitle") : t("picker.restoreTitle")}</h3>
        </div>
        <div className="modal-body">
          <div className="picker-library-actions">
            <button className="modal-button" type="button" onClick={handleImport} disabled={isImporting || isExporting}>
              <Upload aria-hidden="true" />
              {isImporting ? t("common.importing") : t("common.import")}
            </button>
            <button className="modal-button" type="button" onClick={handleExport} disabled={isImporting || isExporting}>
              <Download aria-hidden="true" />
              {isExporting ? t("common.exporting") : t("common.export")}
            </button>
          </div>
          {libraryStatus && (
            <div className={`picker-library-status ${libraryStatus.kind}`}>
              {libraryStatus.text}
            </div>
          )}
          {pendingSessions.length === 0 ? (
            <div className="picker-empty"><p>{t("picker.empty")}</p></div>
          ) : (
            <>
              <div className="picker-search">
                <Search className="picker-search-icon" aria-hidden="true" />
                <input
                  className="modal-input picker-search-input"
                  type="text"
                  placeholder={t("picker.searchPlaceholder")}
                  value={searchQuery}
                  autoFocus
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                {searchQuery.trim() && (
                  <button className="picker-search-clear" type="button" onClick={() => setSearchQuery("")} aria-label={t("sidebar.clearSearch")}>
                    <X aria-hidden="true" />
                  </button>
                )}
              </div>

              {availableTags.length > 0 && (
                <div className="picker-tag-filters">
                  <span className="picker-tag-filter-label">{t("picker.tagFilter")}</span>
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
                    <button type="button" className="picker-tag-clear" onClick={() => setSelectedTags(new Set())}>{t("common.clear")}</button>
                  )}
                </div>
              )}

              {filteredSessions.length === 0 ? (
                <div className="picker-empty"><p>{t("picker.noMatches")}</p></div>
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
                            {isRunning && <span className="picker-running-badge">{t("picker.runningCount", { count: runningCount })}</span>}
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
                          className={`picker-delete-btn${confirmDeleteId === session.id ? " confirm" : ""}`}
                          title={confirmDeleteId === session.id ? t("picker.confirmDelete") : t("picker.deleteFromLibrary")}
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
                          {confirmDeleteId === session.id ? t("common.confirm") : <Trash2 aria-hidden="true" />}
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
          {!pickerManual && <button className="modal-button" type="button" onClick={onStartFresh}>{t("picker.startFresh")}</button>}
          <button className="modal-button" type="button" onClick={onCancel}>{pickerManual ? t("common.close") : t("common.cancel")}</button>
          <button className="modal-button primary" type="button" onClick={() => onLaunch(toLaunch)} disabled={toLaunch.length === 0}>
            {t("picker.launchSelected", { count: toLaunch.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
