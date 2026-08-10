import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FileDiff,
  FolderInput,
  GitBranch,
  GitCommit,
  History as HistoryIcon,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Trash2,
  X
} from "lucide-react";
import { useI18n } from "../../i18n";
import { SearchableSelect } from "../shared/SearchableSelect";
import type {
  GitBranchEntry,
  GitDiffRequest,
  GitDiffResult,
  GitHistoryEntry,
  GitOperationResult,
  GitRepositorySnapshot,
  GitStashEntry,
  GitStatusEntry,
  GitStatusResult,
  TerminalSession
} from "../../vite-env";

type GitStatusPanelProps = {
  session?: TerminalSession;
  onSummaryChange?: (summary: { changes: number; conflicts: number }) => void;
};

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; snapshot: GitRepositorySnapshot }
  | { status: "error"; message: string };

type DiffState =
  | { status: "idle" }
  | { status: "loading"; request: GitDiffRequest; title: string }
  | { status: "ready"; request: GitDiffRequest; title: string; result: GitDiffResult }
  | { status: "error"; request: GitDiffRequest; title: string; message: string };

type HistoryState =
  | { status: "idle" | "loading"; commits: GitHistoryEntry[] }
  | { status: "ready"; commits: GitHistoryEntry[]; hasMore: boolean; nextSkip: number }
  | { status: "error"; commits: GitHistoryEntry[]; message: string };

type OperationState =
  | { status: "idle" }
  | { status: "running"; id: string; label: string }
  | { status: "success" | "error"; label: string; message: string; details: string; canceled?: boolean };

type CommitDraft = { subject: string; body: string };

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

type DiffSearchSide = "both" | "old" | "new";
type DiffSearchMatch = {
  id: string;
  rowIndex: number;
  side: Exclude<DiffSearchSide, "both">;
  start: number;
  end: number;
};

const commitDrafts = new Map<string, CommitDraft>();
const repositoryOperations = new Map<string, OperationState>();

