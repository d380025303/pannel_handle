import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Download, File, FileText, Folder, RefreshCw, Upload } from "lucide-react";
import type { RemoteFileEntry, RemoteTextPreview, TerminalSession } from "../vite-env";

type RemoteFilePanelProps = {
  session?: TerminalSession;
};

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; fileName: string; preview: RemoteTextPreview }
  | { status: "error"; path: string; message: string };

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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export function RemoteFilePanel({ session }: RemoteFilePanelProps) {
  const [currentPath, setCurrentPath] = useState(".");
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const isSshSession = session?.type === "ssh";
  const sessionId = session?.id;

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath),
    [entries, selectedPath]
  );

  const loadDirectory = useCallback(async (path: string) => {
    if (!sessionId || !isSshSession) {
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const nextEntries = await window.remoteFileApi.list(sessionId, path);
      if (requestRef.current !== requestId) return;
      setCurrentPath(path);
      setEntries(nextEntries);
      setSelectedPath(null);
      setPreview({ status: "idle" });
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(getErrorMessage(err));
      setEntries([]);
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [isSshSession, sessionId]);

  useEffect(() => {
    if (!sessionId || !isSshSession) {
      setCurrentPath(".");
      setEntries([]);
      setSelectedPath(null);
      setPreview({ status: "idle" });
      setError(null);
      setLoading(false);
      return;
    }

    let disposed = false;
    setLoading(true);
    setError(null);
    window.remoteFileApi.getHome(sessionId)
      .then((home) => {
        if (!disposed) {
          void loadDirectory(home || ".");
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
    };
  }, [isSshSession, loadDirectory, sessionId]);

  const handleOpenEntry = useCallback(async (entry: RemoteFileEntry) => {
    setSelectedPath(entry.path);
    if (entry.type === "directory") {
      await loadDirectory(entry.path);
      return;
    }

    if (!sessionId) return;
    setPreview({ status: "loading", path: entry.path });
    try {
      const nextPreview = await window.remoteFileApi.readText(sessionId, entry.path);
      setPreview({
        status: "ready",
        path: entry.path,
        fileName: entry.name,
        preview: nextPreview
      });
    } catch (err) {
      setPreview({
        status: "error",
        path: entry.path,
        message: getErrorMessage(err)
      });
    }
  }, [loadDirectory, sessionId]);

  const handleRefresh = useCallback(() => {
    void loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const handleUpload = useCallback(async () => {
    if (!sessionId) return;
    const result = await window.remoteFileApi.uploadFile(sessionId, currentPath);
    if (!result.canceled) {
      await loadDirectory(currentPath);
      if (result.remotePath) {
        setSelectedPath(result.remotePath);
      }
    }
  }, [currentPath, loadDirectory, sessionId]);

  const handleDownload = useCallback(async (entry: RemoteFileEntry) => {
    if (!sessionId || entry.type === "directory") return;
    await window.remoteFileApi.downloadFile(sessionId, entry.path, entry.name);
  }, [sessionId]);

  if (!isSshSession) {
    return (
      <aside className="remote-file-panel">
        <div className="remote-file-header">
          <div>
            <h2>Files</h2>
            <span>No SSH session selected</span>
          </div>
        </div>
        <div className="remote-file-empty">Remote files are available after selecting an SSH session.</div>
      </aside>
    );
  }

  return (
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
          <button className="icon-button" type="button" title="Refresh" aria-label="Refresh" onClick={handleRefresh}>
            <RefreshCw aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" title="Upload file" aria-label="Upload file" onClick={() => void handleUpload()}>
            <Upload aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="remote-file-path" title={currentPath}>{currentPath}</div>

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
        ) : (
          entries.map((entry) => (
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

      <div className="remote-file-preview">
        {preview.status === "idle" && (
          <div className="remote-file-empty">Select a file to preview text.</div>
        )}
        {preview.status === "loading" && (
          <div className="remote-file-empty">Loading preview...</div>
        )}
        {preview.status === "error" && (
          <div className="remote-file-error">
            <span>{preview.message}</span>
          </div>
        )}
        {preview.status === "ready" && (
          <>
            <div className="remote-preview-header">
              <span><FileText aria-hidden="true" />{preview.fileName}</span>
              {selectedEntry && selectedEntry.type !== "directory" && (
                <button className="icon-button" type="button" title="Download" aria-label="Download" onClick={() => void handleDownload(selectedEntry)}>
                  <Download aria-hidden="true" />
                </button>
              )}
            </div>
            {preview.preview.kind === "text" ? (
              <pre>{preview.preview.content}</pre>
            ) : preview.preview.kind === "too_large" ? (
              <div className="remote-file-empty">
                File is {formatSize(preview.preview.size)}. Download it to view locally.
              </div>
            ) : (
              <div className="remote-file-empty">Binary file. Download it to view locally.</div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
