import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import type { GitStatusResult, TerminalSession } from "../vite-env";

type GitStatusPanelProps = {
  session?: TerminalSession;
};

type GitStatusState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: GitStatusResult }
  | { status: "error"; message: string };

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function getStatusClass(status: string) {
  if (status === "?") return "untracked";
  if (status === "!") return "ignored";
  return status.toLowerCase();
}

export function GitStatusPanel({ session }: GitStatusPanelProps) {
  const [state, setState] = useState<GitStatusState>({ status: "idle" });
  const requestRef = useRef(0);
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
          state.result.files.map((file) => (
            <div className="git-status-row" key={`${file.status}:${file.path}:${file.oldPath || ""}`}>
              <span className={`git-status-badge status-${getStatusClass(file.status)}`}>{file.label}</span>
              <span className="git-status-path" title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}>
                {file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
              </span>
            </div>
          ))
        ) : (
          <div className="git-status-empty">Git status has not been loaded.</div>
        )}
      </div>
    </aside>
  );
}
