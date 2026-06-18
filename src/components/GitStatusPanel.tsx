import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowUp, FileDiff, GitBranch, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import type {
  GitBranchEntry,
  GitBranchListResult,
  GitDiffResult,
  GitStashListResult,
  GitStatusEntry,
  GitStatusResult,
  TerminalSession
} from "../vite-env";

type GitStatusPanelProps = {
  session?: TerminalSession;
};

type GitStatusState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: GitStatusResult; branches: GitBranchListResult; stashes: GitStashListResult }
  | { status: "error"; message: string };

type GitDiffState =
  | { status: "idle" }
  | { status: "loading"; file: GitStatusEntry }
  | { status: "ready"; file: GitStatusEntry; result: GitDiffResult }
  | { status: "error"; file: GitStatusEntry; message: string };

type OperationState =
  | { status: "idle" }
  | { status: "running"; label: string }
  | { status: "error"; message: string };

type GitDiffSearchSide = "both" | "old" | "new";

type GitDiffSearchMatch = {
  id: string;
  rowIndex: number;
  side: Exclude<GitDiffSearchSide, "both">;
  start: number;
  end: number;
};

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

function branchKey(branch: Pick<GitBranchEntry, "kind" | "name">) {
  return `${branch.kind}:${branch.name}`;
}

function getDiffSearchMatches(text: string | undefined, query: string) {
  if (!text || !query) {
    return [];
  }
  const matches: Array<{ start: number; end: number }> = [];
  const normalizedText = text.toLowerCase();
  let start = normalizedText.indexOf(query);
  while (start !== -1) {
    matches.push({ start, end: start + query.length });
    start = normalizedText.indexOf(query, start + query.length);
  }
  return matches;
}

function HighlightDiffText({ text, matches, activeMatchId }: {
  text: string;
  matches: GitDiffSearchMatch[];
  activeMatchId?: string;
}) {
  if (!matches.length) {
    return <>{text}</>;
  }

  const content = [];
  let offset = 0;
  for (const match of matches) {
    if (match.start > offset) {
      content.push(text.slice(offset, match.start));
    }
    const isActive = match.id === activeMatchId;
    content.push(
      <mark
        className={isActive ? "active" : undefined}
        data-active-diff-match={isActive ? "true" : undefined}
        key={match.id}
      >
        {text.slice(match.start, match.end)}
      </mark>
    );
    offset = match.end;
  }
  if (offset < text.length) {
    content.push(text.slice(offset));
  }

  return <>{content}</>;
}

