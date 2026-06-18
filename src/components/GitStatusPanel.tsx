import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowUp, ChevronDown, FileDiff, FolderInput, GitBranch, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
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
          <button className="icon-button" type="button" title={t("git.closeDiff")} aria-label={t("git.closeDiff")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>

        {showDiffSearch && (
          <div className="git-diff-search">
            <Search aria-hidden="true" />
            <input
              type="text"
              aria-label={t("git.searchDiff")}
              placeholder={t("git.searchDiffPlaceholder")}
              value={diffSearchQuery}
              onChange={(event) => setDiffSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  moveDiffMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <div className="git-diff-search-scope" aria-label={t("git.diffSearchSide")}>
              <button
                type="button"
                className={diffSearchSide === "both" ? "active" : ""}
                aria-pressed={diffSearchSide === "both"}
                onClick={() => setDiffSearchSide("both")}
              >
                {t("git.all")}
              </button>
              <button
                type="button"
                className={diffSearchSide === "old" ? "active" : ""}
                aria-pressed={diffSearchSide === "old"}
                onClick={() => setDiffSearchSide("old")}
              >
                {t("git.head")}
              </button>
              <button
                type="button"
                className={diffSearchSide === "new" ? "active" : ""}
                aria-pressed={diffSearchSide === "new"}
                onClick={() => setDiffSearchSide("new")}
              >
                {t("git.workingTree")}
              </button>
            </div>
            <span className="git-diff-match-count">
              {diffMatches.length ? activeDiffMatch + 1 : 0} / {diffMatches.length}
            </span>
            <button type="button" title={t("files.previousMatch")} aria-label={t("files.previousMatch")} disabled={!diffMatches.length} onClick={() => moveDiffMatch(-1)}>
              <ArrowUp aria-hidden="true" />
            </button>
            <button type="button" title={t("files.nextMatch")} aria-label={t("files.nextMatch")} disabled={!diffMatches.length} onClick={() => moveDiffMatch(1)}>
              <ArrowDown aria-hidden="true" />
            </button>
            <button type="button" title={t("git.clearDiffSearch")} aria-label={t("git.clearDiffSearch")} disabled={!diffSearchQuery} onClick={() => setDiffSearchQuery("")}>
              <X aria-hidden="true" />
            </button>
          </div>
        )}

        {state.status === "loading" && (
          <div className="git-diff-empty">{t("git.loadingDiff")}</div>
        )}

        {state.status === "error" && (
          <div className="git-diff-error">
            <span>{state.message}</span>
            <button type="button" onClick={() => onRetry(state.file)}>{t("common.retry")}</button>
          </div>
        )}

        {state.status === "ready" && state.result.kind === "binary" && (
          <div className="git-diff-empty">{t("git.binaryDiff")}</div>
        )}

        {state.status === "ready" && state.result.kind === "text" && state.result.rows.length === 0 && (
          <div className="git-diff-empty">{t("git.noTextChanges")}</div>
        )}

        {state.status === "ready" && state.result.kind === "text" && state.result.rows.length > 0 && (
          <div className="git-diff-grid" role="table" aria-label={t("git.diffFor", { file: fileTitle })} ref={diffGridRef}>
            <div className="git-diff-column-title old" role="columnheader">{t("git.head")}</div>
            <div className="git-diff-column-title new" role="columnheader">{t("git.workingTree")}</div>
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
  const { t } = useI18n();

  return (
    <div className="git-stash-overlay" onClick={onClose}>
      <div className="git-stash-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="git-stash-header">
          <span>
            <Archive aria-hidden="true" />
            {t("git.stash")}
          </span>
          <button className="icon-button" type="button" title={t("git.closeStashes")} aria-label={t("git.closeStashes")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="git-stash-list">
          {stashes.stashes.length === 0 ? (
            <div className="git-status-empty">{t("git.noStashes")}</div>
          ) : stashes.stashes.map((stash) => (
            <div className="git-stash-row" key={stash.ref}>
              <div className="git-stash-main">
                <strong>{stash.ref}</strong>
                <span title={stash.message}>{stash.message}</span>
                <small>{stash.commit.slice(0, 8)} - {stash.relativeTime}</small>
              </div>
              <div className="git-stash-actions">
                <button className="modal-button" type="button" disabled={busy} onClick={() => onApply(stash.ref)}>{t("git.apply")}</button>
                <button className="modal-button primary" type="button" disabled={busy} onClick={() => onPop(stash.ref)}>{t("git.pop")}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GitStatusPanel({ session }: GitStatusPanelProps) {
  const { t } = useI18n();
  const [state, setState] = useState<GitStatusState>({ status: "idle" });
  const [diffState, setDiffState] = useState<GitDiffState>({ status: "idle" });
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const [showStashes, setShowStashes] = useState(false);
  const [directoryInput, setDirectoryInput] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const [directoryChanging, setDirectoryChanging] = useState(false);
  const [directoryHistoryOpen, setDirectoryHistoryOpen] = useState(false);
  const [highlightedDirectoryIndex, setHighlightedDirectoryIndex] = useState(-1);
  const requestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const directoryControlRef = useRef<HTMLDivElement>(null);
  const sessionId = session?.id;
  const currentGitCwd = session?.gitCwd || session?.cwd || "";
  const isBusy = state.status === "loading" || operation.status === "running" || directoryChanging;
  const directoryHistory = useMemo(() => {
    const values = [currentGitCwd, ...(session?.gitCwdHistory || []), session?.cwd || ""];
    const seen = new Set<string>();
    return values.filter((value) => {
      const trimmed = value.trim();
      const key = session?.type === "windows" ? trimmed.toLowerCase() : trimmed;
      if (!trimmed || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [currentGitCwd, session?.cwd, session?.gitCwdHistory, session?.type]);

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
  }, [currentGitCwd, sessionId]);

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

  useEffect(() => {
    setDirectoryInput(currentGitCwd);
    setDirectoryError("");
    setDirectoryHistoryOpen(false);
  }, [currentGitCwd, sessionId]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!directoryControlRef.current?.contains(event.target as Node)) {
        setDirectoryHistoryOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

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
    if (!window.confirm(t("git.discardConfirm", { file: fileTitle }))) {
      return;
    }
    void runOperation(`Discarding ${file.path}`, async () => {
      await window.gitApi.revertFile(sessionId, file);
      closeDiff();
    });
  }, [closeDiff, runOperation, sessionId, t]);

  const handleDirectoryChange = useCallback(async (directory = directoryInput) => {
    const nextCwd = directory.trim();
    if (!sessionId || !nextCwd || nextCwd === currentGitCwd || directoryChanging) return;
    setDirectoryHistoryOpen(false);
    setDirectoryChanging(true);
    setDirectoryError("");
    try {
      const result = await window.gitApi.changeDirectory(sessionId, nextCwd);
      requestRef.current += 1;
      diffRequestRef.current += 1;
      setState({ status: "ready", result: result.status, branches: result.branches, stashes: result.stashes });
      setDirectoryInput(result.cwd);
      setDiffState({ status: "idle" });
      setOperation({ status: "idle" });
      setShowStashes(false);
    } catch (err) {
      setDirectoryInput(currentGitCwd);
      setDirectoryError(getErrorMessage(err));
    } finally {
      setDirectoryChanging(false);
    }
  }, [currentGitCwd, directoryChanging, directoryInput, sessionId]);

  const selectDirectoryHistory = useCallback((directory: string) => {
    setDirectoryInput(directory);
    setDirectoryHistoryOpen(false);
    void handleDirectoryChange(directory);
  }, [handleDirectoryChange]);

  if (!sessionId || !session) {
    return (
      <aside className="git-status-panel">
        <div className="git-status-header">
          <div>
            <h2>Git</h2>
            <span>{t("git.noSession")}</span>
          </div>
        </div>
        <div className="git-status-empty">{t("git.availableAfterSession")}</div>
      </aside>
    );
  }

  return (
    <>
      <aside className="git-status-panel">
        <div className="git-status-header">
          <div>
            <h2>Git</h2>
            <span title={currentGitCwd}>{currentGitCwd}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            title={t("git.refreshStatus")}
            aria-label={t("git.refreshStatus")}
            disabled={isBusy}
            onClick={() => void loadStatus()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>

        <div className="git-directory-control" ref={directoryControlRef}>
          <div className="git-directory-field">
            <input
              type="text"
              role="combobox"
              value={directoryInput}
              title={directoryInput}
              aria-label={t("git.directory")}
              aria-autocomplete="list"
              aria-expanded={directoryHistoryOpen}
              aria-controls={`git-directory-history-${sessionId}`}
              placeholder={t("git.directoryPlaceholder")}
              disabled={isBusy}
              onChange={(event) => setDirectoryInput(event.target.value)}
              onFocus={() => {
                setHighlightedDirectoryIndex(-1);
                setDirectoryHistoryOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setDirectoryHistoryOpen(true);
                  setHighlightedDirectoryIndex((current) => {
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    if (current < 0) return delta > 0 ? 0 : directoryHistory.length - 1;
                    return (current + delta + directoryHistory.length) % directoryHistory.length;
                  });
                } else if (event.key === "Escape") {
                  setDirectoryHistoryOpen(false);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (directoryHistoryOpen && highlightedDirectoryIndex >= 0 && directoryHistory[highlightedDirectoryIndex]) {
                    selectDirectoryHistory(directoryHistory[highlightedDirectoryIndex]);
                  } else {
                    void handleDirectoryChange();
                  }
                }
              }}
            />
            <button
              className="git-directory-toggle"
              type="button"
              title={t("git.directory")}
              aria-label={t("git.directory")}
              aria-expanded={directoryHistoryOpen}
              disabled={isBusy}
              onClick={() => {
                setHighlightedDirectoryIndex(-1);
                setDirectoryHistoryOpen((open) => !open);
              }}
            >
              <ChevronDown aria-hidden="true" />
            </button>
            {directoryHistoryOpen && (
              <div className="git-directory-history" id={`git-directory-history-${sessionId}`} role="listbox">
                {directoryHistory.map((directory, index) => (
                  <button
                    className={`${index === highlightedDirectoryIndex ? "highlighted" : ""} ${directory === currentGitCwd ? "current" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={directory === currentGitCwd}
                    title={directory}
                    key={directory}
                    onMouseEnter={() => setHighlightedDirectoryIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectDirectoryHistory(directory)}
                  >
                    {directory}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="icon-button"
            type="button"
            title={t("git.changeDirectory")}
            aria-label={t("git.changeDirectory")}
            disabled={isBusy || !directoryInput.trim() || directoryInput.trim() === currentGitCwd}
            onClick={() => void handleDirectoryChange()}
          >
            <FolderInput aria-hidden="true" />
          </button>
        </div>

        {directoryError && (
          <div className="git-status-error">
            <span>{directoryError}</span>
            <button type="button" onClick={() => setDirectoryError("")}>{t("git.dismiss")}</button>
          </div>
        )}

        {state.status === "ready" && (
          <div className="git-status-actions">
            <label className="git-branch-select">
              <GitBranch aria-hidden="true" />
              <select
                value={currentBranch ? branchKey(currentBranch) : ""}
                disabled={isBusy}
                title={t("git.checkoutBranch")}
                aria-label={t("git.checkoutBranch")}
                onChange={(event) => handleCheckout(event.target.value)}
              >
                <option value="" disabled>{t("git.checkoutBranch")}</option>
                {state.branches.branches.map((branch) => (
                  <option value={branchKey(branch)} key={branchKey(branch)}>
                    {branch.current ? "* " : ""}{branch.name}{branch.kind === "remote" ? t("git.remoteBranch") : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="git-action-button" type="button" disabled={isBusy} onClick={handleStash}>
              <Archive aria-hidden="true" />
              {t("git.stash")}
            </button>
            <button className="git-action-button" type="button" disabled={isBusy} onClick={() => setShowStashes(true)}>
              {t("git.stashes", { count: state.stashes.stashes.length })}
            </button>
          </div>
        )}

        {operation.status === "running" && (
          <div className="git-status-note">{t("git.operationRunning", { label: operation.label })}</div>
        )}

        {operation.status === "error" && (
          <div className="git-status-error">
            <span>{operation.message}</span>
            <button type="button" onClick={() => setOperation({ status: "idle" })}>{t("git.dismiss")}</button>
          </div>
        )}

        {state.status === "error" && (
          <div className="git-status-error">
            <span>{state.message}</span>
            <button type="button" onClick={() => void loadStatus()}>{t("common.retry")}</button>
          </div>
        )}

        <div className="git-status-list" aria-busy={state.status === "loading" || operation.status === "running"}>
          {state.status === "loading" ? (
            <div className="git-status-empty">{t("git.loadingStatus")}</div>
          ) : state.status === "ready" && state.result.clean ? (
            <div className="git-status-empty">
              <GitBranch aria-hidden="true" />
              <span>{t("git.clean")}</span>
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
                    title={t("git.openDiff", { file: fileTitle })}
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
                    title={t("git.discardChanges", { file: fileTitle })}
                    aria-label={t("git.discardChanges", { file: fileTitle })}
                    disabled={isBusy}
                    onClick={() => handleRevertFile(file)}
                  >
                    <RotateCcw aria-hidden="true" />
                  </button>
                </div>
              );
            })
          ) : (
            <div className="git-status-empty">{t("git.notLoaded")}</div>
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
