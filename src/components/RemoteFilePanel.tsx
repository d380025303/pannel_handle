import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download, File, FileText, Folder, FolderOpen, RefreshCw, Save, Search, Upload, X } from "lucide-react";
import type { RemoteFileEntry, RemoteTextPreview, TerminalSession } from "../vite-env";

type RemoteFilePanelProps = {
  session?: TerminalSession;
  openRequest?: { sessionId: string; path: string; requestId: number } | null;
  onDirtyChange?: (dirty: boolean) => void;
  onPreviewActive?: (active: boolean) => void;
};

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "ready"; sessionId: string; path: string; fileName: string; preview: RemoteTextPreview }
  | { status: "error"; path: string; message: string };

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

type TextMatch = {
  start: number;
  end: number;
};

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatModifiedAt(timestamp: number) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function parentPath(remotePath: string) {
  const normalized = remotePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "/" || normalized === ".") {
    return normalized || ".";
  }
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function baseName(remotePath: string) {
  const normalized = remotePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export function RemoteFilePanel({ session, openRequest, onDirtyChange, onPreviewActive }: RemoteFilePanelProps) {
  const [currentPath, setCurrentPath] = useState(".");
  const [pathInput, setPathInput] = useState(".");
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [searchQuery, setSearchQuery] = useState("");
  const [previewSearchQuery, setPreviewSearchQuery] = useState("");
  const [activePreviewMatch, setActivePreviewMatch] = useState(0);
  const [originalContent, setOriginalContent] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const previewContentRef = useRef<HTMLTextAreaElement>(null);
  const dirtyRef = useRef(false);
  const matchNavigationRef = useRef(false);
  const handledOpenRequestRef = useRef(0);

  const sessionId = session?.id;

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath),
    [entries, selectedPath]
  );
  const canOpenInExplorer = session?.type === "windows" || session?.type === "wsl";
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredEntries = useMemo(
    () => normalizedSearchQuery
      ? entries.filter((entry) => entry.name.toLowerCase().includes(normalizedSearchQuery))
      : entries,
    [entries, normalizedSearchQuery]
  );
  const isDirty = preview.status === "ready"
    && preview.preview.kind === "text"
    && editorContent !== originalContent;
  dirtyRef.current = isDirty;
  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  const isPreviewActive = preview.status !== "idle";
  useEffect(() => {
    onPreviewActive?.(isPreviewActive);
  }, [isPreviewActive, onPreviewActive]);

  const previewMatches = useMemo<TextMatch[]>(() => {
    if (!previewSearchQuery || !editorContent) {
      return [];
    }
    const matches: TextMatch[] = [];
    const normalizedContent = editorContent.toLowerCase();
    const normalizedQuery = previewSearchQuery.toLowerCase();
    let start = normalizedContent.indexOf(normalizedQuery);
    while (start !== -1) {
      matches.push({ start, end: start + normalizedQuery.length });
      start = normalizedContent.indexOf(normalizedQuery, start + normalizedQuery.length);
    }
    return matches;
  }, [editorContent, previewSearchQuery]);

  useEffect(() => {
    setActivePreviewMatch(0);
  }, [previewSearchQuery]);

  useEffect(() => {
    if (!previewMatches.length) {
      return;
    }
    const match = previewMatches[activePreviewMatch];
    const textarea = previewContentRef.current;
    if (!match || !textarea) {
      return;
    }
    if (matchNavigationRef.current) {
      textarea.focus();
      matchNavigationRef.current = false;
    }
    textarea.setSelectionRange(match.start, match.end);
  }, [activePreviewMatch, previewSearchQuery]);

  const confirmDiscard = useCallback(() => (
    !dirtyRef.current || window.confirm("Discard unsaved file changes?")
  ), []);

  const resetEditor = useCallback(() => {
    saveRequestRef.current += 1;
    setOriginalContent("");
    setEditorContent("");
    setSaveState({ status: "idle" });
    setPreviewSearchQuery("");
  }, []);

  const loadDirectory = useCallback(async (path: string, preserveSearch = false, skipConfirm = false) => {
    if (!sessionId) {
      return undefined;
    }
    if (!skipConfirm && !confirmDiscard()) {
      return undefined;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    previewRequestRef.current += 1;
    setLoading(true);
    setError(null);
    try {
      const nextEntries = await window.remoteFileApi.list(sessionId, path);
      if (requestRef.current !== requestId) return;
      setCurrentPath(path);
      setPathInput(path);
      setEntries(nextEntries);
      setSelectedPath(null);
      setPreview({ status: "idle" });
      resetEditor();
      if (!preserveSearch) {
        setSearchQuery("");
      }
      return nextEntries;
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
      }
    }
    return undefined;
  }, [confirmDiscard, resetEditor, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setCurrentPath(".");
      setPathInput(".");
      setEntries([]);
      setSelectedPath(null);
      setPreview({ status: "idle" });
      setSearchQuery("");
      resetEditor();
      setError(null);
      setLoading(false);
      previewRequestRef.current += 1;
      return;
    }

    let disposed = false;
    setSearchQuery("");
    setPreviewSearchQuery("");
    setLoading(true);
    setError(null);
    window.remoteFileApi.getHome(sessionId)
      .then((home) => {
        if (!disposed) {
          void loadDirectory(home || ".", false, true);
        }
      })
      .catch((err) => {
        if (!disposed) {
          setError(getErrorMessage(err));
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
      requestRef.current += 1;
      previewRequestRef.current += 1;
    };
  }, [confirmDiscard, loadDirectory, resetEditor, sessionId]);

  const handleOpenEntry = useCallback(async (entry: RemoteFileEntry, force = false) => {
    if (!force && entry.path === selectedPath) {
      return;
    }
    if (!confirmDiscard()) {
      return;
    }
    setSelectedPath(entry.path);
    resetEditor();
    if (entry.type === "directory") {
      await loadDirectory(entry.path, false, true);
      return;
    }

    if (!sessionId) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreview({ status: "loading", path: entry.path });
    try {
      const nextPreview = await window.remoteFileApi.readText(sessionId, entry.path);
      if (previewRequestRef.current !== requestId) return;
      setPreview({
        status: "ready",
        sessionId,
        path: entry.path,
        fileName: entry.name,
        preview: nextPreview
      });
      if (nextPreview.kind === "text") {
        setOriginalContent(nextPreview.content);
        setEditorContent(nextPreview.content);
      }
    } catch (err) {
      if (previewRequestRef.current !== requestId) return;
      setPreview({
        status: "error",
        path: entry.path,
        message: getErrorMessage(err)
      });
    }
  }, [confirmDiscard, loadDirectory, resetEditor, selectedPath, sessionId]);

  useEffect(() => {
    if (!openRequest || !sessionId || openRequest.sessionId !== sessionId) {
      return;
    }
    if (handledOpenRequestRef.current === openRequest.requestId) {
      return;
    }
    handledOpenRequestRef.current = openRequest.requestId;

    let disposed = false;
    const openPath = async () => {
      if (!confirmDiscard()) {
        return;
      }
      const targetDirectory = parentPath(openRequest.path);
      const nextEntries = await loadDirectory(targetDirectory, true, true);
      if (disposed) {
        return;
      }
      const entry = nextEntries?.find((item) => item.path === openRequest.path) || {
        name: baseName(openRequest.path),
        path: openRequest.path,
        type: "file" as const,
        size: 0,
        modifiedAt: 0
      };
      await handleOpenEntry(entry, true);
    };

    void openPath();
    return () => {
      disposed = true;
    };
  }, [confirmDiscard, handleOpenEntry, loadDirectory, openRequest, sessionId]);

  const handleRefresh = useCallback(() => {
    void loadDirectory(currentPath, true);
  }, [currentPath, loadDirectory]);

  const handlePathSubmit = useCallback(() => {
    void loadDirectory(pathInput.trim() || ".");
  }, [loadDirectory, pathInput]);

  const handleUpload = useCallback(async () => {
    if (!sessionId) return;
    const result = await window.remoteFileApi.uploadFile(sessionId, currentPath);
    if (!result.canceled) {
      const nextEntries = await window.remoteFileApi.list(sessionId, currentPath);
      setEntries(nextEntries);
    }
  }, [currentPath, sessionId]);

  const handleDownload = useCallback(async (entry: RemoteFileEntry) => {
    if (!sessionId || entry.type === "directory") return;
    await window.remoteFileApi.downloadFile(sessionId, entry.path, entry.name);
  }, [sessionId]);

  const handleOpenInExplorer = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    try {
      await window.remoteFileApi.openInExplorer(sessionId, currentPath);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [currentPath, sessionId]);

  const handleClosePreview = useCallback(() => {
    if (!confirmDiscard()) {
      return;
    }
    previewRequestRef.current += 1;
    setSelectedPath(null);
    setPreview({ status: "idle" });
    resetEditor();
  }, [confirmDiscard, resetEditor]);

  useEffect(() => {
    if (!isPreviewActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleClosePreview();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPreviewActive, handleClosePreview]);

  const handleReloadPreview = useCallback(async () => {
    if (preview.status !== "ready" || !confirmDiscard()) {
      return;
    }
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setSaveState({ status: "idle" });
    try {
      const nextPreview = await window.remoteFileApi.readText(preview.sessionId, preview.path);
      if (previewRequestRef.current !== requestId) return;
      setPreview({ ...preview, preview: nextPreview });
      if (nextPreview.kind === "text") {
        setOriginalContent(nextPreview.content);
        setEditorContent(nextPreview.content);
      } else {
        setOriginalContent("");
        setEditorContent("");
      }
    } catch (err) {
      if (previewRequestRef.current !== requestId) return;
      setSaveState({ status: "error", message: getErrorMessage(err) });
    }
  }, [confirmDiscard, preview]);

  const handleSavePreview = useCallback(async () => {
    if (
      preview.status !== "ready"
      || preview.preview.kind !== "text"
      || !isDirty
      || saveState.status === "saving"
      || saveState.status === "conflict"
    ) {
      return;
    }
    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    setSaveState({ status: "saving" });
    try {
      const result = await window.remoteFileApi.writeText(
        preview.sessionId,
        preview.path,
        editorContent,
        preview.preview.version
      );
      if (saveRequestRef.current !== requestId) return;
      if (result.status === "conflict") {
        setSaveState({
          status: "conflict",
          message: "The file changed after it was opened. Reload it before editing again."
        });
        return;
      }
      setPreview({
        ...preview,
        preview: {
          kind: "text",
          content: editorContent,
          size: result.size,
          version: result.version
        }
      });
      setOriginalContent(editorContent);
      setSaveState({ status: "idle" });
      if (sessionId === preview.sessionId) {
        window.remoteFileApi.list(sessionId, currentPath)
          .then((nextEntries) => {
            if (saveRequestRef.current === requestId) {
              setEntries(nextEntries);
            }
          })
          .catch((err) => {
            if (saveRequestRef.current === requestId) {
              setError(getErrorMessage(err));
            }
          });
      }
    } catch (err) {
      if (saveRequestRef.current !== requestId) return;
      setSaveState({ status: "error", message: getErrorMessage(err) });
    }
  }, [currentPath, editorContent, isDirty, preview, saveState.status, sessionId]);

  const movePreviewMatch = useCallback((direction: 1 | -1) => {
    if (!previewMatches.length) {
      return;
    }
    matchNavigationRef.current = true;
    setActivePreviewMatch((current) => (
      (current + direction + previewMatches.length) % previewMatches.length
    ));
  }, [previewMatches.length]);

  if (!sessionId || !session) {
    return (
      <aside className="remote-file-panel">
        <div className="remote-file-header">
          <div>
            <h2>Files</h2>
            <span>No session selected</span>
          </div>
        </div>
        <div className="remote-file-empty">Files are available after selecting a session.</div>
      </aside>
    );
  }

  return (
    <>
      <aside className="remote-file-panel">
        <div className="remote-file-header">
          <div>
            <h2>Files</h2>
            <span>{session.title}</span>
        </div>
        <div className="remote-file-actions">
          <button className="icon-button" type="button" title="Parent directory" aria-label="Parent directory" onClick={() => void loadDirectory(parentPath(currentPath))}>
            <ArrowUp aria-hidden="true" />
          </button>
          {canOpenInExplorer && (
            <button className="icon-button" type="button" title="Open in Explorer" aria-label="Open in Explorer" onClick={() => void handleOpenInExplorer()}>
              <FolderOpen aria-hidden="true" />
            </button>
          )}
          <button className="icon-button" type="button" title="Refresh" aria-label="Refresh" onClick={handleRefresh}>
            <RefreshCw aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" title="Upload file" aria-label="Upload file" onClick={() => void handleUpload()}>
            <Upload aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="remote-file-path">
        <input
          type="text"
          aria-label="Directory path"
          title={currentPath}
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handlePathSubmit();
            }
          }}
        />
      </div>

      <div className="remote-file-search">
        <Search aria-hidden="true" />
        <input
          type="text"
          placeholder="Search current directory..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {normalizedSearchQuery && (
          <button type="button" title="Clear search" aria-label="Clear search" onClick={() => setSearchQuery("")}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>

      {error && (
        <div className="remote-file-error">
          <span>{error}</span>
          <button type="button" onClick={handleRefresh}>Retry</button>
        </div>
      )}

      <div className="remote-file-list" aria-busy={loading}>
        {loading ? (
          <div className="remote-file-empty">Loading files...</div>
        ) : entries.length === 0 && !error ? (
          <div className="remote-file-empty">Directory is empty</div>
        ) : filteredEntries.length === 0 ? (
          <div className="remote-file-empty">No matching files in this directory.</div>
        ) : (
          filteredEntries.map((entry) => (
            <button
              className={`remote-file-row ${selectedPath === entry.path ? "selected" : ""}`}
              key={entry.path}
              type="button"
              onClick={() => void handleOpenEntry(entry)}
            >
              <span className={`remote-file-icon ${entry.type}`}>
                {entry.type === "directory" ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
              </span>
              <span className="remote-file-name">{entry.name}</span>
              <span className="remote-file-meta">{entry.type === "directory" ? "Folder" : formatSize(entry.size)}</span>
              <span className="remote-file-meta">{formatModifiedAt(entry.modifiedAt)}</span>
              {entry.type !== "directory" && (
                <span
                  className="remote-file-download"
                  title="Download"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDownload(entry);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleDownload(entry);
                    }
                  }}
                >
                  <Download aria-hidden="true" />
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </aside>

    {preview.status !== "idle" && (
      <div className="remote-preview-overlay" onClick={handleClosePreview}>
        <div className="remote-preview-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="remote-file-preview">
          <div className="remote-preview-header">
            <span>
              <FileText aria-hidden="true" />
              {selectedEntry?.name || preview.path}
              {isDirty && <strong className="remote-preview-dirty" title="Unsaved changes">*</strong>}
            </span>
            <div className="remote-preview-actions">
              {preview.status === "ready" && preview.preview.kind === "text" && (
                <>
                  <button
                    className="icon-button"
                    type="button"
                    title="Reload file"
                    aria-label="Reload file"
                    disabled={saveState.status === "saving"}
                    onClick={() => void handleReloadPreview()}
                  >
                    <RefreshCw aria-hidden="true" />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="Save file"
                    aria-label="Save file"
                    disabled={!isDirty || saveState.status === "saving" || saveState.status === "conflict"}
                    onClick={() => void handleSavePreview()}
                  >
                    <Save aria-hidden="true" />
                  </button>
                </>
              )}
              {preview.status === "ready" && selectedEntry && selectedEntry.type !== "directory" && (
                <button className="icon-button" type="button" title="Download" aria-label="Download" onClick={() => void handleDownload(selectedEntry)}>
                  <Download aria-hidden="true" />
                </button>
              )}
              <button className="icon-button" type="button" title="Close preview" aria-label="Close preview" onClick={handleClosePreview}>
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          {preview.status === "loading" && (
            <div className="remote-file-empty">Loading preview...</div>
          )}
          {preview.status === "error" && (
            <div className="remote-file-error">
              <span>{preview.message}</span>
            </div>
          )}
          {preview.status === "ready" && (
            preview.preview.kind === "text" ? (
              <>
                {saveState.status !== "idle" && saveState.status !== "saving" && (
                  <div className={`remote-preview-save-message ${saveState.status}`}>
                    <span>{saveState.message}</span>
                    {saveState.status === "conflict" && (
                      <button type="button" onClick={() => void handleReloadPreview()}>Reload</button>
                    )}
                  </div>
                )}
                <div className="remote-preview-search">
                  <Search aria-hidden="true" />
                  <input
                    type="text"
                    aria-label="Search preview content"
                    placeholder="Search preview..."
                    value={previewSearchQuery}
                    onChange={(event) => setPreviewSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        movePreviewMatch(event.shiftKey ? -1 : 1);
                      }
                    }}
                  />
                  <span className="remote-preview-match-count">
                    {previewMatches.length ? activePreviewMatch + 1 : 0} / {previewMatches.length}
                  </span>
                  <button type="button" title="Previous match" aria-label="Previous match" disabled={!previewMatches.length} onClick={() => movePreviewMatch(-1)}>
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button type="button" title="Next match" aria-label="Next match" disabled={!previewMatches.length} onClick={() => movePreviewMatch(1)}>
                    <ArrowDown aria-hidden="true" />
                  </button>
                  <button type="button" title="Clear preview search" aria-label="Clear preview search" disabled={!previewSearchQuery} onClick={() => setPreviewSearchQuery("")}>
                    <X aria-hidden="true" />
                  </button>
                </div>
                <textarea
                  ref={previewContentRef}
                  className="remote-preview-editor"
                  aria-label="Edit file content"
                  spellCheck={false}
                  value={editorContent}
                  onChange={(event) => {
                    setEditorContent(event.target.value);
                    if (saveState.status === "error") {
                      setSaveState({ status: "idle" });
                    }
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      void handleSavePreview();
                    }
                  }}
                />
                <div className="remote-preview-status">
                  <span>{formatSize(new TextEncoder().encode(editorContent).length)}</span>
                  <span>{saveState.status === "saving" ? "Saving..." : isDirty ? "Unsaved changes" : "Saved"}</span>
                </div>
              </>
            ) : preview.preview.kind === "too_large" ? (
              <div className="remote-file-empty">
                File is {formatSize(preview.preview.size)}. Download it to view locally.
              </div>
            ) : (
              <div className="remote-file-empty">Binary file. Download it to view locally.</div>
            )
          )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
