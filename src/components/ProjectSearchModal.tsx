import { useEffect, useMemo, useRef, useState } from "react";
import { File, FileText, Search, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { ProjectFileSearchResult, ProjectTextSearchResponse, ProjectTextSearchResult, TerminalSession } from "../vite-env";

type ProjectSearchMode = "files" | "text";

type ProjectSearchModalProps = {
  mode: ProjectSearchMode;
  session: TerminalSession;
  onClose: () => void;
  onOpenPath: (path: string) => void;
};

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; root: string; fileResults: ProjectFileSearchResult[]; textResults: ProjectTextSearchResult[]; textEngine?: "ripgrep" | "fallback" }
  | { status: "error"; message: string };

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function HighlightText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return <>{text}</>;
  }
  const index = text.toLowerCase().indexOf(normalizedQuery);
  if (index === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + normalizedQuery.length)}</mark>
      {text.slice(index + normalizedQuery.length)}
    </>
  );
}

function HighlightLine({ result }: { result: ProjectTextSearchResult }) {
  const before = result.line.slice(0, result.matchStart);
  const match = result.line.slice(result.matchStart, result.matchStart + result.matchLength);
  const after = result.line.slice(result.matchStart + result.matchLength);
  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

export function ProjectSearchModal({ mode, session, onClose, onOpenPath }: ProjectSearchModalProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const modalRequestPrefixRef = useRef(`project-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const title = mode === "files" ? t("projectSearch.filesTitle") : t("projectSearch.textTitle");
  const placeholder = mode === "files" ? t("projectSearch.filesPlaceholder") : t("projectSearch.textPlaceholder");
  const resultsCount = useMemo(() => {
    if (searchState.status !== "ready") return 0;
    return mode === "files" ? searchState.fileResults.length : searchState.textResults.length;
  }, [mode, searchState]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

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
      const runSearch = mode === "files"
        ? window.projectSearchApi.searchFiles(session.id, trimmedQuery)
        : window.projectSearchApi.searchText(session.id, trimmedQuery, ipcRequestId);

      runSearch
        .then((response) => {
          if (requestRef.current !== requestId) return;
          setSearchState({
            status: "ready",
            root: response.root,
            fileResults: mode === "files" ? response.results as ProjectFileSearchResult[] : [],
            textResults: mode === "text" ? response.results as ProjectTextSearchResult[] : [],
            textEngine: mode === "text" ? (response as ProjectTextSearchResponse).engine : undefined
          });
        })
        .catch((error) => {
          if (requestRef.current !== requestId) return;
          setSearchState({ status: "error", message: getErrorMessage(error) });
        });
    }, 180);

    return () => {
      window.clearTimeout(timeout);
      if (mode === "text") {
        void window.projectSearchApi.cancelTextSearch(session.id, ipcRequestId);
      }
    };
  }, [mode, query, session.id]);

  const handleOpen = (path: string) => {
    onOpenPath(path);
    onClose();
  };

  return (
    <div className="project-search-overlay" onClick={onClose}>
      <div className="project-search-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="project-search-header">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={placeholder}
            aria-label={title}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" title={t("projectSearch.close")} aria-label={t("projectSearch.close")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="project-search-meta">
          <span>{title}</span>
          <span>{session.title}</span>
          {searchState.status === "ready" && <span>{t("projectSearch.results", { count: resultsCount })}</span>}
          {searchState.status === "ready" && searchState.textEngine === "fallback" && <span>{t("projectSearch.fallbackEngine")}</span>}
        </div>
        <div className="project-search-results">
          {searchState.status === "idle" ? (
            <div className="project-search-empty">{mode === "files" ? t("projectSearch.idleFiles") : t("projectSearch.idleText")}</div>
          ) : searchState.status === "loading" ? (
            <div className="project-search-empty">{t("projectSearch.searching")}</div>
          ) : searchState.status === "error" ? (
            <div className="project-search-error">{searchState.message}</div>
          ) : mode === "files" ? (
            searchState.fileResults.length === 0 ? (
              <div className="project-search-empty">{t("projectSearch.noFiles")}</div>
            ) : (
              searchState.fileResults.map((result) => (
                <button className="project-search-row" type="button" key={result.path} onClick={() => handleOpen(result.path)}>
                  <File aria-hidden="true" />
                  <span className="project-search-primary"><HighlightText text={result.name} query={query} /></span>
                  <span className="project-search-path"><HighlightText text={result.relativePath} query={query} /></span>
                </button>
              ))
            )
          ) : searchState.textResults.length === 0 ? (
            <div className="project-search-empty">{t("projectSearch.noText")}</div>
          ) : (
            searchState.textResults.map((result) => (
              <button className="project-search-row text" type="button" key={`${result.path}:${result.lineNumber}:${result.line}`} onClick={() => handleOpen(result.path)}>
                <FileText aria-hidden="true" />
                <span className="project-search-primary">
                  {result.relativePath}
                  <span className="project-search-line-number">:{result.lineNumber}</span>
                </span>
                <span className="project-search-line"><HighlightLine result={result} /></span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