function createOperationId() {
  return globalThis.crypto?.randomUUID?.() || `git-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function formatFilePath(file: Pick<GitStatusEntry, "path" | "oldPath">) {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

function formatLineNumber(value?: number) {
  return typeof value === "number" ? String(value) : "";
}

function branchKey(branch: Pick<GitBranchEntry, "kind" | "name">) {
  return `${branch.kind}:${branch.name}`;
}

function isIndexChanged(file: GitStatusEntry) {
  return !file.conflicted && ![" ", ".", "?", "!"].includes(file.indexStatus);
}

function isWorktreeChanged(file: GitStatusEntry) {
  return !file.conflicted && (file.indexStatus === "?" || ![" ", ".", "!"].includes(file.worktreeStatus));
}

function statusClass(status: string) {
  if (status === "?") return "untracked";
  if (status === "!") return "ignored";
  return status.toLowerCase();
}

function getMatches(text: string | undefined, query: string) {
  if (!text || !query) return [];
  const matches: Array<{ start: number; end: number }> = [];
  const normalized = text.toLocaleLowerCase();
  let start = normalized.indexOf(query);
  while (start !== -1) {
    matches.push({ start, end: start + query.length });
    start = normalized.indexOf(query, start + query.length);
  }
  return matches;
}

function HighlightText({ text, matches, activeMatchId }: {
  text: string;
  matches: DiffSearchMatch[];
  activeMatchId?: string;
}) {
  if (!matches.length) return <>{text}</>;
  const content: React.ReactNode[] = [];
  let offset = 0;
  for (const match of matches) {
    if (match.start > offset) content.push(text.slice(offset, match.start));
    const active = match.id === activeMatchId;
    content.push(
      <mark className={active ? "active" : undefined} data-active-diff-match={active ? "true" : undefined} key={match.id}>
        {text.slice(match.start, match.end)}
      </mark>
    );
    offset = match.end;
  }
  if (offset < text.length) content.push(text.slice(offset));
  return <>{content}</>;
}

function GitDiffDialog({ state, onRetry, onClose }: {
  state: Exclude<DiffState, { status: "idle" }>;
  onRetry: (request: GitDiffRequest, title: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<DiffSearchSide>("both");
  const [activeIndex, setActiveIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const rows = state.status === "ready" && state.result.kind === "text" ? state.result.rows : [];
  const matches = useMemo<DiffSearchMatch[]>(() => {
    if (!normalizedQuery) return [];
    const collected: DiffSearchMatch[] = [];
    rows.forEach((row, rowIndex) => {
      const sides: Array<"old" | "new"> = side === "both" ? ["old", "new"] : [side];
      sides.forEach((cellSide) => {
        const value = cellSide === "old" ? row.oldText : row.newText;
        getMatches(value, normalizedQuery).forEach((match, matchIndex) => collected.push({
          id: `${rowIndex}:${cellSide}:${matchIndex}`,
          rowIndex,
          side: cellSide,
          ...match
        }));
      });
    });
    return collected;
  }, [normalizedQuery, rows, side]);
  const matchesByCell = useMemo(() => {
    const grouped = new Map<string, DiffSearchMatch[]>();
    matches.forEach((match) => {
      const key = `${match.rowIndex}:${match.side}`;
      grouped.set(key, [...(grouped.get(key) || []), match]);
    });
    return grouped;
  }, [matches]);
  const activeMatchId = matches[activeIndex]?.id;

  useEffect(() => setActiveIndex(0), [normalizedQuery, side]);
  useEffect(() => {
    gridRef.current?.querySelector('[data-active-diff-match="true"]')?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeMatchId]);

  const move = (direction: number) => {
    if (!matches.length) return;
    setActiveIndex((current) => (current + direction + matches.length) % matches.length);
  };

  return (
    <div className="git-diff-overlay" onMouseDown={onClose}>
      <div className="git-diff-dialog" role="dialog" aria-modal="true" aria-label={state.title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="git-diff-header">
          <div><FileDiff aria-hidden="true" /><strong>{state.title}</strong></div>
          <button className="icon-button" type="button" title={t("git.closeDiff")} aria-label={t("git.closeDiff")} onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        {state.status === "ready" && state.result.kind === "text" && state.result.rows.length > 0 && (
          <div className="git-diff-search">
            <Search aria-hidden="true" />
            <input
              value={query}
              placeholder={t("git.searchDiffPlaceholder")}
              aria-label={t("git.searchDiff")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  move(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <div className="git-diff-search-scope" aria-label={t("git.diffSearchSide")}>
              <button type="button" className={side === "both" ? "active" : ""} onClick={() => setSide("both")}>{t("git.all")}</button>
              <button type="button" className={side === "old" ? "active" : ""} onClick={() => setSide("old")}>{t("git.head")}</button>
              <button type="button" className={side === "new" ? "active" : ""} onClick={() => setSide("new")}>{t("git.workingTree")}</button>
            </div>
            <span className="git-diff-match-count">{matches.length ? activeIndex + 1 : 0} / {matches.length}</span>
            <button type="button" disabled={!matches.length} onClick={() => move(-1)}><ArrowUp aria-hidden="true" /></button>
            <button type="button" disabled={!matches.length} onClick={() => move(1)}><ArrowDown aria-hidden="true" /></button>
          </div>
        )}
        {state.status === "loading" ? (
          <div className="git-diff-empty">{t("git.loadingDiff")}</div>
        ) : state.status === "error" ? (
          <div className="git-diff-error"><span>{state.message}</span><button type="button" onClick={() => onRetry(state.request, state.title)}>{t("common.retry")}</button></div>
        ) : state.result.kind === "binary" ? (
          <div className="git-diff-empty">{t("git.binaryDiff")}</div>
        ) : state.result.rows.length === 0 ? (
          <div className="git-diff-empty">{t("git.noTextChanges")}</div>
        ) : (
          <>
            {state.result.truncated && <div className="git-diff-truncated">{t("git.diffTruncated")}</div>}
            <div className="git-diff-grid" role="table" ref={gridRef}>
              <div className="git-diff-column-title old" role="columnheader">{t("git.head")}</div>
              <div className="git-diff-column-title new" role="columnheader">{t("git.workingTree")}</div>
              {state.result.rows.map((row, index) => (
                <div className={`git-diff-row row-${row.type}`} role="row" key={`${index}:${row.oldLineNumber || ""}:${row.newLineNumber || ""}`}>
                  <div className="git-diff-cell old" role="cell">
                    <span className="git-diff-line-number">{formatLineNumber(row.oldLineNumber)}</span>
                    <code><HighlightText text={row.oldText || ""} matches={matchesByCell.get(`${index}:old`) || []} activeMatchId={activeMatchId} /></code>
                  </div>
                  <div className="git-diff-cell new" role="cell">
                    <span className="git-diff-line-number">{formatLineNumber(row.newLineNumber)}</span>
                    <code><HighlightText text={row.newText || ""} matches={matchesByCell.get(`${index}:new`) || []} activeMatchId={activeMatchId} /></code>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="modal-overlay git-confirm-overlay" onMouseDown={onClose}>
      <div className="modal-dialog git-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="git-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="git-confirm-title">{state.title}</h2>
        <p>{state.message}</p>
        <div className="modal-actions">
          <button className="modal-button" type="button" autoFocus onClick={onClose}>{t("common.cancel")}</button>
          <button className="modal-button danger" type="button" onClick={() => { onClose(); state.onConfirm(); }}>{state.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function StashDialog({ stashes, busy, onCreate, onPreview, onApply, onPop, onDrop, onClose }: {
  stashes: GitStashEntry[];
  busy: boolean;
  onCreate: (message: string) => void;
  onPreview: (stash: GitStashEntry) => void;
  onApply: (ref: string) => void;
  onPop: (ref: string) => void;
  onDrop: (stash: GitStashEntry) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [message, setMessage] = useState("");
  return (
    <div className="git-stash-overlay" onMouseDown={onClose}>
      <div className="git-stash-dialog" role="dialog" aria-modal="true" aria-label={t("git.stashes", { count: stashes.length })} onMouseDown={(event) => event.stopPropagation()}>
        <div className="git-stash-header">
          <span><Archive aria-hidden="true" />{t("git.stashManager")}</span>
          <button className="icon-button" type="button" title={t("git.closeStashes")} onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <div className="git-stash-create">
          <input value={message} placeholder={t("git.stashMessage")} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
          <button className="modal-button primary" type="button" disabled={busy} onClick={() => { onCreate(message); setMessage(""); }}>{t("git.createStash")}</button>
        </div>
        <div className="git-stash-list">
          {stashes.length === 0 ? <div className="git-status-empty">{t("git.noStashes")}</div> : stashes.map((stash) => (
            <div className="git-stash-row" key={stash.ref}>
              <div className="git-stash-main">
                <strong>{stash.ref}</strong>
                <span title={stash.message}>{stash.message}</span>
                <small>{stash.commit.slice(0, 8)} · {stash.relativeTime}</small>
              </div>
              <div className="git-stash-actions">
                <button className="modal-button" type="button" disabled={busy} onClick={() => onPreview(stash)}>{t("git.preview")}</button>
                <button className="modal-button" type="button" disabled={busy} onClick={() => onApply(stash.ref)}>{t("git.apply")}</button>
                <button className="modal-button primary" type="button" disabled={busy} onClick={() => onPop(stash.ref)}>{t("git.pop")}</button>
                <button className="modal-button danger" type="button" disabled={busy} onClick={() => onDrop(stash)}>{t("git.drop")}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function statusLabel(status: string, t: ReturnType<typeof useI18n>["t"]) {
  const keys: Record<string, "git.statusModified" | "git.statusAdded" | "git.statusDeleted" | "git.statusRenamed" | "git.statusCopied" | "git.statusConflict" | "git.statusTypeChanged" | "git.statusUntracked"> = {
    M: "git.statusModified",
    A: "git.statusAdded",
    D: "git.statusDeleted",
    R: "git.statusRenamed",
    C: "git.statusCopied",
    U: "git.statusConflict",
    T: "git.statusTypeChanged",
    "?": "git.statusUntracked"
  };
  return t(keys[status] || "git.statusModified");
}

function FileGroup({ title, files, scope, busy, onDiff, onPrimary, onDiscard, primaryLabel, allLabel, onAll }: {
  title: string;
  files: GitStatusEntry[];
  scope: "working" | "staged";
  busy: boolean;
  onDiff: (file: GitStatusEntry, scope: "working" | "staged") => void;
  onPrimary: (file: GitStatusEntry) => void;
  onDiscard?: (file: GitStatusEntry) => void;
  primaryLabel: string;
  allLabel: string;
  onAll: () => void;
}) {
  const { t } = useI18n();
  if (!files.length) return null;
  return (
    <section className="git-change-group">
      <div className="git-change-group-header">
        <strong>{title} <span>{files.length}</span></strong>
        <button type="button" disabled={busy} onClick={onAll}>{allLabel}</button>
      </div>
      {files.map((file) => {
        const code = scope === "staged" ? file.indexStatus : file.indexStatus === "?" ? "?" : file.worktreeStatus;
        const fileTitle = formatFilePath(file);
        return (
          <div className="git-status-row" key={`${scope}:${file.path}:${file.oldPath || ""}`}>
            <button className="git-status-file-btn" type="button" title={t("git.openDiff", { file: fileTitle })} onClick={() => onDiff(file, scope)}>
              <span className={`git-status-badge status-${statusClass(code)}`} title={statusLabel(code, t)}>{code}</span>
              <span className="git-status-path" title={fileTitle}>{fileTitle}</span>
            </button>
            <button className="git-status-inline-action" type="button" disabled={busy} title={primaryLabel} aria-label={primaryLabel} onClick={() => onPrimary(file)}>
              {scope === "staged" ? <Minus aria-hidden="true" /> : <Plus aria-hidden="true" />}
            </button>
            {onDiscard && (
              <button className="git-status-revert" type="button" disabled={busy} title={t("git.discardChanges", { file: fileTitle })} onClick={() => onDiscard(file)}>
                <RotateCcw aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function GitStatusPanel({ session, onSummaryChange }: GitStatusPanelProps) {
  const { locale, t } = useI18n();
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [view, setView] = useState<"changes" | "history">("changes");
  const [historyState, setHistoryState] = useState<HistoryState>({ status: "idle", commits: [] });
  const [diffState, setDiffState] = useState<DiffState>({ status: "idle" });
  const [showStashes, setShowStashes] = useState(false);
  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [directoryInput, setDirectoryInput] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const [remoteSelection, setRemoteSelection] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [commitDraft, setCommitDraft] = useState<CommitDraft>({ subject: "", body: "" });
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });
  const requestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionId = session?.id;
  const currentGitCwd = session?.gitCwd || session?.cwd || "";
  const repositoryKey = sessionId ? `${sessionId}:${currentGitCwd}` : "";
  const repositoryKeyRef = useRef(repositoryKey);
  repositoryKeyRef.current = repositoryKey;
  const snapshot = loadState.status === "ready" ? loadState.snapshot : undefined;
  const busy = operation.status === "running" || loadState.status === "loading";

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => {
    mountedRef.current = true;
    setLoadState({ status: "loading" });
    setHistoryState({ status: "idle", commits: [] });
    setDiffState({ status: "idle" });
    setDirectoryInput(currentGitCwd);
    setDirectoryError("");
    setOperation(repositoryOperations.get(repositoryKey) || { status: "idle" });
    setCommitDraft(commitDrafts.get(repositoryKey) || { subject: "", body: "" });
  }, [currentGitCwd, repositoryKey, sessionId]);

  const updateDraft = useCallback((next: CommitDraft) => {
    setCommitDraft(next);
    if (repositoryKey) commitDrafts.set(repositoryKey, next);
  }, [repositoryKey]);

  const applySnapshot = useCallback((nextSnapshot: GitRepositorySnapshot) => {
    setLoadState({ status: "ready", snapshot: nextSnapshot });
    const conflicts = nextSnapshot.status.files.filter((file) => file.conflicted).length;
    onSummaryChange?.({ changes: nextSnapshot.status.files.length, conflicts });
    const branchRemote = nextSnapshot.status.branch.upstream?.remote;
    const remotes = nextSnapshot.remotes.remotes;
    setRemoteSelection((current) => {
      if (branchRemote && remotes.includes(branchRemote)) return branchRemote;
      if (current && remotes.includes(current)) return current;
      if (remotes.includes("origin")) return "origin";
      return remotes[0] || "";
    });
  }, [onSummaryChange]);

  const loadSnapshot = useCallback(async (quiet = false) => {
    if (!sessionId) {
      setLoadState({ status: "idle" });
      onSummaryChange?.({ changes: 0, conflicts: 0 });
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!quiet) setLoadState((current) => current.status === "ready" ? current : { status: "loading" });
    try {
      const nextSnapshot = await window.gitApi.getSnapshot(sessionId);
      if (requestRef.current === requestId && mountedRef.current) applySnapshot(nextSnapshot);
    } catch (error) {
      if (requestRef.current === requestId && mountedRef.current) setLoadState({ status: "error", message: getErrorMessage(error) });
    }
  }, [applySnapshot, onSummaryChange, sessionId]);

  useEffect(() => {
    void loadSnapshot();
    return () => { requestRef.current += 1; };
  }, [loadSnapshot]);

  useEffect(() => {
    if (!sessionId || view !== "changes") return;
    let stopped = false;
    let timer = 0;
    let delay = session?.type === "ssh" ? 5000 : 3000;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible" || !document.hasFocus() || operation.status === "running") {
        timer = window.setTimeout(tick, delay);
        return;
      }
      try {
        const status = await window.gitApi.getStatus(sessionId);
        if (stopped) return;
        const currentStatus = loadState.status === "ready" ? loadState.snapshot.status : undefined;
        const signature = (value?: GitStatusResult) => JSON.stringify(value ? [value.branch, value.files] : null);
        if (signature(status) !== signature(currentStatus)) await loadSnapshot(true);
        delay = session?.type === "ssh" ? 5000 : 3000;
      } catch {
        delay = Math.min(delay * 2, 30000);
      }
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, delay);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [loadSnapshot, loadState, operation.status, session?.type, sessionId, view]);

  const loadDiff = useCallback(async (request: GitDiffRequest, title: string) => {
    if (!sessionId) return;
    const requestId = diffRequestRef.current + 1;
    diffRequestRef.current = requestId;
    setDiffState({ status: "loading", request, title });
    try {
      const result = await window.gitApi.getDiff(sessionId, request);
      if (diffRequestRef.current === requestId) setDiffState({ status: "ready", request, title, result });
    } catch (error) {
      if (diffRequestRef.current === requestId) setDiffState({ status: "error", request, title, message: getErrorMessage(error) });
    }
  }, [sessionId]);

  const loadHistory = useCallback(async (append = false) => {
    if (!sessionId) return;
    const current = historyState.commits;
    setHistoryState({ status: "loading", commits: append ? current : [] });
    try {
      const result = await window.gitApi.getHistory(sessionId, { skip: append ? current.length : 0 });
      setHistoryState({ status: "ready", commits: append ? [...current, ...result.commits] : result.commits, hasMore: result.hasMore, nextSkip: result.nextSkip });
    } catch (error) {
      setHistoryState({ status: "error", commits: current, message: getErrorMessage(error) });
    }
  }, [historyState.commits, sessionId]);

  useEffect(() => {
    if (view === "history" && historyState.status === "idle") void loadHistory(false);
  }, [historyState.status, loadHistory, view]);

  const runOperation = useCallback(async (label: string, action: (operationId: string) => Promise<GitOperationResult>) => {
    if (!sessionId || !repositoryKey) return false;
    const operationId = createOperationId();
    const capturedKey = repositoryKey;
    const running: OperationState = { status: "running", id: operationId, label };
    repositoryOperations.set(capturedKey, running);
    setOperation(running);
    setDetailsOpen(false);
    try {
      const result = await action(operationId);
      const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const next: OperationState = result.ok
        ? { status: "success", label, message: result.message || t("git.operationSucceeded"), details }
        : { status: "error", label, message: result.message || t("git.operationFailed"), details, canceled: result.canceled };
      repositoryOperations.set(capturedKey, next);
      if (mountedRef.current && capturedKey === repositoryKeyRef.current) setOperation(next);
      return result.ok;
    } catch (error) {
      const next: OperationState = { status: "error", label, message: getErrorMessage(error), details: "" };
      repositoryOperations.set(capturedKey, next);
      if (mountedRef.current && capturedKey === repositoryKeyRef.current) setOperation(next);
      return false;
    } finally {
      if (mountedRef.current && capturedKey === repositoryKeyRef.current) {
        await loadSnapshot(true);
        if (view === "history") await loadHistory(false);
      }
    }
  }, [loadHistory, loadSnapshot, repositoryKey, sessionId, t, view]);

  const changeDirectory = useCallback(async (value: string) => {
    if (!sessionId) return;
    const next = value.trim();
    if (!next) return;
    setDirectoryError("");
    try {
      const result = await window.gitApi.changeDirectory(sessionId, next);
      setDirectoryInput(result.cwd);
      applySnapshot(result.snapshot);
    } catch (error) {
      setDirectoryError(getErrorMessage(error));
    }
  }, [applySnapshot, sessionId]);

  const discoverRepository = useCallback(async () => {
    if (!sessionId) return;
    setDirectoryError("");
    try {
      const result = await window.gitApi.discoverRepository(sessionId);
      setDirectoryInput(result.cwd);
      await changeDirectory(result.cwd);
    } catch (error) {
      setDirectoryError(getErrorMessage(error));
    }
  }, [changeDirectory, sessionId]);

  const browseDirectory = useCallback(async () => {
    if (!sessionId || session?.type !== "windows") return;
    const result = await window.gitApi.chooseDirectory(sessionId, directoryInput || currentGitCwd);
    if (!result.canceled) {
      setDirectoryInput(result.path);
      await changeDirectory(result.path);
    }
  }, [changeDirectory, currentGitCwd, directoryInput, session?.type, sessionId]);

  const openFileDiff = (file: GitStatusEntry, scope: "working" | "staged") => {
    void loadDiff({ scope, path: file.path, oldPath: file.oldPath, status: file.status, indexStatus: file.indexStatus, worktreeStatus: file.worktreeStatus }, formatFilePath(file));
  };

  if (!sessionId || !session) {
    return <aside className="git-status-panel"><div className="git-status-header"><div><h2>Git</h2><span>{t("git.noSession")}</span></div></div><div className="git-status-empty">{t("git.availableAfterSession")}</div></aside>;
  }

  const status = snapshot?.status;
  const conflicts = status?.files.filter((file) => file.conflicted) || [];
  const staged = status?.files.filter(isIndexChanged) || [];
  const working = status?.files.filter(isWorktreeChanged) || [];
  const branch = status?.branch;
  const currentBranch = snapshot?.branches.branches.find((item) => item.current);
  const remotes = snapshot?.remotes.remotes || [];
  const hasStaged = staged.length > 0;
  const operationBlocked = Boolean(snapshot?.operationState);
  const directoryOptions = [...new Set([currentGitCwd, ...(session.gitCwdHistory || []), session.cwd].filter(Boolean))];

  return (
    <>
      <aside className="git-status-panel">
        <div className="git-status-header">
          <div>
            <h2>Git</h2>
            <span title={currentGitCwd}>{currentGitCwd}</span>
          </div>
          <button className="icon-button" type="button" title={t("git.refreshStatus")} disabled={busy} onClick={() => void loadSnapshot()}><RefreshCw aria-hidden="true" /></button>
        </div>

        <div className="git-subtabs" role="tablist">
          <button className={view === "changes" ? "active" : ""} type="button" role="tab" aria-selected={view === "changes"} onClick={() => setView("changes")}><GitCommit aria-hidden="true" />{t("git.changesTab")}</button>
          <button className={view === "history" ? "active" : ""} type="button" role="tab" aria-selected={view === "history"} onClick={() => setView("history")}><HistoryIcon aria-hidden="true" />{t("git.historyTab")}</button>
        </div>

        <div className="git-directory-control">
          <input list={`git-directories-${sessionId}`} value={directoryInput} title={directoryInput} placeholder={t("git.directoryPlaceholder")} disabled={busy} onChange={(event) => setDirectoryInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void changeDirectory(directoryInput); }} />
          <datalist id={`git-directories-${sessionId}`}>{directoryOptions.map((value) => <option value={value} key={value} />)}</datalist>
          <button className="icon-button" type="button" title={t("git.changeDirectory")} disabled={busy || !directoryInput.trim()} onClick={() => void changeDirectory(directoryInput)}><FolderInput aria-hidden="true" /></button>
          <button className="icon-button" type="button" title={t("git.discoverRepository")} disabled={busy} onClick={() => void discoverRepository()}><Search aria-hidden="true" /></button>
          {session.type === "windows" && <button className="icon-button" type="button" title={t("git.browseDirectory")} disabled={busy} onClick={() => void browseDirectory()}><ChevronDown aria-hidden="true" /></button>}
        </div>
        {directoryError && <div className="git-status-error"><span>{directoryError}</span><button type="button" onClick={() => setDirectoryError("")}>{t("git.dismiss")}</button></div>}

        {operation.status !== "idle" && (
          <div className={`git-operation-banner ${operation.status}`}>
            <div><strong>{operation.label}</strong>{operation.status === "running" ? <span>{t("git.operationRunning", { label: operation.label })}</span> : <span>{operation.message}</span>}</div>
            <div className="git-operation-actions">
              {operation.status === "running" ? <button type="button" onClick={() => void window.gitApi.cancelOperation(operation.id)}>{t("git.cancelOperation")}</button> : (
                <>
                  {(operation.details || operation.message) && <button type="button" onClick={() => setDetailsOpen((open) => !open)}>{t("git.details")}</button>}
                  <button type="button" onClick={() => { repositoryOperations.set(repositoryKey, { status: "idle" }); setOperation({ status: "idle" }); }}>{t("git.dismiss")}</button>
                </>
              )}
            </div>
            {detailsOpen && operation.status !== "running" && <pre>{operation.details || operation.message}</pre>}
          </div>
        )}

        {snapshot?.operationState && <div className="git-sequencer-warning"><strong>{t("git.operationState", { state: snapshot.operationState })}</strong><span>{t("git.operationStateGuidance")}</span></div>}

        {loadState.status === "loading" ? <div className="git-status-empty">{t("git.loadingStatus")}</div> : loadState.status === "error" ? (
          <div className="git-status-error"><span>{loadState.message}</span><button type="button" onClick={() => void loadSnapshot()}>{t("common.retry")}</button></div>
        ) : snapshot && view === "changes" ? (
          <div className="git-changes-view">
            <div className="git-branch-sync">
              <div className="git-branch-select">
                <GitBranch aria-hidden="true" />
                <SearchableSelect
                  value={currentBranch ? branchKey(currentBranch) : ""}
                  options={snapshot.branches.branches.map((item) => ({ value: branchKey(item), label: `${item.current ? "* " : ""}${item.name}${item.kind === "remote" ? t("git.remoteBranch") : ""}`, searchText: item.name }))}
                  disabled={busy || operationBlocked}
                  ariaLabel={t("git.checkoutBranch")}
                  placeholder={branch?.detached ? t("git.detachedHead") : t("git.checkoutBranch")}
                  menuMinWidth={280}
                  onChange={(value) => {
                    const target = snapshot.branches.branches.find((item) => branchKey(item) === value);
                    if (target && !target.current) void runOperation(t("git.checkoutBranch"), (id) => window.gitApi.checkoutBranch(sessionId, target, id));
                  }}
                />
              </div>
              <button className="git-compact-button" type="button" title={t("git.createBranch")} disabled={busy || operationBlocked} onClick={() => setShowCreateBranch((show) => !show)}><Plus aria-hidden="true" /></button>
            </div>
            {showCreateBranch && (
              <div className="git-create-branch">
                <input value={branchName} placeholder={t("git.branchName")} disabled={busy} onChange={(event) => setBranchName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && branchName.trim()) { void runOperation(t("git.createBranch"), (id) => window.gitApi.createBranch(sessionId, branchName.trim(), id)); setBranchName(""); setShowCreateBranch(false); } }} />
                <button type="button" disabled={busy || !branchName.trim()} onClick={() => { void runOperation(t("git.createBranch"), (id) => window.gitApi.createBranch(sessionId, branchName.trim(), id)); setBranchName(""); setShowCreateBranch(false); }}>{t("git.createAndCheckout")}</button>
              </div>
            )}

            <div className="git-sync-summary">
              <span>{branch?.detached ? t("git.detachedHead") : branch?.unborn ? t("git.unbornBranch") : branch?.name || t("git.noBranch")}</span>
              {branch?.upstream ? <span title={branch.upstream.name}>↑{branch.ahead} ↓{branch.behind}</span> : <span>{t("git.noUpstream")}</span>}
            </div>
            <div className="git-sync-actions">
              <select value={remoteSelection} aria-label={t("git.selectRemote")} disabled={busy || operationBlocked || remotes.length === 0} onChange={(event) => setRemoteSelection(event.target.value)}>
                {remotes.length === 0 ? <option value="">{t("git.noRemotes")}</option> : remotes.map((remote) => <option value={remote} key={remote}>{remote}</option>)}
              </select>
              <button type="button" disabled={busy || operationBlocked || !remoteSelection} onClick={() => void runOperation(t("git.fetch"), (id) => window.gitApi.fetch(sessionId, remoteSelection, id))}>{t("git.fetch")}</button>
              <button type="button" disabled={busy || operationBlocked || branch?.detached || !branch?.upstream} onClick={() => void runOperation(t("git.pull"), (id) => window.gitApi.pull(sessionId, id))}>{t("git.pull")}</button>
              <button type="button" disabled={busy || operationBlocked || branch?.detached || branch?.unborn || (!branch?.upstream && !remoteSelection)} onClick={() => void runOperation(t("git.push"), (id) => window.gitApi.push(sessionId, branch?.upstream ? undefined : remoteSelection, id))}><Send aria-hidden="true" />{t("git.push")}</button>
            </div>

            <div className="git-commit-editor">
              <input value={commitDraft.subject} placeholder={t("git.commitSubject")} disabled={busy || operationBlocked} onChange={(event) => updateDraft({ ...commitDraft, subject: event.target.value })} onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter" && hasStaged && commitDraft.subject.trim()) void runOperation(t("git.commitChanges"), (id) => window.gitApi.commit(sessionId, commitDraft, id)).then((success) => { if (success) updateDraft({ subject: "", body: "" }); }); }} />
              <textarea value={commitDraft.body} placeholder={t("git.commitBody")} disabled={busy || operationBlocked} rows={3} onChange={(event) => updateDraft({ ...commitDraft, body: event.target.value })} onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter" && hasStaged && commitDraft.subject.trim()) { event.preventDefault(); void runOperation(t("git.commitChanges"), (id) => window.gitApi.commit(sessionId, commitDraft, id)).then((success) => { if (success) updateDraft({ subject: "", body: "" }); }); } }} />
              <div><span>{commitDraft.subject.length}{commitDraft.body ? ` + ${commitDraft.body.length}` : ""}</span><button className="git-primary-button" type="button" disabled={busy || operationBlocked || !hasStaged || !commitDraft.subject.trim()} onClick={() => void runOperation(t("git.commitChanges"), (id) => window.gitApi.commit(sessionId, commitDraft, id)).then((success) => { if (success) updateDraft({ subject: "", body: "" }); })}><GitCommit aria-hidden="true" />{t("git.commitChanges")}</button></div>
            </div>

            <div className="git-status-actions">
              <button className="git-action-button" type="button" disabled={busy} onClick={() => setShowStashes(true)}><Archive aria-hidden="true" />{t("git.stashes", { count: snapshot.stashes.stashes.length })}</button>
            </div>

            <div className="git-status-list">
              {conflicts.length > 0 && (
                <section className="git-change-group conflicts">
                  <div className="git-change-group-header"><strong>{t("git.conflicts")} <span>{conflicts.length}</span></strong></div>
                  {conflicts.map((file) => (
                    <div className="git-status-row" key={`conflict:${file.path}`}>
                      <button className="git-status-file-btn" type="button" onClick={() => openFileDiff(file, "working")}><span className="git-status-badge status-u">U</span><span className="git-status-path">{formatFilePath(file)}</span></button>
                      <button className="git-status-inline-action" type="button" disabled={busy} title={t("git.stageResolved")} onClick={() => void runOperation(t("git.stageResolved"), (id) => window.gitApi.stageFiles(sessionId, [file.path], id))}><Plus aria-hidden="true" /></button>
                    </div>
                  ))}
                </section>
              )}
              <FileGroup title={t("git.stagedChanges")} files={staged} scope="staged" busy={busy} onDiff={openFileDiff} onPrimary={(file) => void runOperation(t("git.unstage"), (id) => window.gitApi.unstageFiles(sessionId, [file.path], id))} primaryLabel={t("git.unstage")} allLabel={t("git.unstageAll")} onAll={() => void runOperation(t("git.unstageAll"), (id) => window.gitApi.unstageAll(sessionId, id))} />
              <FileGroup title={t("git.workingChanges")} files={working} scope="working" busy={busy} onDiff={openFileDiff} onPrimary={(file) => void runOperation(t("git.stage"), (id) => window.gitApi.stageFiles(sessionId, [file.path], id))} onDiscard={(file) => setConfirmState({ title: t("git.discardTitle"), message: file.status === "?" ? t("git.deleteUntrackedConfirm", { file: formatFilePath(file) }) : t("git.discardWorkingConfirm", { file: formatFilePath(file) }), confirmLabel: t("git.discard"), onConfirm: () => void runOperation(t("git.discard"), (id) => window.gitApi.discardWorkingTree(sessionId, file, id)) })} primaryLabel={t("git.stage")} allLabel={t("git.stageAll")} onAll={() => void runOperation(t("git.stageAll"), (id) => window.gitApi.stageAll(sessionId, id))} />
              {status?.clean && <div className="git-status-empty"><GitBranch aria-hidden="true" /><span>{t("git.clean")}</span></div>}
            </div>
          </div>
        ) : snapshot && view === "history" ? (
          <div className="git-history-view">
            <div className="git-history-header"><strong>{t("git.recentCommits")}</strong><button className="icon-button" type="button" disabled={historyState.status === "loading"} onClick={() => void loadHistory(false)}><RefreshCw aria-hidden="true" /></button></div>
            {historyState.status === "loading" && historyState.commits.length === 0 ? <div className="git-status-empty">{t("git.loadingHistory")}</div> : historyState.status === "error" && historyState.commits.length === 0 ? <div className="git-status-error"><span>{historyState.message}</span><button type="button" onClick={() => void loadHistory(false)}>{t("common.retry")}</button></div> : historyState.commits.length === 0 ? <div className="git-status-empty">{t("git.noHistory")}</div> : (
              <>
                <div className="git-history-list">{historyState.commits.map((entry) => (
                  <button className="git-history-row" type="button" title={entry.oid} key={entry.oid} onClick={() => void loadDiff({ scope: "commit", revision: entry.oid }, `${entry.shortOid} ${entry.subject}`)}>
                    <div><strong>{entry.subject}</strong>{entry.decorations.length > 0 && <span className="git-history-decorations">{entry.decorations.join(" · ")}</span>}</div>
                    <small><code>{entry.shortOid}</code> · {entry.authorName} · {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(entry.authoredAt)}</small>
                  </button>
                ))}</div>
                {historyState.status === "ready" && historyState.hasMore && <button className="git-load-more" type="button" onClick={() => void loadHistory(true)}>{t("git.loadMore")}</button>}
              </>
            )}
          </div>
        ) : null}
      </aside>

      {diffState.status !== "idle" && <GitDiffDialog state={diffState} onRetry={(request, title) => void loadDiff(request, title)} onClose={() => { diffRequestRef.current += 1; setDiffState({ status: "idle" }); }} />}
      {showStashes && snapshot && <StashDialog stashes={snapshot.stashes.stashes} busy={busy} onCreate={(message) => void runOperation(t("git.createStash"), (id) => window.gitApi.stashChanges(sessionId, message, id))} onPreview={(stash) => void loadDiff({ scope: "stash", revision: stash.ref }, `${stash.ref} ${stash.message}`)} onApply={(ref) => void runOperation(t("git.apply"), (id) => window.gitApi.applyStash(sessionId, ref, id))} onPop={(ref) => void runOperation(t("git.pop"), (id) => window.gitApi.popStash(sessionId, ref, id))} onDrop={(stash) => setConfirmState({ title: t("git.dropStashTitle"), message: t("git.dropStashConfirm", { stash: stash.ref }), confirmLabel: t("git.drop"), onConfirm: () => void runOperation(t("git.drop"), (id) => window.gitApi.dropStash(sessionId, stash.ref, id)) })} onClose={() => setShowStashes(false)} />}
      {confirmState && <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} />}
    </>
  );
}
