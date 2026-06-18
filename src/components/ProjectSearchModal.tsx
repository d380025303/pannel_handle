import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { File, FileText, Folder, Search, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { ProjectFileSearchResult, ProjectTextSearchResponse, ProjectTextSearchResult, TerminalSession } from "../vite-env";

export type ProjectSearchMode = "files" | "text";

type ProjectSearchModalProps = {
  mode: ProjectSearchMode;
  initialRoot: string;
  session: TerminalSession;
  onClose: () => void;
  onOpenPath: (path: string) => void;
};

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; root: string; fileResults: ProjectFileSearchResult[]; textResults: ProjectTextSearchResult[]; textEngine?: "ripgrep" | "fallback" }
  | { status: "error"; message: string };

type DirectoryState =
  | { status: "loading" }
  | { status: "ready"; workspaceRoot: string; path: string; directories: Array<{ name: string; path: string }> }
  | { status: "error"; message: string };

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function parentPath(value: string) {
  const separator = value.includes("\\") ? "\\" : "/";
  const normalized = value.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index < 0) return ".";
  if (index === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}${separator}`;
  return index === 0 ? separator : normalized.slice(0, index);
}

function samePath(left: string, right: string) {
  return left.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()
    === right.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function HighlightText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim().toLowerCase();
  const index = normalizedQuery ? text.toLowerCase().indexOf(normalizedQuery) : -1;
  if (index === -1) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + normalizedQuery.length)}</mark>{text.slice(index + normalizedQuery.length)}</>;
}

function HighlightLine({ result }: { result: ProjectTextSearchResult }) {
  return <>{result.line.slice(0, result.matchStart)}<mark>{result.line.slice(result.matchStart, result.matchStart + result.matchLength)}</mark>{result.line.slice(result.matchStart + result.matchLength)}</>;
}

export function ProjectSearchModal({ mode, initialRoot, session, onClose, onOpenPath }: ProjectSearchModalProps) {
  const { t } = useI18n();
  const [activeMode, setActiveMode] = useState<ProjectSearchMode>(mode);
  const [query, setQuery] = useState("");
  const [rootPath, setRootPath] = useState(initialRoot || ".");
  const [rootInput, setRootInput] = useState(initialRoot || ".");
  const [directoryState, setDirectoryState] = useState<DirectoryState>({ status: "loading" });
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const directoryRequestRef = useRef(0);
  const requestRef = useRef(0);
  const modalRequestPrefixRef = useRef(`project-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const title = activeMode === "files" ? t("projectSearch.filesTitle") : t("projectSearch.textTitle");
  const placeholder = activeMode === "files" ? t("projectSearch.filesPlaceholder") : t("projectSearch.textPlaceholder");
  const resultsCount = useMemo(() => searchState.status === "ready"
    ? activeMode === "files" ? searchState.fileResults.length : searchState.textResults.length
    : 0, [activeMode, searchState]);

  const loadDirectories = useCallback((nextPath: string) => {
    const requestId = directoryRequestRef.current + 1;
    directoryRequestRef.current = requestId;
    setDirectoryState({ status: "loading" });
    window.projectSearchApi.listDirectories(session.id, nextPath)
      .then((response) => {
        if (directoryRequestRef.current !== requestId) return;
        setRootPath(response.path);
        setRootInput(response.path);
        setDirectoryState({ status: "ready", ...response });
      })
      .catch((error) => {
        if (directoryRequestRef.current !== requestId) return;
        setDirectoryState({ status: "error", message: getErrorMessage(error) });
      });
  }, [session.id]);

  useEffect(() => {
    loadDirectories(initialRoot || ".");
    inputRef.current?.focus();
  }, [initialRoot, loadDirectories]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const ipcRequestId = `${modalRequestPrefixRef.current}-${requestId}`;
    if (!trimmedQuery) {
      setSearchState({ status: "idle" });
      return undefined;
    }

    setSearchState({ status: "loading" });
    const timeout = window.setTimeout(() => {
      const runSearch = activeMode === "files"
        ? window.projectSearchApi.searchFiles(session.id, trimmedQuery, rootPath)
        : window.projectSearchApi.searchText(session.id, trimmedQuery, ipcRequestId, rootPath);
      runSearch.then((response) => {
        if (requestRef.current !== requestId) return;
        setSearchState({
          status: "ready",
          root: response.root,
          fileResults: activeMode === "files" ? response.results as ProjectFileSearchResult[] : [],
          textResults: activeMode === "text" ? response.results as ProjectTextSearchResult[] : [],
          textEngine: activeMode === "text" ? (response as ProjectTextSearchResponse).engine : undefined
        });
      }).catch((error) => {
        if (requestRef.current !== requestId) return;
        setSearchState({ status: "error", message: getErrorMessage(error) });
      });
    }, 180);

    return () => {
      window.clearTimeout(timeout);
      if (activeMode === "text") void window.projectSearchApi.cancelTextSearch(session.id, ipcRequestId);
    };
  }, [activeMode, query, rootPath, session.id]);

  const handleOpen = (path: string) => {
    onOpenPath(path);
    onClose();
  };

  return (
    <div className="project-search-overlay" onClick={onClose}>
      <div className="project-search-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="project-search-toolbar">
          <div className="project-search-modes" role="group" aria-label={t("projectSearch.mode")}>
            <button className={activeMode === "files" ? "active" : ""} type="button" onClick={() => setActiveMode("files")}><File aria-hidden="true" />{t("projectSearch.filesMode")}</button>
            <button className={activeMode === "text" ? "active" : ""} type="button" onClick={() => setActiveMode("text")}><FileText aria-hidden="true" />{t("projectSearch.textMode")}</button>
          </div>
          <button className="project-search-close" type="button" title={t("projectSearch.close")} aria-label={t("projectSearch.close")} onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <form className="project-search-root" onSubmit={(event) => { event.preventDefault(); loadDirectories(rootInput.trim() || "."); }}>
          <Folder aria-hidden="true" />
          <input value={rootInput} aria-label={t("projectSearch.directory")} placeholder={t("projectSearch.directoryPlaceholder")} onChange={(event) => setRootInput(event.target.value)} />
          {directoryState.status === "ready" && (
            <select
              value={directoryState.path}
              aria-label={t("projectSearch.directory")}
              onChange={(event) => loadDirectories(event.target.value)}
            >
              <option value={directoryState.path}>{t("projectSearch.directory")}</option>
              {!samePath(directoryState.path, directoryState.workspaceRoot) && (
                <option value={parentPath(directoryState.path)}>.. {t("projectSearch.parentDirectory")}</option>
              )}
              {directoryState.directories.map((directory) => (
                <option value={directory.path} key={directory.path}>{directory.name}</option>
              ))}
            </select>
          )}
          <button type="submit">{t("projectSearch.go")}</button>
        </form>
        {directoryState.status === "loading" && <div className="project-search-directory-status">{t("projectSearch.loadingDirectories")}</div>}
        {directoryState.status === "error" && <div className="project-search-directory-error">{directoryState.message}</div>}
        <div className="project-search-header">
          <Search aria-hidden="true" />
          <input ref={inputRef} type="text" value={query} placeholder={placeholder} aria-label={title} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="project-search-meta">
          <span>{title}</span><span>{session.title}</span><span title={rootPath}>{rootPath}</span>
          {searchState.status === "ready" && <span>{t("projectSearch.results", { count: resultsCount })}</span>}
          {searchState.status === "ready" && searchState.textEngine === "fallback" && <span>{t("projectSearch.fallbackEngine")}</span>}
        </div>
        <div className="project-search-results">
          {searchState.status === "idle" ? <div className="project-search-empty">{activeMode === "files" ? t("projectSearch.idleFiles") : t("projectSearch.idleText")}</div>
            : searchState.status === "loading" ? <div className="project-search-empty">{t("projectSearch.searching")}</div>
              : searchState.status === "error" ? <div className="project-search-error">{searchState.message}</div>
                : activeMode === "files" ? searchState.fileResults.length === 0 ? <div className="project-search-empty">{t("projectSearch.noFiles")}</div>
                  : searchState.fileResults.map((result) => <button className="project-search-row" type="button" key={result.path} onClick={() => handleOpen(result.path)}><File aria-hidden="true" /><span className="project-search-primary"><HighlightText text={result.name} query={query} /></span><span className="project-search-path"><HighlightText text={result.relativePath} query={query} /></span></button>)
                  : searchState.textResults.length === 0 ? <div className="project-search-empty">{t("projectSearch.noText")}</div>
                    : searchState.textResults.map((result) => <button className="project-search-row text" type="button" key={`${result.path}:${result.lineNumber}:${result.line}`} onClick={() => handleOpen(result.path)}><FileText aria-hidden="true" /><span className="project-search-primary">{result.relativePath}<span className="project-search-line-number">:{result.lineNumber}</span></span><span className="project-search-line"><HighlightLine result={result} /></span></button>)}
        </div>
      </div>
    </div>
  );
}
