import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Download, Eye, File, FileText, Folder, FolderOpen, Image as ImageIcon, LoaderCircle, RefreshCw, Save, Search, SquarePen, Terminal as TerminalIcon, Trash2, Upload, Video, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { MarkdownBlock } from "../shared/MarkdownBlock";
import { flattenLoadedTree, isPathInside, parentTreePath, removeTreeBranch, sameTreePath, type DirectoryTreeState, type VisibleTreeNode } from "../../utils/remoteFileTree";
import type { RemoteFileDownloadProgress, RemoteFileEntry, RemoteFilePreview, TerminalSession } from "../../vite-env";

type RemoteFilePanelProps = {
  session?: TerminalSession;
  openRequest?: { sessionId: string; path: string; requestId: number } | null;
  closePreviewRequest?: { tabId: string; requestId: number } | null;
  previewHost?: HTMLElement | null;
  activePreviewTabId?: string | null;
  onOpenRequestHandled?: (requestId: number) => void;
  onClosePreviewRequestHandled?: (requestId: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPreviewActive?: (active: boolean) => void;
  onPreviewTabsChange?: (tabs: RemotePreviewTabSummary[]) => void;
  onActivePreviewTabChange?: (tabId: string | null, fromRestore?: boolean) => void;
  onCurrentPathChange?: (path: string) => void;
  onSearchRequest?: (mode: "files" | "text", rootPath: string) => void;
  onFocusTerminal?: () => void;
};

export type RemotePreviewTabSummary = {
  id: string;
  sessionId: string;
  path: string;
  fileName: string;
  dirty: boolean;
  status: "loading" | "ready" | "error";
};

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "ready"; sessionId: string; path: string; fileName: string; preview: RemoteFilePreview }
  | { status: "error"; path: string; message: string };

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

type FileContextMenuState = {
  entry: RemoteFileEntry;
  x: number;
  y: number;
} | null;

type TextMatch = {
  start: number;
  end: number;
};

type DownloadTransferState = {
  transferId: string;
  mode: "save" | "drag";
  entry: RemoteFileEntry;
  status: "selecting" | "running" | "completed" | "canceled" | "failed";
  transferredBytes: number;
  totalBytes: number;
  percent: number | null;
  error?: string;
};

type PreviewTabState = {
  id: string;
  sessionId: string;
  path: string;
  fileName: string;
  entry: RemoteFileEntry | null;
  state: Exclude<PreviewState, { status: "idle" }>;
  originalContent: string;
  editorContent: string;
  saveState: SaveState;
  viewMode: "edit" | "preview";
  previewSearchQuery: string;
  activePreviewMatch: number;
  previewRequestId: number;
  saveRequestId: number;
};

type RemoteFilePanelSessionState = {
  currentPath: string;
  pathInput: string;
  navigationRoot: string | null;
  treeRoot: RemoteFileEntry | null;
  directories: DirectoryTreeState;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  searchQuery: string;
  tabs: PreviewTabState[];
  activeTabId: string | null;
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

function baseName(remotePath: string) {
  const normalized = remotePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function getPreviewId(preview: RemoteFilePreview) {
  return preview.kind === "image" || preview.kind === "video" ? preview.previewId : null;
}

function getPreviewTabId(sessionId: string, remotePath: string) {
  return `${sessionId}:${remotePath}`;
}

function getPreviewIdFromTab(tab: PreviewTabState) {
  return tab.state.status === "ready" ? getPreviewId(tab.state.preview) : null;
}

function isPreviewTabDirty(tab: PreviewTabState) {
  return tab.state.status === "ready"
    && tab.state.preview.kind === "text"
    && tab.editorContent !== tab.originalContent;
}

function getPreviewTabSummaries(tabs: PreviewTabState[]): RemotePreviewTabSummary[] {
  return tabs.map((tab) => ({
    id: tab.id,
    sessionId: tab.sessionId,
    path: tab.path,
    fileName: tab.fileName,
    dirty: isPreviewTabDirty(tab),
    status: tab.state.status
  }));
}

function hasLocalFileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isMarkdownFile(fileName: string): boolean {
  return /\.(md|markdown|mdown|mdwn|mkd|mkdn)$/i.test(fileName);
}

function scrollTextareaMatchIntoView(textarea: HTMLTextAreaElement, start: number, end: number) {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const marker = document.createElement("span");

  Object.assign(mirror.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    width: `${textarea.clientWidth}px`,
    padding: style.padding,
    border: "0",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: style.wordBreak,
    font: style.font,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    tabSize: style.tabSize
  });

  mirror.append(document.createTextNode(textarea.value.slice(0, start)));
  marker.textContent = textarea.value.slice(start, end) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);

  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.45;
  const matchHeight = Math.max(marker.offsetHeight, lineHeight);
  textarea.scrollTop = Math.max(0, marker.offsetTop - (textarea.clientHeight - matchHeight) / 2);

  mirror.remove();
}

