import { useCallback, useEffect, useRef, useState } from "react";
import { FileDiff, GitBranch, RefreshCw, X } from "lucide-react";
import type { GitDiffResult, GitStatusEntry, GitStatusResult, TerminalSession } from "../vite-env";

type GitStatusPanelProps = {
  session?: TerminalSession;
};

type GitStatusState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: GitStatusResult }
  | { status: "error"; message: string };

type GitDiffState =
  | { status: "idle" }
  | { status: "loading"; file: GitStatusEntry }
  | { status: "ready"; file: GitStatusEntry; result: GitDiffResult }
  | { status: "error"; file: GitStatusEntry; message: string };

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function getStatusClass(status: string) {
  if (status === "?") return "untracked";
  if (status === "!") return "ignored";
  return status.toLowerCase();
}

function formatFilePath(file: Pick<GitStatusEntry, "path" | "oldPath">) {
  return file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
}

function formatLineNumber(value?: number) {
  return typeof value === "number" ? String(value) : "";
}

function GitDiffDialog({ state, onRetry, onClose }: {
  state: Exclude<GitDiffState, { status: "idle" }>;
  onRetry: (file: GitStatusEntry) => void;
  onClose: () => void;
}) {
  const fileTitle = formatFilePath(state.file);

  return (
    <div className="git-diff-overlay" onClick={onClose}>
      <div className="git-diff-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="git-diff-header">
          <span>
            <FileDiff aria-hidden="true" />
            {fileTitle}
          </span>
          <button className="icon-button" type="button" title="Close diff" aria-label="Close diff" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>

        {state.status === "loading" && (
          <div className="git-diff-empty">Loading diff...</div>
        )}

        {state.status === "error" && (
          <div className="git-diff-error">
            <span>{state.message}</span>
            <button type="button" onClick={() => onRetry(state.file)}>Retry</button>
          </div>
        )}

        {state.status === "ready" && state.result.kind === "binary" && (
          <div className="git-diff-empty">Binary file. Diff preview is not available.</div>
        )}

        {state.status === "ready" && state.result.kind === "text" && state.result.rows.length === 0 && (
          <div className="git-diff-empty">No textual changes to display.</div>
        )}

        {state.status === "ready" && state.result.kind === "text" && state.result.rows.length > 0 && (
          <div className="git-diff-grid" role="table" aria-label={`Diff for ${fileTitle}`}>
            <div className="git-diff-column-title old" role="columnheader">HEAD</div>
            <div className="git-diff-column-title new" role="columnheader">Working tree</div>
            {state.result.rows.map((row, index) => (
              <div className={`git-diff-row row-${row.type}`} role="row" key={`${index}:${row.oldLineNumber || ""}:${row.newLineNumber || ""}`}>
                <div className="git-diff-cell old" role="cell">
                  <span className="git-diff-line-number">{formatLineNumber(row.oldLineNumber)}</span>
                  <code>{row.oldText || ""}</code>
                </div>
                <div className="git-diff-cell new" role="cell">
                  <span className="git-diff-line-number">{formatLineNumber(row.newLineNumber)}</span>
                  <code>{row.newText || ""}</code>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function GitStatusPanel({ session }: GitStatusPanelProps) {
  const [state, setState] = useState<GitStatusState>({ status: "idle" });
  const [diffState, setDiffState] = useState<GitDiffState>({ status: "idle" });
  const requestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const sessionId = session?.id;

  const loadStatus = useCallback(async () => {
    if (!sessionId) {
      setState({ status: "idle" });
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState({ status: "loading" });
    try {
      const result = await window.gitApi.getStatus(sessionId);
      if (requestRef.current === requestId) {
        setState({ status: "ready", result });
      }
    } catch (err) {
      if (requestRef.current === requestId) {
        setState({ status: "error", message: getErrorMessage(err) });
      }
    }
  }, [sessionId]);

  useEffect(() => {
    void loadStatus();
    return () => {
      requestRef.current += 1;
    };
  }, [loadStatus]);

  useEffect(() => {
    setDiffState({ status: "idle" });
    diffRequestRef.current += 1;
  }, [sessionId]);

  const closeDiff = useCallback(() => {
    diffRequestRef.current += 1;
    setDiffState({ status: "idle" });
  }, []);

  const loadDiff = useCallback(async (file: GitStatusEntry) => {
    if (!sessionId) return;
    const requestId = diffRequestRef.current + 1;
    diffRequestRef.current = requestId;
    setDiffState({ status: "loading", file });
    try {
      const result = await window.gitApi.getDiff(sessionId, file);
      if (diffRequestRef.current === requestId) {
        setDiffState({ status: "ready", file, result });
      }
    } catch (err) {
      if (diffRequestRef.current === requestId) {
        setDiffState({ status: "error", file, message: getErrorMessage(err) });
      }
    }
  }, [sessionId]);

  if (!sessionId || !session) {
    return (
      <aside className="git-status-panel">
        <div className="git-status-header">
          <div>
            <h2>Git</h2>
            <span>No session selected</span>
          </div>
        </div>
        <div className="git-status-empty">Git status is available after selecting a session.</div>
      </aside>
    );
  }

  return (
    <>
      <aside className="git-status-panel">
        <div className="git-status-header">
          <div>
            <h2>Git</h2>
            <span title={session.cwd}>{session.cwd}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            title="Refresh Git status"
            aria-label="Refresh Git status"
            disabled={state.status === "loading"}
            onClick={() => void loadStatus()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>

        {state.status === "error" && (
          <div className="git-status-error">
            <span>{state.message}</span>
            <button type="button" onClick={() => void loadStatus()}>Retry</button>
          </div>
        )}

        <div className="git-status-list" aria-busy={state.status === "loading"}>
          {state.status === "loading" ? (
            <div className="git-status-empty">Loading Git status...</div>
          ) : state.status === "ready" && state.result.clean ? (
            <div className="git-status-empty">
              <GitBranch aria-hidden="true" />
              <span>Working directory is clean.</span>
            </div>
          ) : state.status === "ready" ? (
            state.result.files.map((file) => {
              const fileTitle = formatFilePath(file);
              const isDiffLoading = diffState.status === "loading" && diffState.file.path === file.path;
              return (
                <button
                  className={`git-status-row ${isDiffLoading ? "loading" : ""}`}
                  type="button"
                  key={`${file.status}:${file.path}:${file.oldPath || ""}`}
                  title={`Open diff: ${fileTitle}`}
                  onClick={() => void loadDiff(file)}
                >
                  <span className={`git-status-badge status-${getStatusClass(file.status)}`}>{file.label}</span>
                  <span className="git-status-path" title={fileTitle}>
                    {fileTitle}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="git-status-empty">Git status has not been loaded.</div>
          )}
        </div>
      </aside>

      {diffState.status !== "idle" && (
        <GitDiffDialog state={diffState} onRetry={(file) => void loadDiff(file)} onClose={closeDiff} />
      )}
    </>
  );
}