function GitDiffDialog({ state, onRetry, onClose }: {
  state: Exclude<GitDiffState, { status: "idle" }>;
  onRetry: (file: GitStatusEntry) => void;
  onClose: () => void;
}) {
  const fileTitle = formatFilePath(state.file);
  const [diffSearchQuery, setDiffSearchQuery] = useState("");
  const [diffSearchSide, setDiffSearchSide] = useState<GitDiffSearchSide>("both");
  const [activeDiffMatch, setActiveDiffMatch] = useState(0);
  const diffGridRef = useRef<HTMLDivElement>(null);
  const normalizedDiffSearchQuery = diffSearchQuery.trim().toLowerCase();
  const textRows = state.status === "ready" && state.result.kind === "text" ? state.result.rows : [];

  const diffMatches = useMemo<GitDiffSearchMatch[]>(() => {
    if (!normalizedDiffSearchQuery || !textRows.length) {
      return [];
    }

    const matches: GitDiffSearchMatch[] = [];
    for (const [rowIndex, row] of textRows.entries()) {
      const sides: Array<Exclude<GitDiffSearchSide, "both">> = diffSearchSide === "both"
        ? ["old", "new"]
        : [diffSearchSide];
      for (const side of sides) {
        const text = side === "old" ? row.oldText : row.newText;
        for (const [matchIndex, match] of getDiffSearchMatches(text, normalizedDiffSearchQuery).entries()) {
          matches.push({
            id: `${rowIndex}:${side}:${matchIndex}`,
            rowIndex,
            side,
            start: match.start,
            end: match.end
          });
        }
      }
    }
    return matches;
  }, [diffSearchSide, normalizedDiffSearchQuery, textRows]);

  const diffMatchesByCell = useMemo(() => {
    const matchesByCell = new Map<string, GitDiffSearchMatch[]>();
    for (const match of diffMatches) {
      const key = `${match.rowIndex}:${match.side}`;
      const current = matchesByCell.get(key);
      if (current) {
        current.push(match);
      } else {
        matchesByCell.set(key, [match]);
      }
    }
    return matchesByCell;
  }, [diffMatches]);

  const activeDiffMatchId = diffMatches[activeDiffMatch]?.id;
  const showDiffSearch = state.status === "ready" && state.result.kind === "text" && state.result.rows.length > 0;

  useEffect(() => {
    setActiveDiffMatch(0);
  }, [diffSearchSide, normalizedDiffSearchQuery, state.file.path]);

  useEffect(() => {
    if (!diffMatches.length) {
      if (activeDiffMatch !== 0) {
        setActiveDiffMatch(0);
      }
      return;
    }
    if (activeDiffMatch >= diffMatches.length) {
      setActiveDiffMatch(0);
    }
  }, [activeDiffMatch, diffMatches.length]);

  useEffect(() => {
    if (!diffMatches.length) {
      return;
    }
    const activeElement = diffGridRef.current?.querySelector('[data-active-diff-match="true"]');
    activeElement?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeDiffMatch, diffMatches.length]);

  const moveDiffMatch = useCallback((direction: number) => {
    if (!diffMatches.length) {
      return;
    }
    setActiveDiffMatch((current) => (
      (current + direction + diffMatches.length) % diffMatches.length
    ));
  }, [diffMatches.length]);

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

        {showDiffSearch && (
          <div className="git-diff-search">
            <Search aria-hidden="true" />
            <input
              type="text"
              aria-label="Search diff"
              placeholder="Search diff..."
              value={diffSearchQuery}
              onChange={(event) => setDiffSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  moveDiffMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <div className="git-diff-search-scope" aria-label="Diff search side">
              <button
                type="button"
                className={diffSearchSide === "both" ? "active" : ""}
                aria-pressed={diffSearchSide === "both"}
                onClick={() => setDiffSearchSide("both")}
              >
                All
              </button>
              <button
                type="button"
                className={diffSearchSide === "old" ? "active" : ""}
                aria-pressed={diffSearchSide === "old"}
                onClick={() => setDiffSearchSide("old")}
              >
                HEAD
              </button>
              <button
                type="button"
                className={diffSearchSide === "new" ? "active" : ""}
                aria-pressed={diffSearchSide === "new"}
                onClick={() => setDiffSearchSide("new")}
              >
                Working tree
              </button>
            </div>
            <span className="git-diff-match-count">
              {diffMatches.length ? activeDiffMatch + 1 : 0} / {diffMatches.length}
            </span>
            <button type="button" title="Previous match" aria-label="Previous match" disabled={!diffMatches.length} onClick={() => moveDiffMatch(-1)}>
              <ArrowUp aria-hidden="true" />
            </button>
            <button type="button" title="Next match" aria-label="Next match" disabled={!diffMatches.length} onClick={() => moveDiffMatch(1)}>
              <ArrowDown aria-hidden="true" />
            </button>
            <button type="button" title="Clear diff search" aria-label="Clear diff search" disabled={!diffSearchQuery} onClick={() => setDiffSearchQuery("")}>
              <X aria-hidden="true" />
            </button>
          </div>
        )}

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
          <div className="git-diff-grid" role="table" aria-label={`Diff for ${fileTitle}`} ref={diffGridRef}>
            <div className="git-diff-column-title old" role="columnheader">HEAD</div>
            <div className="git-diff-column-title new" role="columnheader">Working tree</div>
            {state.result.rows.map((row, index) => (
              <div className={`git-diff-row row-${row.type}`} role="row" key={`${index}:${row.oldLineNumber || ""}:${row.newLineNumber || ""}`}>
                <div className="git-diff-cell old" role="cell">
                  <span className="git-diff-line-number">{formatLineNumber(row.oldLineNumber)}</span>
                  <code>
                    <HighlightDiffText
                      text={row.oldText || ""}
                      matches={diffMatchesByCell.get(`${index}:old`) || []}
                      activeMatchId={activeDiffMatchId}
                    />
                  </code>
                </div>
                <div className="git-diff-cell new" role="cell">
                  <span className="git-diff-line-number">{formatLineNumber(row.newLineNumber)}</span>
                  <code>
                    <HighlightDiffText
                      text={row.newText || ""}
                      matches={diffMatchesByCell.get(`${index}:new`) || []}
                      activeMatchId={activeDiffMatchId}
                    />
                  </code>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GitStashDialog({ stashes, busy, onApply, onPop, onClose }: {
  stashes: GitStashListResult;
  busy: boolean;
  onApply: (ref: string) => void;
  onPop: (ref: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="git-stash-overlay" onClick={onClose}>
      <div className="git-stash-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="git-stash-header">
          <span>
            <Archive aria-hidden="true" />
            Stashes
          </span>
          <button className="icon-button" type="button" title="Close stash list" aria-label="Close stash list" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="git-stash-list">
          {stashes.stashes.length === 0 ? (
            <div className="git-status-empty">No stashes found.</div>
          ) : stashes.stashes.map((stash) => (
            <div className="git-stash-row" key={stash.ref}>
              <div className="git-stash-main">
                <strong>{stash.ref}</strong>
                <span title={stash.message}>{stash.message}</span>
                <small>{stash.commit.slice(0, 8)} · {stash.relativeTime}</small>
              </div>
              <div className="git-stash-actions">
                <button className="modal-button" type="button" disabled={busy} onClick={() => onApply(stash.ref)}>Apply</button>
                <button className="modal-button primary" type="button" disabled={busy} onClick={() => onPop(stash.ref)}>Pop</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GitStatusPanel({ session }: GitStatusPanelProps) {
  const [state, setState] = useState<GitStatusState>({ status: "idle" });
  const [diffState, setDiffState] = useState<GitDiffState>({ status: "idle" });
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const [showStashes, setShowStashes] = useState(false);
  const requestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const sessionId = session?.id;
  const isBusy = state.status === "loading" || operation.status === "running";

  const loadStatus = useCallback(async () => {
    if (!sessionId) {
      setState({ status: "idle" });
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState({ status: "loading" });
    try {
      const [result, branches, stashes] = await Promise.all([
        window.gitApi.getStatus(sessionId),
        window.gitApi.getBranches(sessionId),
        window.gitApi.getStashes(sessionId)
      ]);
      if (requestRef.current === requestId) {
        setState({ status: "ready", result, branches, stashes });
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
    setOperation({ status: "idle" });
    setShowStashes(false);
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

  const runOperation = useCallback(async (label: string, action: () => Promise<unknown>) => {
    if (!sessionId) return;
    setOperation({ status: "running", label });
    try {
      await action();
      setOperation({ status: "idle" });
      await loadStatus();
    } catch (err) {
      setOperation({ status: "error", message: getErrorMessage(err) });
    }
  }, [loadStatus, sessionId]);

  const currentBranch = useMemo(() => {
    if (state.status !== "ready") return undefined;
    return state.branches.branches.find((branch) => branch.current);
  }, [state]);

  const handleCheckout = useCallback((value: string) => {
    if (!sessionId || state.status !== "ready" || !value) return;
    const branch = state.branches.branches.find((candidate) => branchKey(candidate) === value);
    if (!branch || branch.current) return;
    void runOperation(`Checking out ${branch.name}`, () => window.gitApi.checkoutBranch(sessionId, {
      name: branch.name,
      kind: branch.kind
    }));
  }, [runOperation, sessionId, state]);

  const handleStash = useCallback(() => {
    if (!sessionId) return;
    void runOperation("Stashing changes", () => window.gitApi.stashChanges(sessionId));
  }, [runOperation, sessionId]);

  const handleApplyStash = useCallback((ref: string) => {
    if (!sessionId) return;
    void runOperation(`Applying ${ref}`, () => window.gitApi.applyStash(sessionId, ref));
  }, [runOperation, sessionId]);

  const handlePopStash = useCallback((ref: string) => {
    if (!sessionId) return;
    void runOperation(`Popping ${ref}`, () => window.gitApi.popStash(sessionId, ref));
  }, [runOperation, sessionId]);

  const handleRevertFile = useCallback((file: GitStatusEntry) => {
    if (!sessionId) return;
    const fileTitle = formatFilePath(file);
    if (!window.confirm(`Discard changes to ${fileTitle}?`)) {
      return;
    }
    void runOperation(`Discarding ${file.path}`, async () => {
      await window.gitApi.revertFile(sessionId, file);
      closeDiff();
    });
  }, [closeDiff, runOperation, sessionId]);

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
            disabled={isBusy}
            onClick={() => void loadStatus()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>

        {state.status === "ready" && (
          <div className="git-status-actions">
            <label className="git-branch-select">
              <GitBranch aria-hidden="true" />
              <select
                value={currentBranch ? branchKey(currentBranch) : ""}
                disabled={isBusy}
                title="Checkout branch"
                aria-label="Checkout branch"
                onChange={(event) => handleCheckout(event.target.value)}
              >
                <option value="" disabled>Checkout branch</option>
                {state.branches.branches.map((branch) => (
                  <option value={branchKey(branch)} key={branchKey(branch)}>
                    {branch.current ? "✓ " : ""}{branch.name}{branch.kind === "remote" ? " (remote)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="git-action-button" type="button" disabled={isBusy} onClick={handleStash}>
              <Archive aria-hidden="true" />
              Stash
            </button>
            <button className="git-action-button" type="button" disabled={isBusy} onClick={() => setShowStashes(true)}>
              Stashes ({state.stashes.stashes.length})
            </button>
          </div>
        )}

        {operation.status === "running" && (
          <div className="git-status-note">{operation.label}...</div>
        )}

        {operation.status === "error" && (
          <div className="git-status-error">
            <span>{operation.message}</span>
            <button type="button" onClick={() => setOperation({ status: "idle" })}>Dismiss</button>
          </div>
        )}

        {state.status === "error" && (
          <div className="git-status-error">
            <span>{state.message}</span>
            <button type="button" onClick={() => void loadStatus()}>Retry</button>
          </div>
        )}

        <div className="git-status-list" aria-busy={state.status === "loading" || operation.status === "running"}>
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
                <div
                  className={`git-status-row ${isDiffLoading ? "loading" : ""}`}
                  key={`${file.status}:${file.path}:${file.oldPath || ""}`}
                >
                  <button
                    className="git-status-file-btn"
                    type="button"
                    title={`Open diff: ${fileTitle}`}
                    onClick={() => void loadDiff(file)}
                  >
                    <span className={`git-status-badge status-${getStatusClass(file.status)}`}>{file.label}</span>
                    <span className="git-status-path" title={fileTitle}>
                      {fileTitle}
                    </span>
                  </button>
                  <button
                    className="git-status-revert"
                    type="button"
                    title={`Discard changes: ${fileTitle}`}
                    aria-label={`Discard changes: ${fileTitle}`}
                    disabled={isBusy}
                    onClick={() => handleRevertFile(file)}
                  >
                    <RotateCcw aria-hidden="true" />
                  </button>
                </div>
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

      {showStashes && state.status === "ready" && (
        <GitStashDialog
          stashes={state.stashes}
          busy={isBusy}
          onApply={handleApplyStash}
          onPop={handlePopStash}
          onClose={() => setShowStashes(false)}
        />
      )}
    </>
  );
}