export function RemoteFilePanel({
  session,
  openRequest,
  closePreviewRequest,
  previewHost,
  activePreviewTabId,
  onOpenRequestHandled,
  onClosePreviewRequestHandled,
  onDirtyChange,
  onPreviewActive,
  onPreviewTabsChange,
  onActivePreviewTabChange,
  onCurrentPathChange,
  onSearchRequest,
  onFocusTerminal
}: RemoteFilePanelProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState(".");
  const [pathInput, setPathInput] = useState(".");
  const [navigationRoot, setNavigationRoot] = useState<string | null>(null);
  const [treeRoot, setTreeRoot] = useState<RemoteFileEntry | null>(null);
  const [directories, setDirectories] = useState<DirectoryTreeState>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewTabs, setPreviewTabs] = useState<PreviewTabState[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [downloadDragPath, setDownloadDragPath] = useState<string | null>(null);
  const [downloadTransfer, setDownloadTransfer] = useState<DownloadTransferState | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState>(null);
  const requestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const previewContentRef = useRef<HTMLTextAreaElement>(null);
  const previewHighlightRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  const handledOpenRequestRef = useRef(0);
  const handledClosePreviewRequestRef = useRef(0);
  const openRequestAttemptRef = useRef(0);
  const previewTabsRef = useRef<PreviewTabState[]>([]);
  const panelStateBySessionRef = useRef(new Map<string, RemoteFilePanelSessionState>());
  const activePreviewTabIdRef = useRef<string | null>(null);
  const currentPathRef = useRef(".");
  const pathInputRef = useRef(".");
  const selectedPathRef = useRef<string | null>(null);
  const treeRootRef = useRef<RemoteFileEntry | null>(null);
  const navigationRootRef = useRef<string | null>(null);
  const directoriesRef = useRef<DirectoryTreeState>({});
  const expandedPathsRef = useRef<Set<string>>(new Set());
  const searchQueryRef = useRef("");
  const directoryRequestRef = useRef(new Map<string, number>());
  const directoryRequestSequenceRef = useRef(0);
  const treeRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const downloadTransferRef = useRef<DownloadTransferState | null>(null);

  const sessionId = session?.id;
  downloadTransferRef.current = downloadTransfer;
  previewTabsRef.current = previewTabs;
  activePreviewTabIdRef.current = activePreviewTabId ?? null;
  currentPathRef.current = currentPath;
  pathInputRef.current = pathInput;
  expandedPathsRef.current = expandedPaths;
  searchQueryRef.current = searchQuery;

  useEffect(() => window.remoteFileApi.onDownloadProgress((progress: RemoteFileDownloadProgress) => {
    if (downloadTransferRef.current?.transferId !== progress.transferId) return;
    setDownloadTransfer((current) => current?.transferId === progress.transferId ? {
      ...current,
      status: progress.status,
      transferredBytes: progress.transferredBytes ?? current.transferredBytes,
      totalBytes: progress.totalBytes ?? current.totalBytes,
      percent: progress.percent ?? current.percent,
      error: progress.error
    } : current);
  }), []);

  useEffect(() => {
    const transfer = downloadTransfer;
    if (!transfer || !["completed", "canceled"].includes(transfer.status)) return;
    const timer = window.setTimeout(() => {
      setDownloadTransfer((current) => current?.transferId === transfer.transferId ? null : current);
    }, transfer.status === "completed" ? 1200 : 1800);
    return () => window.clearTimeout(timer);
  }, [downloadTransfer]);

  useEffect(() => () => {
    const transferId = downloadTransferRef.current?.transferId;
    if (transferId) void window.remoteFileApi.cancelDownload(transferId);
  }, [sessionId]);

  const selectedEntry = useMemo(() => {
    if (treeRoot?.path === selectedPath) return treeRoot;
    return Object.values(directories).flatMap((directory) => directory.entries)
      .find((entry) => entry.path === selectedPath);
  }, [directories, selectedPath, treeRoot]);
  const canOpenInExplorer = session?.type === "windows" || session?.type === "wsl";
  const contextEntry = fileContextMenu?.entry;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleTreeNodes = useMemo(
    () => flattenLoadedTree(treeRoot, directories, expandedPaths, normalizedSearchQuery),
    [directories, expandedPaths, normalizedSearchQuery, treeRoot]
  );
  const activePreviewTab = useMemo(() => (
    activePreviewTabId
      ? previewTabs.find((tab) => tab.id === activePreviewTabId) ?? null
      : null
  ), [activePreviewTabId, previewTabs]);
  const activePreview = activePreviewTab?.state ?? { status: "idle" as const };
  const editorContent = activePreviewTab?.editorContent ?? "";
  const originalContent = activePreviewTab?.originalContent ?? "";
  const saveState = activePreviewTab?.saveState ?? { status: "idle" as const };
  const viewMode = activePreviewTab?.viewMode ?? "edit";
  const previewSearchQuery = activePreviewTab?.previewSearchQuery ?? "";
  const activePreviewMatch = activePreviewTab?.activePreviewMatch ?? 0;
  const isDirty = activePreviewTab ? isPreviewTabDirty(activePreviewTab) : false;
  const anyPreviewDirty = previewTabs.some(isPreviewTabDirty);
  dirtyRef.current = anyPreviewDirty;
  useEffect(() => {
    onDirtyChange?.(anyPreviewDirty);
    return () => onDirtyChange?.(false);
  }, [anyPreviewDirty, onDirtyChange]);

  const isPreviewActive = Boolean(activePreviewTab);
  const hasTextPreview = activePreview.status === "ready" && activePreview.preview.kind === "text";
  useEffect(() => {
    onPreviewActive?.(previewTabs.length > 0);
    onPreviewTabsChange?.(getPreviewTabSummaries(previewTabs));
  }, [onPreviewActive, onPreviewTabsChange, previewTabs]);

  useEffect(() => () => {
    onPreviewActive?.(false);
    onPreviewTabsChange?.([]);
  }, [onPreviewActive, onPreviewTabsChange]);

  useEffect(() => () => {
    const releasedPreviewIds = new Set<string>();
    const releaseUniquePreview = (tab: PreviewTabState) => {
      const previewId = getPreviewIdFromTab(tab);
      if (!previewId || releasedPreviewIds.has(previewId)) {
        return;
      }
      releasedPreviewIds.add(previewId);
      void window.remoteFileApi.releasePreview(previewId);
    };

    previewTabsRef.current.forEach(releaseUniquePreview);
    panelStateBySessionRef.current.forEach((state) => {
      state.tabs.forEach(releaseUniquePreview);
    });
    panelStateBySessionRef.current.clear();
  }, []);

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

  const activeMatch = previewMatches[activePreviewMatch] ?? null;

  const updatePreviewTab = useCallback((tabId: string, updater: (tab: PreviewTabState) => PreviewTabState) => {
    setPreviewTabs((current) => current.map((tab) => tab.id === tabId ? updater(tab) : tab));
  }, []);

  const syncPreviewHighlight = useCallback(() => {
    const textarea = previewContentRef.current;
    const highlight = previewHighlightRef.current;
    if (!textarea || !highlight) {
      return;
    }
    highlight.style.width = `${textarea.clientWidth}px`;
    highlight.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  }, []);

  useEffect(() => {
    if (!activePreviewTab) return;
    if (!previewMatches.length) {
      updatePreviewTab(activePreviewTab.id, (tab) => ({ ...tab, activePreviewMatch: 0 }));
      return;
    }
    if (activePreviewMatch >= previewMatches.length) {
      updatePreviewTab(activePreviewTab.id, (tab) => ({ ...tab, activePreviewMatch: previewMatches.length - 1 }));
    }
  }, [activePreviewMatch, activePreviewTab, previewMatches.length, updatePreviewTab]);

  useEffect(() => {
    const textarea = previewContentRef.current;
    if (!activeMatch || !textarea) {
      syncPreviewHighlight();
      return;
    }
    scrollTextareaMatchIntoView(textarea, activeMatch.start, activeMatch.end);
    syncPreviewHighlight();
  }, [activeMatch, syncPreviewHighlight]);

  useEffect(() => {
    const textarea = previewContentRef.current;
    if (!textarea) {
      return;
    }
    syncPreviewHighlight();
    const observer = new ResizeObserver(syncPreviewHighlight);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [hasTextPreview, syncPreviewHighlight]);

  const confirmDiscard = useCallback(() => (
    !dirtyRef.current || window.confirm(t("confirm.discardUnsavedFileChanges"))
  ), [t]);

  const confirmDiscardTab = useCallback((tab: PreviewTabState) => (
    !isPreviewTabDirty(tab) || window.confirm(t("confirm.discardUnsavedFileChanges"))
  ), [t]);

  const releasePreviewForTab = useCallback((tab: PreviewTabState) => {
    const previewId = getPreviewIdFromTab(tab);
    if (previewId) {
      void window.remoteFileApi.releasePreview(previewId);
    }
  }, []);

  const closeFileContextMenu = useCallback(() => {
    setFileContextMenu(null);
  }, []);

  const handleFileContextMenu = useCallback((event: MouseEvent<HTMLElement>, entry: RemoteFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    selectedPathRef.current = entry.path;
    setSelectedPath(entry.path);

    const menuWidth = 176;
    const menuHeight = entry.type === "directory" ? 80 : 130;
    setFileContextMenu({
      entry,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    });
  }, []);

  useEffect(() => {
    if (!fileContextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".remote-file-context-menu")) {
        return;
      }
      setFileContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFileContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fileContextMenu]);

  const updateDirectories = useCallback((updater: (current: DirectoryTreeState) => DirectoryTreeState) => {
    const next = updater(directoriesRef.current);
    directoriesRef.current = next;
    setDirectories(next);
  }, []);

  const resetPanelState = useCallback((path = ".") => {
    requestRef.current += 1;
    previewRequestRef.current += 1;
    directoryRequestSequenceRef.current += 1;
    directoryRequestRef.current.clear();
    treeRowRefs.current.clear();
    navigationRootRef.current = null;
    treeRootRef.current = null;
    directoriesRef.current = {};
    selectedPathRef.current = null;
    currentPathRef.current = path;
    pathInputRef.current = path;
    expandedPathsRef.current = new Set();
    searchQueryRef.current = "";
    setNavigationRoot(null);
    setCurrentPath(path);
    setPathInput(path);
    onCurrentPathChange?.(path);
    setTreeRoot(null);
    setDirectories({});
    setExpandedPaths(new Set());
    setSelectedPath(null);
    setSearchQuery("");
    setDropTargetPath(null);
    setUploadingCount(0);
    setDownloadDragPath(null);
    closeFileContextMenu();
    setError(null);
  }, [closeFileContextMenu, onCurrentPathChange]);

  const createPanelStateSnapshot = useCallback((): RemoteFilePanelSessionState => ({
    currentPath: currentPathRef.current,
    pathInput: pathInputRef.current,
    navigationRoot: navigationRootRef.current,
    treeRoot: treeRootRef.current,
    directories: directoriesRef.current,
    expandedPaths: new Set(expandedPathsRef.current),
    selectedPath: selectedPathRef.current,
    searchQuery: searchQueryRef.current,
    tabs: previewTabsRef.current,
    activeTabId: activePreviewTabIdRef.current
  }), []);

  const restorePanelState = useCallback((state: RemoteFilePanelSessionState) => {
    treeRowRefs.current.clear();
    navigationRootRef.current = state.navigationRoot;
    treeRootRef.current = state.treeRoot;
    directoriesRef.current = state.directories;
    selectedPathRef.current = state.selectedPath;
    currentPathRef.current = state.currentPath;
    pathInputRef.current = state.pathInput;
    expandedPathsRef.current = new Set(state.expandedPaths);
    searchQueryRef.current = state.searchQuery;
    setNavigationRoot(state.navigationRoot);
    setCurrentPath(state.currentPath);
    setPathInput(state.pathInput);
    onCurrentPathChange?.(state.currentPath);
    setTreeRoot(state.treeRoot);
    setDirectories(state.directories);
    setExpandedPaths(new Set(state.expandedPaths));
    setSelectedPath(state.selectedPath);
    setSearchQuery(state.searchQuery);
    setDropTargetPath(null);
    setUploadingCount(0);
    setDownloadDragPath(null);
    closeFileContextMenu();
    setError(null);
    setLoading(false);
    setPreviewTabs(state.tabs);
    const restoredActiveTabId = state.activeTabId && state.tabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : state.tabs.at(-1)?.id ?? null;
    onActivePreviewTabChange?.(restoredActiveTabId, true);
  }, [closeFileContextMenu, onActivePreviewTabChange, onCurrentPathChange]);

  const loadTreeDirectory = useCallback(async (path: string) => {
    if (!sessionId) return undefined;
    const requestId = directoryRequestSequenceRef.current + 1;
    directoryRequestSequenceRef.current = requestId;
    directoryRequestRef.current.set(path, requestId);
    updateDirectories((current) => ({
      ...current,
      [path]: { status: "loading", entries: current[path]?.entries ?? [] }
    }));
    try {
      const nextEntries = await window.remoteFileApi.list(sessionId, path);
      if (directoryRequestRef.current.get(path) !== requestId) return undefined;
      updateDirectories((current) => ({
        ...current,
        [path]: { status: "ready", entries: nextEntries }
      }));
      return nextEntries;
    } catch (err) {
      if (directoryRequestRef.current.get(path) !== requestId) return undefined;
      updateDirectories((current) => ({
        ...current,
        [path]: { status: "error", entries: current[path]?.entries ?? [], error: getErrorMessage(err) }
      }));
      throw err;
    }
  }, [sessionId, updateDirectories]);

  const setRootDirectory = useCallback(async (path: string) => {
    const root: RemoteFileEntry = {
      name: baseName(path) || path,
      path,
      type: "directory",
      size: 0,
      modifiedAt: 0
    };
    directoryRequestSequenceRef.current += 1;
    directoryRequestRef.current.clear();
    treeRootRef.current = root;
    directoriesRef.current = {};
    setTreeRoot(root);
    setDirectories({});
    setExpandedPaths(new Set([path]));
    return loadTreeDirectory(path);
  }, [loadTreeDirectory]);

  const loadDirectory = useCallback(async (path: string, preserveSearch = false, skipConfirm = false) => {
    if (!sessionId) return undefined;
    const rootBoundary = navigationRootRef.current;
    if (!rootBoundary) return undefined;
    const targetPath = path === "." ? rootBoundary : path;
    if (!isPathInside(targetPath, rootBoundary)) {
      setError(t("files.outsideWorkingDirectory"));
      return undefined;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    closeFileContextMenu();
    selectedPathRef.current = null;
    setSelectedPath(null);
    setLoading(true);
    setError(null);
    try {
      const root = treeRootRef.current;
      let targetEntry: RemoteFileEntry | null = null;
      let targetEntries: RemoteFileEntry[] | undefined;
      if (root && isPathInside(targetPath, root.path)) {
        let current = root;
        const expanded = new Set<string>();
        while (!sameTreePath(current.path, targetPath)) {
          expanded.add(current.path);
          const children = directoriesRef.current[current.path]?.entries ?? await loadTreeDirectory(current.path);
          const next = children?.find((entry) => entry.type === "directory" && isPathInside(targetPath, entry.path));
          if (!next) throw new Error(`Directory not found: ${targetPath}`);
          current = next;
        }
        targetEntry = current;
        expanded.add(current.path);
        targetEntries = await loadTreeDirectory(current.path);
        setExpandedPaths((existing) => new Set([...existing, ...expanded]));
      } else {
        targetEntries = await setRootDirectory(targetPath);
        targetEntry = treeRootRef.current;
      }
      if (requestRef.current !== requestId || !targetEntry) return undefined;
      setCurrentPath(targetEntry.path);
      setPathInput(targetEntry.path);
      onCurrentPathChange?.(targetEntry.path);
      setSelectedPath(targetEntry.path);
      selectedPathRef.current = targetEntry.path;
      if (!preserveSearch) setSearchQuery("");
      return targetEntries;
    } catch (err) {
      if (requestRef.current === requestId) setError(getErrorMessage(err));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
    return undefined;
  }, [closeFileContextMenu, loadTreeDirectory, onCurrentPathChange, sessionId, setRootDirectory, t]);

  useEffect(() => {
    if (!sessionId) {
      resetPanelState(".");
      setPreviewTabs([]);
      onActivePreviewTabChange?.(null);
      setLoading(false);
      return;
    }
    const cachedPanelState = panelStateBySessionRef.current.get(sessionId);
    if (cachedPanelState) {
      restorePanelState(cachedPanelState);
      return () => {
        panelStateBySessionRef.current.set(sessionId, createPanelStateSnapshot());
        requestRef.current += 1;
        previewRequestRef.current += 1;
        directoryRequestSequenceRef.current += 1;
        directoryRequestRef.current.clear();
      };
    }

    resetPanelState(".");

    let disposed = false;
    const initialRequestId = requestRef.current;
    setLoading(true);
    window.remoteFileApi.getHome(sessionId)
      .then((home) => {
        if (!disposed && requestRef.current === initialRequestId) {
          const rootPath = home || ".";
          navigationRootRef.current = rootPath;
          setNavigationRoot(rootPath);
          setCurrentPath(rootPath);
          setPathInput(rootPath);
          onCurrentPathChange?.(rootPath);
          void loadDirectory(rootPath, false, true);
        }
      })
      .catch((err) => {
        if (!disposed) {
          setError(getErrorMessage(err));
          setLoading(false);
        }
      });

    return () => {
      if (navigationRootRef.current) {
        panelStateBySessionRef.current.set(sessionId, createPanelStateSnapshot());
      }
      disposed = true;
      requestRef.current += 1;
      previewRequestRef.current += 1;
      directoryRequestSequenceRef.current += 1;
      directoryRequestRef.current.clear();
    };
  }, [createPanelStateSnapshot, loadDirectory, onActivePreviewTabChange, resetPanelState, restorePanelState, sessionId]);

  const handleOpenEntry = useCallback(async (entry: RemoteFileEntry, force = false) => {
    if (!force && entry.type !== "directory" && entry.path === selectedPathRef.current) {
      return;
    }
    selectedPathRef.current = entry.path;
    setSelectedPath(entry.path);
    if (entry.type === "directory") {
      setCurrentPath(entry.path);
      setPathInput(entry.path);
      onCurrentPathChange?.(entry.path);
      const isExpanded = expandedPaths.has(entry.path);
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (isExpanded) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      if (!isExpanded && !directoriesRef.current[entry.path]) {
        try {
          await loadTreeDirectory(entry.path);
        } catch (err) {
          setError(getErrorMessage(err));
          return;
        }
      }

      if (!isExpanded) {
        let chainPath = entry.path;
        for (let i = 0; i < 10; i++) {
          const state = directoriesRef.current[chainPath];
          if (!state || state.status !== "ready") break;
          if (state.entries.length !== 1 || state.entries[0].type !== "directory") break;
          const child = state.entries[0];
          setExpandedPaths((current) => new Set([...current, child.path]));
          try {
            await loadTreeDirectory(child.path);
          } catch {
            break;
          }
          chainPath = child.path;
        }
      }
      return;
    }

    if (!sessionId) return;
    const tabId = getPreviewTabId(sessionId, entry.path);
    const existingTab = previewTabsRef.current.find((tab) => tab.id === tabId);
    if (existingTab) {
      onActivePreviewTabChange?.(tabId);
      if (existingTab.state.status === "ready" || existingTab.state.status === "error") {
        void handleReloadPreview(existingTab);
      }
      return;
    }
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    const loadingTab: PreviewTabState = {
      id: tabId,
      sessionId,
      path: entry.path,
      fileName: entry.name,
      entry,
      state: { status: "loading", path: entry.path },
      originalContent: "",
      editorContent: "",
      saveState: { status: "idle" },
      viewMode: isMarkdownFile(entry.name) ? "preview" : "edit",
      previewSearchQuery: "",
      activePreviewMatch: 0,
      previewRequestId: requestId,
      saveRequestId: 0
    };
    setPreviewTabs((current) => [...current, loadingTab]);
    onActivePreviewTabChange?.(tabId);
    try {
      const nextPreview = await window.remoteFileApi.previewFile(sessionId, entry.path);
      const currentTab = previewTabsRef.current.find((tab) => tab.id === tabId);
      if (!currentTab || currentTab.previewRequestId !== requestId) {
        const stalePreviewId = getPreviewId(nextPreview);
        if (stalePreviewId) {
          void window.remoteFileApi.releasePreview(stalePreviewId);
        }
        return;
      }
      updatePreviewTab(tabId, (tab) => ({
        ...tab,
        state: {
          status: "ready",
          sessionId,
          path: entry.path,
          fileName: entry.name,
          preview: nextPreview
        },
        originalContent: nextPreview.kind === "text" ? nextPreview.content : "",
        editorContent: nextPreview.kind === "text" ? nextPreview.content : "",
        viewMode: isMarkdownFile(entry.name) ? "preview" : "edit"
      }));
    } catch (err) {
      const currentTab = previewTabsRef.current.find((tab) => tab.id === tabId);
      if (!currentTab || currentTab.previewRequestId !== requestId) return;
      updatePreviewTab(tabId, (tab) => ({
        ...tab,
        state: {
          status: "error",
          path: entry.path,
          message: getErrorMessage(err)
        }
      }));
    }
  }, [expandedPaths, loadTreeDirectory, onActivePreviewTabChange, onCurrentPathChange, sessionId, updatePreviewTab]);

  useEffect(() => {
    if (!openRequest || !sessionId || openRequest.sessionId !== sessionId) {
      return;
    }
    if (handledOpenRequestRef.current === openRequest.requestId) {
      return;
    }
    handledOpenRequestRef.current = openRequest.requestId;
    const requestId = openRequest.requestId;
    const attemptId = openRequestAttemptRef.current + 1;
    openRequestAttemptRef.current = attemptId;
    let completed = false;

    const openPath = async () => {
      const targetDirectory = parentTreePath(openRequest.path);
      const nextEntries = await loadDirectory(targetDirectory, true, true);
      if (openRequestAttemptRef.current !== attemptId || !nextEntries) {
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
      if (openRequestAttemptRef.current === attemptId) {
        completed = true;
        onOpenRequestHandled?.(requestId);
      }
    };

    void openPath();
    return () => {
      if (openRequestAttemptRef.current === attemptId) {
        openRequestAttemptRef.current += 1;
      }
      if (!completed && handledOpenRequestRef.current === requestId) {
        handledOpenRequestRef.current = 0;
      }
    };
  }, [handleOpenEntry, loadDirectory, navigationRoot, onOpenRequestHandled, openRequest, sessionId]);

  const findCachedParentPath = useCallback((entryPath: string) => (
    Object.entries(directoriesRef.current).find(([, directory]) => (
      directory.entries.some((entry) => entry.path === entryPath)
    ))?.[0] ?? parentTreePath(entryPath)
  ), []);

  const refreshDirectory = useCallback(async (path: string, collapseDescendants = false) => {
    if (collapseDescendants) {
      updateDirectories((current) => {
        const branchless = removeTreeBranch(current, path);
        return current[path] ? { ...branchless, [path]: current[path] } : branchless;
      });
      setExpandedPaths((current) => new Set([...current].filter((candidate) => candidate === path || !isPathInside(candidate, path))));
    }
    try {
      return await loadTreeDirectory(path);
    } catch (err) {
      setError(getErrorMessage(err));
      return undefined;
    }
  }, [loadTreeDirectory, updateDirectories]);

  const handleRefresh = useCallback(() => {
    void refreshDirectory(currentPath, true);
  }, [currentPath, refreshDirectory]);

  const handlePathSubmit = useCallback(() => {
    void loadDirectory(pathInput.trim() || ".");
  }, [loadDirectory, pathInput]);

  const handleUpload = useCallback(async () => {
    if (!sessionId) return;
    const result = await window.remoteFileApi.uploadFile(sessionId, currentPath);
    if (!result.canceled) {
      await refreshDirectory(currentPath);
    }
  }, [currentPath, refreshDirectory, sessionId]);

  const uploadDroppedFiles = useCallback(async (files: FileList | File[], targetDir: string) => {
    if (!sessionId) return;
    if (files.length === 0) {
      setError(t("files.onlyLocalFiles"));
      return;
    }
    closeFileContextMenu();
    setError(null);
    setUploadingCount(files.length);
    try {
      const result = await window.remoteFileApi.uploadDroppedFiles(sessionId, targetDir, files);
      if (!result.canceled) {
        await refreshDirectory(targetDir);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setUploadingCount(0);
    }
  }, [closeFileContextMenu, refreshDirectory, sessionId, t]);

  const handleLocalFileDragOver = useCallback((event: DragEvent<HTMLElement>, targetDir = currentPath) => {
    if (!hasLocalFileDrag(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTargetPath(targetDir);
  }, [currentPath]);

  const handleLocalFileDrop = useCallback((event: DragEvent<HTMLElement>, targetDir = currentPath) => {
    if (!hasLocalFileDrag(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDropTargetPath(null);
    void uploadDroppedFiles(Array.from(event.dataTransfer.files), targetDir);
  }, [currentPath, uploadDroppedFiles]);

  const handleLocalFileDragLeave = useCallback((event: DragEvent<HTMLElement>, targetDir = currentPath) => {
    const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDropTargetPath((current) => current === targetDir ? null : current);
  }, [currentPath]);

  const startDownloadTransfer = useCallback(async (mode: "save" | "drag", entry: RemoteFileEntry) => {
    if (!sessionId || entry.type === "directory" || downloadTransferRef.current) return;
    const transferId = crypto.randomUUID();
    const initial: DownloadTransferState = {
      transferId,
      mode,
      entry,
      status: mode === "save" ? "selecting" : "running",
      transferredBytes: 0,
      totalBytes: entry.size,
      percent: entry.size === 0 ? null : 0
    };
    downloadTransferRef.current = initial;
    setDownloadTransfer(initial);
    if (mode === "drag") setDownloadDragPath(entry.path);
    setError(null);
    try {
      const result = mode === "save"
        ? await window.remoteFileApi.downloadFile(transferId, sessionId, entry.path, entry.name)
        : await window.remoteFileApi.startDownloadDrag(transferId, sessionId, entry.path, entry.name);
      if (result.canceled && downloadTransferRef.current?.status === "selecting") {
        setDownloadTransfer(null);
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      setDownloadTransfer((current) => current?.transferId === transferId ? {
        ...current,
        status: "failed",
        error: message
      } : current);
    } finally {
      if (mode === "drag") setDownloadDragPath((current) => current === entry.path ? null : current);
    }
  }, [sessionId]);

  const handleRemoteFileDragStart = useCallback((event: DragEvent<HTMLButtonElement>, entry: RemoteFileEntry) => {
    if (!sessionId || entry.type === "directory") {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeFileContextMenu();
    void startDownloadTransfer("drag", entry);
  }, [closeFileContextMenu, sessionId, startDownloadTransfer]);

  const handleDownload = useCallback(async (entry: RemoteFileEntry) => {
    closeFileContextMenu();
    if (!sessionId || entry.type === "directory") return;
    await startDownloadTransfer("save", entry);
  }, [closeFileContextMenu, sessionId, startDownloadTransfer]);

  const handleCancelDownload = useCallback(() => {
    const transferId = downloadTransferRef.current?.transferId;
    if (transferId) void window.remoteFileApi.cancelDownload(transferId);
  }, []);

  const handleAddToTerminal = useCallback((entry: RemoteFileEntry) => {
    closeFileContextMenu();
    if (!sessionId) return;
    window.terminalApi.write(sessionId, entry.path);
    onFocusTerminal?.();
  }, [closeFileContextMenu, onFocusTerminal, sessionId]);

  const handleDeleteEntry = useCallback(async (entry: RemoteFileEntry) => {
    closeFileContextMenu();
    if (!sessionId) return;
    if (!window.confirm(t("confirm.deleteEntry", { name: entry.name }))) return;
    try {
      await window.remoteFileApi.deleteEntry(sessionId, entry.path);
      const parentDirectory = findCachedParentPath(entry.path);
      const removedTabs = previewTabsRef.current.filter((tab) => tab.path === entry.path || isPathInside(tab.path, entry.path));
      if (removedTabs.length > 0) {
        removedTabs.forEach(releasePreviewForTab);
        const nextTabs = previewTabsRef.current.filter((tab) => !removedTabs.includes(tab));
        setPreviewTabs(nextTabs);
        if (removedTabs.some((tab) => tab.id === activePreviewTabIdRef.current)) {
          onActivePreviewTabChange?.(nextTabs.at(-1)?.id ?? null);
        }
      }
      if (entry.path === selectedPathRef.current) {
        setSelectedPath(null);
        selectedPathRef.current = null;
      }
      if (sameTreePath(currentPath, entry.path) || isPathInside(currentPath, entry.path)) {
        setCurrentPath(parentDirectory);
        setPathInput(parentDirectory);
        onCurrentPathChange?.(parentDirectory);
        setSelectedPath(parentDirectory);
        selectedPathRef.current = parentDirectory;
      }
      updateDirectories((current) => removeTreeBranch(current, entry.path));
      setExpandedPaths((current) => new Set([...current].filter((candidate) => !isPathInside(candidate, entry.path))));
      await refreshDirectory(parentDirectory);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [closeFileContextMenu, currentPath, findCachedParentPath, onActivePreviewTabChange, onCurrentPathChange, refreshDirectory, releasePreviewForTab, sessionId, t, updateDirectories]);

  const handleOpenInExplorer = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    try {
      await window.remoteFileApi.openInExplorer(sessionId, currentPath);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [currentPath, sessionId]);

  const closePreviewTab = useCallback((tabId: string) => {
    const tab = previewTabsRef.current.find((item) => item.id === tabId);
    if (!tab || !confirmDiscardTab(tab)) {
      return;
    }
    const tabIndex = previewTabsRef.current.findIndex((item) => item.id === tabId);
    const nextTabs = previewTabsRef.current.filter((item) => item.id !== tabId);
    releasePreviewForTab(tab);
    setPreviewTabs(nextTabs);
    if (activePreviewTabIdRef.current === tabId) {
      const nextActive = nextTabs[tabIndex] ?? nextTabs[tabIndex - 1] ?? null;
      onActivePreviewTabChange?.(nextActive?.id ?? null);
    }
    if (selectedPathRef.current === tab.path) {
      selectedPathRef.current = null;
      setSelectedPath(null);
    }
  }, [confirmDiscardTab, onActivePreviewTabChange, releasePreviewForTab]);

  const handleClosePreview = useCallback(() => {
    const tabId = activePreviewTabIdRef.current;
    if (tabId) closePreviewTab(tabId);
  }, [closePreviewTab]);

  useEffect(() => {
    if (!closePreviewRequest || handledClosePreviewRequestRef.current === closePreviewRequest.requestId) {
      return;
    }
    handledClosePreviewRequestRef.current = closePreviewRequest.requestId;
    closePreviewTab(closePreviewRequest.tabId);
    onClosePreviewRequestHandled?.(closePreviewRequest.requestId);
  }, [closePreviewRequest, closePreviewTab, onClosePreviewRequestHandled]);

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

  const handleReloadPreview = useCallback(async (tab?: PreviewTabState) => {
    const targetTab = tab || activePreviewTab;
    if (!targetTab || targetTab.state.status !== "ready" || !confirmDiscardTab(targetTab)) {
      return;
    }
    const targetState = targetTab.state;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    const tabId = targetTab.id;
    updatePreviewTab(tabId, (t) => ({ ...t, saveState: { status: "idle" }, previewRequestId: requestId }));
    try {
      releasePreviewForTab(targetTab);
      const nextPreview = await window.remoteFileApi.previewFile(targetState.sessionId, targetState.path);
      const currentTab = previewTabsRef.current.find((t) => t.id === tabId);
      if (!currentTab || currentTab.previewRequestId !== requestId) {
        const stalePreviewId = getPreviewId(nextPreview);
        if (stalePreviewId) {
          void window.remoteFileApi.releasePreview(stalePreviewId);
        }
        return;
      }
      updatePreviewTab(tabId, (t) => ({
        ...t,
        state: { ...targetState, preview: nextPreview },
        originalContent: nextPreview.kind === "text" ? nextPreview.content : "",
        editorContent: nextPreview.kind === "text" ? nextPreview.content : "",
        viewMode: isMarkdownFile(targetTab.fileName) ? "preview" : "edit"
      }));
    } catch (err) {
      const currentTab = previewTabsRef.current.find((t) => t.id === tabId);
      if (!currentTab || currentTab.previewRequestId !== requestId) return;
      updatePreviewTab(tabId, (t) => ({ ...t, saveState: { status: "error", message: getErrorMessage(err) } }));
    }
  }, [activePreviewTab, confirmDiscardTab, releasePreviewForTab, updatePreviewTab]);

  const handleSavePreview = useCallback(async () => {
    if (
      !activePreviewTab
      || activePreview.status !== "ready"
      || activePreview.preview.kind !== "text"
      || !isDirty
      || saveState.status === "saving"
      || saveState.status === "conflict"
    ) {
      return;
    }
    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    const tabId = activePreviewTab.id;
    updatePreviewTab(tabId, (tab) => ({ ...tab, saveState: { status: "saving" }, saveRequestId: requestId }));
    try {
      const result = await window.remoteFileApi.writeText(
        activePreview.sessionId,
        activePreview.path,
        editorContent,
        activePreview.preview.version
      );
      const currentTab = previewTabsRef.current.find((tab) => tab.id === tabId);
      if (!currentTab || currentTab.saveRequestId !== requestId) return;
      if (result.status === "conflict") {
        updatePreviewTab(tabId, (tab) => ({ ...tab, saveState: { status: "conflict", message: t("files.conflict") } }));
        return;
      }
      updatePreviewTab(tabId, (tab) => ({
        ...tab,
        state: {
          ...activePreview,
          preview: {
            kind: "text",
            content: editorContent,
            size: result.size,
            version: result.version
          }
        },
        originalContent: editorContent,
        saveState: { status: "idle" }
      }));
      if (sessionId === activePreview.sessionId) {
        refreshDirectory(findCachedParentPath(activePreview.path))
          .catch((err) => {
            const latestTab = previewTabsRef.current.find((tab) => tab.id === tabId);
            if (latestTab?.saveRequestId === requestId) {
              setError(getErrorMessage(err));
            }
          });
      }
    } catch (err) {
      const currentTab = previewTabsRef.current.find((tab) => tab.id === tabId);
      if (!currentTab || currentTab.saveRequestId !== requestId) return;
      updatePreviewTab(tabId, (tab) => ({ ...tab, saveState: { status: "error", message: getErrorMessage(err) } }));
    }
  }, [activePreview, activePreviewTab, editorContent, findCachedParentPath, isDirty, refreshDirectory, saveState.status, sessionId, t, updatePreviewTab]);

  const movePreviewMatch = useCallback((direction: 1 | -1) => {
    if (!activePreviewTab || !previewMatches.length) {
      return;
    }
    updatePreviewTab(activePreviewTab.id, (tab) => ({
      ...tab,
      activePreviewMatch: (tab.activePreviewMatch + direction + previewMatches.length) % previewMatches.length
    }));
  }, [activePreviewTab, previewMatches.length, updatePreviewTab]);

  const previewIcon = activePreview.status === "ready" && activePreview.preview.kind === "image"
    ? <ImageIcon aria-hidden="true" />
    : activePreview.status === "ready" && activePreview.preview.kind === "video"
      ? <Video aria-hidden="true" />
      : <FileText aria-hidden="true" />;

  const handleTreeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, node: VisibleTreeNode, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = Math.max(0, Math.min(visibleTreeNodes.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      treeRowRefs.current.get(visibleTreeNodes[nextIndex]?.entry.path)?.focus();
      return;
    }
    if (event.key === "ArrowRight" && node.entry.type === "directory" && !expandedPaths.has(node.entry.path)) {
      event.preventDefault();
      void handleOpenEntry(node.entry);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.entry.type === "directory" && expandedPaths.has(node.entry.path)) {
        void handleOpenEntry(node.entry);
      } else if (node.parentPath) {
        treeRowRefs.current.get(node.parentPath)?.focus();
      }
    }
  };

  if (!sessionId || !session) {
    return (
      <aside className="remote-file-panel">
        <div className="remote-file-header">
          <div>
            <h2>{t("files.title")}</h2>
            <span>{t("files.noSession")}</span>
          </div>
        </div>
        <div className="remote-file-empty">{t("files.availableAfterSession")}</div>
      </aside>
    );
  }

  return (
    <>
      <aside
        className={`remote-file-panel ${dropTargetPath === currentPath ? "drop-active" : ""}`}
        onDragOver={(event) => handleLocalFileDragOver(event)}
        onDragLeave={(event) => handleLocalFileDragLeave(event)}
        onDrop={(event) => handleLocalFileDrop(event)}
      >
        <div className="remote-file-header">
          <div>
            <h2>{t("files.title")}</h2>
            <span>{session.title}</span>
        </div>
        <div className="remote-file-actions">
          {session.type !== "ssh" && (
            <button className="icon-button" type="button" title={t("files.searchProject")} aria-label={t("files.searchProject")} onClick={() => onSearchRequest?.("files", currentPath)}>
              <Search aria-hidden="true" />
            </button>
          )}
          <button className="icon-button" type="button" title={t("files.parentDirectory")} aria-label={t("files.parentDirectory")} disabled={!navigationRoot || sameTreePath(currentPath, navigationRoot)} onClick={() => void loadDirectory(parentTreePath(currentPath))}>
            <ArrowUp aria-hidden="true" />
          </button>
          {canOpenInExplorer && (
            <button className="icon-button" type="button" title={t("files.openInExplorer")} aria-label={t("files.openInExplorer")} onClick={() => void handleOpenInExplorer()}>
              <FolderOpen aria-hidden="true" />
            </button>
          )}
          <button className="icon-button" type="button" title={t("common.refresh")} aria-label={t("common.refresh")} onClick={handleRefresh}>
            <RefreshCw aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" title={t("common.uploadFile")} aria-label={t("common.uploadFile")} onClick={() => void handleUpload()}>
            <Upload aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="remote-file-path">
        <input
          type="text"
          aria-label={t("files.directoryPath")}
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
          placeholder={t("files.searchPlaceholder")}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {normalizedSearchQuery && (
          <button type="button" title={t("files.clearSearch")} aria-label={t("files.clearSearch")} onClick={() => setSearchQuery("")}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>

      {error && (
        <div className="remote-file-error">
          <span>{error}</span>
          <button type="button" onClick={handleRefresh}>{t("common.retry")}</button>
        </div>
      )}

      {(uploadingCount > 0 || (downloadTransfer && downloadTransfer.status !== "selecting")) && (
        <div className="remote-file-transfer-status">
          {uploadingCount > 0 ? (
            t("files.uploading", { count: uploadingCount })
          ) : downloadTransfer && (
            <>
              <div className="remote-file-transfer-heading">
                <span title={downloadTransfer.entry.name}>{downloadTransfer.entry.name}</span>
                <strong>
                  {downloadTransfer.status === "completed"
                    ? t("files.downloadCompleted")
                    : downloadTransfer.status === "canceled"
                      ? t("files.downloadCanceled")
                      : downloadTransfer.status === "failed"
                        ? t("files.downloadFailed")
                        : downloadTransfer.percent === null ? t("files.preparingDownload") : `${downloadTransfer.percent}%`}
                </strong>
              </div>
              <div
                className={`remote-file-transfer-progress ${downloadTransfer.percent === null ? "indeterminate" : ""}`}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={downloadTransfer.percent ?? undefined}
              >
                <span style={{ width: `${downloadTransfer.percent ?? 35}%` }} />
              </div>
              <div className="remote-file-transfer-footer">
                <span>
                  {downloadTransfer.totalBytes > 0
                    ? `${formatSize(downloadTransfer.transferredBytes)} / ${formatSize(downloadTransfer.totalBytes)}`
                    : formatSize(downloadTransfer.transferredBytes)}
                </span>
                {downloadTransfer.status === "running" && (
                  <button type="button" onClick={handleCancelDownload}>{t("common.cancel")}</button>
                )}
                {downloadTransfer.status === "failed" && (
                  <button type="button" onClick={() => {
                    const { mode, entry } = downloadTransfer;
                    setDownloadTransfer(null);
                    downloadTransferRef.current = null;
                    void startDownloadTransfer(mode, entry);
                  }}>{t("common.retry")}</button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <div className="remote-file-list" role="tree" aria-busy={loading} onScroll={closeFileContextMenu}>
        {loading ? (
          <div className="remote-file-empty">{t("files.loading")}</div>
        ) : !treeRoot && !error ? (
          <div className="remote-file-empty">{t("files.emptyDirectory")}</div>
        ) : visibleTreeNodes.length === 0 ? (
          <div className="remote-file-empty">{t("files.noMatches")}</div>
        ) : (
          visibleTreeNodes.map((node, index) => {
            const { entry, depth } = node;
            const directoryState = entry.type === "directory" ? directories[entry.path] : undefined;
            const expanded = entry.type === "directory" && expandedPaths.has(entry.path);
            const showEmpty = expanded && directoryState?.status === "ready" && directoryState.entries.length === 0;
            const showError = expanded && directoryState?.status === "error";
            return (
              <div className="remote-file-tree-item" key={entry.path}>
                <button
                  ref={(element) => {
                    if (element) treeRowRefs.current.set(entry.path, element);
                    else treeRowRefs.current.delete(entry.path);
                  }}
                  className={`remote-file-row ${selectedPath === entry.path ? "selected" : ""} ${dropTargetPath === entry.path ? "drop-target" : ""} ${downloadDragPath === entry.path ? "drag-preparing" : ""}`}
                  style={{ "--remote-file-depth": depth } as CSSProperties}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={entry.type === "directory" ? expanded : undefined}
                  type="button"
                  draggable={entry.type !== "directory"}
                  onClick={() => {
                    closeFileContextMenu();
                    void handleOpenEntry(entry);
                  }}
                  onKeyDown={(event) => handleTreeKeyDown(event, node, index)}
                  onContextMenu={depth === 0 ? undefined : (event) => handleFileContextMenu(event, entry)}
                  onDragStart={(event) => handleRemoteFileDragStart(event, entry)}
                  onDragOver={(event) => {
                    if (entry.type === "directory") handleLocalFileDragOver(event, entry.path);
                  }}
                  onDragLeave={(event) => {
                    if (entry.type === "directory") handleLocalFileDragLeave(event, entry.path);
                  }}
                  onDrop={(event) => {
                    if (entry.type === "directory") handleLocalFileDrop(event, entry.path);
                  }}
                >
                  <span className={`remote-file-expander ${expanded ? "expanded" : ""}`}>
                    {entry.type === "directory" && (
                      directoryState?.status === "loading"
                        ? <LoaderCircle className="remote-file-spinner" aria-hidden="true" />
                        : <ChevronRight aria-hidden="true" />
                    )}
                  </span>
                  <span className={`remote-file-icon ${entry.type}`}>
                    {entry.type === "directory" ? (expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />) : <File aria-hidden="true" />}
                  </span>
                  <span className="remote-file-name" title={entry.path}>{node.chainPrefix ? `${node.chainPrefix} / ${entry.name}` : entry.name}</span>
                  <span className="remote-file-meta">{entry.type === "directory" ? t("files.folder") : formatSize(entry.size)}</span>
                  <span className="remote-file-meta">{formatModifiedAt(entry.modifiedAt)}</span>
                </button>
                {showEmpty && <div className="remote-file-tree-message" style={{ "--remote-file-depth": depth + 1 } as CSSProperties}>{t("files.emptyDirectory")}</div>}
                {showError && (
                  <div className="remote-file-tree-message error" style={{ "--remote-file-depth": depth + 1 } as CSSProperties}>
                    <span>{directoryState.error}</span>
                    <button type="button" onClick={() => void refreshDirectory(entry.path)}>{t("common.retry")}</button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {fileContextMenu && contextEntry && (
        <div
          className="remote-file-context-menu"
          role="menu"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextEntry.type === "directory" && session.type !== "ssh" && (
            <>
              <button type="button" role="menuitem" onClick={() => { closeFileContextMenu(); onSearchRequest?.("files", contextEntry.path); }}>
                <Search aria-hidden="true" />
                <span>{t("files.searchFilesHere")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { closeFileContextMenu(); onSearchRequest?.("text", contextEntry.path); }}>
                <FileText aria-hidden="true" />
                <span>{t("files.searchTextHere")}</span>
              </button>
            </>
          )}
          <button type="button" role="menuitem" onClick={() => handleAddToTerminal(contextEntry)}>
            <TerminalIcon aria-hidden="true" />
            <span>{t("files.addToTerminal")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void handleDeleteEntry(contextEntry)}>
            <Trash2 aria-hidden="true" />
            <span>{t("files.deleteEntry")}</span>
          </button>
          {contextEntry.type !== "directory" && (
            <button type="button" role="menuitem" disabled={downloadTransfer !== null} onClick={() => void handleDownload(contextEntry)}>
              <Download aria-hidden="true" />
              <span>{t("common.download")}</span>
            </button>
          )}
        </div>
      )}
    </aside>

    {previewHost && activePreviewTab && createPortal(
      <div className="remote-file-preview">
          <div className="remote-preview-header">
            <span>
              {previewIcon}
              {activePreviewTab.fileName || activePreviewTab.path}
              {isDirty && <strong className="remote-preview-dirty" title={t("files.unsavedMarker")}>*</strong>}
            </span>
            <div className="remote-preview-actions">
              {activePreview.status === "ready" && activePreview.preview.kind === "text" && (
                <>
                  {isMarkdownFile(activePreview.fileName) && (
                    <button
                      className="icon-button"
                      type="button"
                      title={viewMode === "preview" ? t("files.editMode") : t("files.previewMode")}
                      aria-label={viewMode === "preview" ? t("files.editMode") : t("files.previewMode")}
                      onClick={() => updatePreviewTab(activePreviewTab.id, (tab) => ({
                        ...tab,
                        viewMode: tab.viewMode === "preview" ? "edit" : "preview"
                      }))}
                    >
                      {viewMode === "preview" ? <SquarePen aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    </button>
                  )}
                  {viewMode === "edit" && (
                    <>
                      <button
                        className="icon-button"
                        type="button"
                        title={t("files.reloadFile")}
                        aria-label={t("files.reloadFile")}
                        disabled={saveState.status === "saving"}
                        onClick={() => void handleReloadPreview()}
                      >
                        <RefreshCw aria-hidden="true" />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        title={t("files.saveFile")}
                        aria-label={t("files.saveFile")}
                        disabled={!isDirty || saveState.status === "saving" || saveState.status === "conflict"}
                        onClick={() => void handleSavePreview()}
                      >
                        <Save aria-hidden="true" />
                      </button>
                    </>
                  )}
                </>
              )}
              {activePreview.status === "ready" && activePreviewTab.entry && activePreviewTab.entry.type !== "directory" && (
                <button className="icon-button" type="button" title={t("common.download")} aria-label={t("common.download")} disabled={downloadTransfer !== null} onClick={() => void handleDownload(activePreviewTab.entry!)}>
                  <Download aria-hidden="true" />
                </button>
              )}
              <button className="icon-button" type="button" title={t("files.closePreview")} aria-label={t("files.closePreview")} onClick={handleClosePreview}>
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          {activePreview.status === "loading" && (
            <div className="remote-file-empty">{t("files.loadingPreview")}</div>
          )}
          {activePreview.status === "error" && (
            <div className="remote-file-error">
              <span>{activePreview.message}</span>
            </div>
          )}
          {activePreview.status === "ready" && (
            activePreview.preview.kind === "text" ? (
              viewMode === "preview" && isMarkdownFile(activePreview.fileName) ? (
                <div className="remote-preview-markdown">
                  <MarkdownBlock className="remote-preview-markdown-content" content={editorContent} />
                </div>
              ) : (
                <>
                  {saveState.status !== "idle" && saveState.status !== "saving" && (
                    <div className={`remote-preview-save-message ${saveState.status}`}>
                      <span>{saveState.message}</span>
                      {saveState.status === "conflict" && (
                        <button type="button" onClick={() => void handleReloadPreview()}>{t("common.reload")}</button>
                      )}
                    </div>
                  )}
                  <div className="remote-preview-search">
                    <Search aria-hidden="true" />
                    <input
                      type="text"
                      aria-label={t("files.searchPreview")}
                      placeholder={t("files.searchPreview")}
                      value={previewSearchQuery}
                      onChange={(event) => {
                        updatePreviewTab(activePreviewTab.id, (tab) => ({
                          ...tab,
                          previewSearchQuery: event.target.value,
                          activePreviewMatch: 0
                        }));
                      }}
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
                    <button type="button" title={t("files.previousMatch")} aria-label={t("files.previousMatch")} disabled={!previewMatches.length} onClick={() => movePreviewMatch(-1)}>
                      <ArrowUp aria-hidden="true" />
                    </button>
                    <button type="button" title={t("files.nextMatch")} aria-label={t("files.nextMatch")} disabled={!previewMatches.length} onClick={() => movePreviewMatch(1)}>
                      <ArrowDown aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      title={t("files.clearPreviewSearch")}
                      aria-label={t("files.clearPreviewSearch")}
                      disabled={!previewSearchQuery}
                      onClick={() => updatePreviewTab(activePreviewTab.id, (tab) => ({ ...tab, previewSearchQuery: "", activePreviewMatch: 0 }))}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </div>
                  <div className="remote-preview-editor-shell">
                    <div className="remote-preview-highlight-viewport" aria-hidden="true">
                      <div ref={previewHighlightRef} className="remote-preview-highlight-content">
                        {activeMatch ? (
                          <>
                            {editorContent.slice(0, activeMatch.start)}
                            <mark>{editorContent.slice(activeMatch.start, activeMatch.end)}</mark>
                            {editorContent.slice(activeMatch.end)}
                          </>
                        ) : editorContent}
                      </div>
                    </div>
                    <textarea
                      ref={previewContentRef}
                      className="remote-preview-editor"
                      aria-label={t("files.editContent")}
                      spellCheck={false}
                      value={editorContent}
                      onScroll={syncPreviewHighlight}
                      onChange={(event) => {
                        const nextContent = event.target.value;
                        updatePreviewTab(activePreviewTab.id, (tab) => ({
                          ...tab,
                          editorContent: nextContent,
                          saveState: tab.saveState.status === "error" ? { status: "idle" } : tab.saveState
                        }));
                      }}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                          event.preventDefault();
                          void handleSavePreview();
                        }
                      }}
                    />
                  </div>
                  <div className="remote-preview-status">
                    <span>{formatSize(new TextEncoder().encode(editorContent).length)}</span>
                    <span>{saveState.status === "saving" ? t("common.saving") : isDirty ? t("common.unsavedChanges") : t("common.saved")}</span>
                  </div>
                </>
              )
            ) : activePreview.preview.kind === "too_large" ? (
              <div className="remote-file-empty">
                {t("files.tooLarge", { size: formatSize(activePreview.preview.size) })}
              </div>
            ) : activePreview.preview.kind === "image" ? (
              <div className="remote-preview-media">
                <img src={activePreview.preview.url} alt={activePreview.fileName} />
              </div>
            ) : activePreview.preview.kind === "video" ? (
              <div className="remote-preview-media">
                <video src={activePreview.preview.url} controls preload="metadata" />
              </div>
            ) : (
              <div className="remote-file-empty">{t("files.binary")}</div>
            )
          )}
      </div>,
      previewHost
    )}
    </>
  );
}
