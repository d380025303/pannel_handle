import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Download, File, FileText, Folder, FolderOpen, Image as ImageIcon, LoaderCircle, RefreshCw, Save, Search, Terminal as TerminalIcon, Trash2, Upload, Video, X } from "lucide-react";
import { useI18n } from "../i18n";
import { flattenLoadedTree, isPathInside, removeTreeBranch, sameTreePath, type DirectoryTreeState, type VisibleTreeNode } from "../utils/remoteFileTree";
import type { RemoteFileEntry, RemoteFilePreview, TerminalSession } from "../vite-env";

type RemoteFilePanelProps = {
  session?: TerminalSession;
  openRequest?: { sessionId: string; path: string; requestId: number } | null;
  onOpenRequestHandled?: (requestId: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPreviewActive?: (active: boolean) => void;
  onCurrentPathChange?: (path: string) => void;
  onSearchRequest?: (mode: "files" | "text", rootPath: string) => void;
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

function getPreviewId(preview: RemoteFilePreview) {
  return preview.kind === "image" || preview.kind === "video" ? preview.previewId : null;
}

function hasLocalFileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
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

export function RemoteFilePanel({ session, openRequest, onOpenRequestHandled, onDirtyChange, onPreviewActive, onCurrentPathChange, onSearchRequest }: RemoteFilePanelProps) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState(".");
  const [pathInput, setPathInput] = useState(".");
  const [treeRoot, setTreeRoot] = useState<RemoteFileEntry | null>(null);
  const [directories, setDirectories] = useState<DirectoryTreeState>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
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
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [downloadDragPath, setDownloadDragPath] = useState<string | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState>(null);
  const requestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const previewContentRef = useRef<HTMLTextAreaElement>(null);
  const previewHighlightRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  const handledOpenRequestRef = useRef(0);
  const openRequestAttemptRef = useRef(0);
  const activePreviewIdRef = useRef<string | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const treeRootRef = useRef<RemoteFileEntry | null>(null);
  const directoriesRef = useRef<DirectoryTreeState>({});
  const directoryRequestRef = useRef(new Map<string, number>());
  const treeRowRefs = useRef(new Map<string, HTMLButtonElement>());

  const sessionId = session?.id;

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
  const isDirty = preview.status === "ready"
    && preview.preview.kind === "text"
    && editorContent !== originalContent;
  dirtyRef.current = isDirty;
  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  const isPreviewActive = preview.status !== "idle";
  const hasTextPreview = preview.status === "ready" && preview.preview.kind === "text";
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

  const activeMatch = previewMatches[activePreviewMatch] ?? null;

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
    if (!previewMatches.length) {
      setActivePreviewMatch(0);
      return;
    }
    setActivePreviewMatch((current) => Math.min(current, previewMatches.length - 1));
  }, [previewMatches.length]);

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

  const closeFileContextMenu = useCallback(() => {
    setFileContextMenu(null);
  }, []);

  const handleFileContextMenu = useCallback((event: MouseEvent<HTMLElement>, entry: RemoteFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
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

  const releaseActivePreview = useCallback(() => {
    const previewId = activePreviewIdRef.current;
    if (previewId) {
      void window.remoteFileApi.releasePreview(previewId);
      activePreviewIdRef.current = null;
    }
  }, []);

  const resetEditor = useCallback(() => {
    saveRequestRef.current += 1;
    setOriginalContent("");
    setEditorContent("");
    setSaveState({ status: "idle" });
    setPreviewSearchQuery("");
  }, []);

  const updateDirectories = useCallback((updater: (current: DirectoryTreeState) => DirectoryTreeState) => {
    const next = updater(directoriesRef.current);
    directoriesRef.current = next;
    setDirectories(next);
  }, []);

  const loadTreeDirectory = useCallback(async (path: string) => {
    if (!sessionId) return undefined;
    const requestId = (directoryRequestRef.current.get(path) ?? 0) + 1;
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
    treeRootRef.current = root;
    directoriesRef.current = {};
    setTreeRoot(root);
    setDirectories({});
    setExpandedPaths(new Set([path]));
    return loadTreeDirectory(path);
  }, [loadTreeDirectory]);

  const loadDirectory = useCallback(async (path: string, preserveSearch = false, skipConfirm = false) => {
    if (!sessionId || (!skipConfirm && !confirmDiscard())) return undefined;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    previewRequestRef.current += 1;
    releaseActivePreview();
    closeFileContextMenu();
    selectedPathRef.current = null;
    setSelectedPath(null);
    setPreview({ status: "idle" });
    resetEditor();
    setLoading(true);
    setError(null);
    try {
      const root = treeRootRef.current;
      let targetEntry: RemoteFileEntry | null = null;
      let targetEntries: RemoteFileEntry[] | undefined;
      if (root && isPathInside(path, root.path)) {
        let current = root;
        const expanded = new Set<string>();
        while (!sameTreePath(current.path, path)) {
          expanded.add(current.path);
          const children = directoriesRef.current[current.path]?.entries ?? await loadTreeDirectory(current.path);
          const next = children?.find((entry) => entry.type === "directory" && isPathInside(path, entry.path));
          if (!next) throw new Error(`Directory not found: ${path}`);
          current = next;
        }
        targetEntry = current;
        expanded.add(current.path);
        targetEntries = await loadTreeDirectory(current.path);
        setExpandedPaths((existing) => new Set([...existing, ...expanded]));
      } else {
        targetEntries = await setRootDirectory(path);
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
  }, [closeFileContextMenu, confirmDiscard, loadTreeDirectory, onCurrentPathChange, releaseActivePreview, resetEditor, sessionId, setRootDirectory]);

  useEffect(() => {
    if (!sessionId) {
      onCurrentPathChange?.(".");
      setCurrentPath(".");
      setPathInput(".");
      treeRootRef.current = null;
      directoriesRef.current = {};
      directoryRequestRef.current.clear();
      setTreeRoot(null);
      setDirectories({});
      setExpandedPaths(new Set());
      selectedPathRef.current = null;
      setSelectedPath(null);
      closeFileContextMenu();
      setPreview({ status: "idle" });
      setSearchQuery("");
      resetEditor();
      releaseActivePreview();
      setError(null);
      setLoading(false);
      previewRequestRef.current += 1;
      return;
    }

    let disposed = false;
    const initialRequestId = requestRef.current;
    setSearchQuery("");
    setPreviewSearchQuery("");
    setLoading(true);
    setError(null);
    window.remoteFileApi.getHome(sessionId)
      .then((home) => {
        if (!disposed && requestRef.current === initialRequestId) {
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
      directoryRequestRef.current.forEach((value, path) => directoryRequestRef.current.set(path, value + 1));
      releaseActivePreview();
    };
  }, [closeFileContextMenu, loadDirectory, onCurrentPathChange, releaseActivePreview, resetEditor, sessionId]);

  const handleOpenEntry = useCallback(async (entry: RemoteFileEntry, force = false) => {
    if (!force && entry.type !== "directory" && entry.path === selectedPathRef.current) {
      return;
    }
    if (!confirmDiscard()) {
      return;
    }
    selectedPathRef.current = entry.path;
    setSelectedPath(entry.path);
    resetEditor();
    releaseActivePreview();
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
        }
      }
      return;
    }

    if (!sessionId) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setPreview({ status: "loading", path: entry.path });
    try {
      const nextPreview = await window.remoteFileApi.previewFile(sessionId, entry.path);
      if (previewRequestRef.current !== requestId) {
        const stalePreviewId = getPreviewId(nextPreview);
        if (stalePreviewId) {
          void window.remoteFileApi.releasePreview(stalePreviewId);
        }
        return;
      }
      activePreviewIdRef.current = getPreviewId(nextPreview);
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
  }, [confirmDiscard, expandedPaths, loadTreeDirectory, onCurrentPathChange, releaseActivePreview, resetEditor, sessionId]);

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
      if (!confirmDiscard()) {
        completed = true;
        onOpenRequestHandled?.(requestId);
        return;
      }
      const targetDirectory = parentPath(openRequest.path);
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
  }, [confirmDiscard, handleOpenEntry, loadDirectory, onOpenRequestHandled, openRequest, sessionId]);

  const findCachedParentPath = useCallback((entryPath: string) => (
    Object.entries(directoriesRef.current).find(([, directory]) => (
      directory.entries.some((entry) => entry.path === entryPath)
    ))?.[0] ?? parentPath(entryPath)
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

  const uploadDroppedFiles = useCallback(async (files: FileList, targetDir: string) => {
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
    void uploadDroppedFiles(event.dataTransfer.files, targetDir);
  }, [currentPath, uploadDroppedFiles]);

  const handleLocalFileDragLeave = useCallback((event: DragEvent<HTMLElement>, targetDir = currentPath) => {
    const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDropTargetPath((current) => current === targetDir ? null : current);
  }, [currentPath]);

  const handleRemoteFileDragStart = useCallback((event: DragEvent<HTMLButtonElement>, entry: RemoteFileEntry) => {
    if (!sessionId || entry.type === "directory") {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeFileContextMenu();
    setError(null);
    setDownloadDragPath(entry.path);
    void window.remoteFileApi.startDownloadDrag(sessionId, entry.path, entry.name)
      .catch((err) => {
        setError(getErrorMessage(err));
      })
      .finally(() => {
        setDownloadDragPath((current) => current === entry.path ? null : current);
      });
  }, [closeFileContextMenu, sessionId]);

  const handleDownload = useCallback(async (entry: RemoteFileEntry) => {
    closeFileContextMenu();
    if (!sessionId || entry.type === "directory") return;
    await window.remoteFileApi.downloadFile(sessionId, entry.path, entry.name);
  }, [closeFileContextMenu, sessionId]);

  const handleAddToTerminal = useCallback((entry: RemoteFileEntry) => {
    closeFileContextMenu();
    if (!sessionId) return;
    window.terminalApi.write(sessionId, entry.path);
  }, [closeFileContextMenu, sessionId]);

  const handleDeleteEntry = useCallback(async (entry: RemoteFileEntry) => {
    closeFileContextMenu();
    if (!sessionId) return;
    if (!window.confirm(t("confirm.deleteEntry", { name: entry.name }))) return;
    try {
      await window.remoteFileApi.deleteEntry(sessionId, entry.path);
      const parentDirectory = findCachedParentPath(entry.path);
      if (entry.path === selectedPathRef.current) {
        releaseActivePreview();
        setPreview({ status: "idle" });
        resetEditor();
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
  }, [closeFileContextMenu, currentPath, findCachedParentPath, onCurrentPathChange, refreshDirectory, releaseActivePreview, resetEditor, sessionId, t, updateDirectories]);

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
    releaseActivePreview();
    setSelectedPath(null);
    setPreview({ status: "idle" });
    resetEditor();
  }, [confirmDiscard, releaseActivePreview, resetEditor]);

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
      releaseActivePreview();
      const nextPreview = await window.remoteFileApi.previewFile(preview.sessionId, preview.path);
      if (previewRequestRef.current !== requestId) {
        const stalePreviewId = getPreviewId(nextPreview);
        if (stalePreviewId) {
          void window.remoteFileApi.releasePreview(stalePreviewId);
        }
        return;
      }
      activePreviewIdRef.current = getPreviewId(nextPreview);
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
  }, [confirmDiscard, preview, releaseActivePreview]);

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
          message: t("files.conflict")
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
        refreshDirectory(findCachedParentPath(preview.path))
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
  }, [editorContent, findCachedParentPath, isDirty, preview, refreshDirectory, saveState.status, sessionId, t]);

  const movePreviewMatch = useCallback((direction: 1 | -1) => {
    if (!previewMatches.length) {
      return;
    }
    setActivePreviewMatch((current) => (
      (current + direction + previewMatches.length) % previewMatches.length
    ));
  }, [previewMatches.length]);

  const previewIcon = preview.status === "ready" && preview.preview.kind === "image"
    ? <ImageIcon aria-hidden="true" />
    : preview.status === "ready" && preview.preview.kind === "video"
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
          <button className="icon-button" type="button" title={t("files.parentDirectory")} aria-label={t("files.parentDirectory")} onClick={() => void loadDirectory(parentPath(currentPath))}>
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

      {(uploadingCount > 0 || downloadDragPath) && (
        <div className="remote-file-transfer-status">
          {uploadingCount > 0
            ? t("files.uploading", { count: uploadingCount })
            : t("files.preparingDownload")}
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
                  <span className="remote-file-name" title={entry.path}>{entry.name}</span>
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
            <button type="button" role="menuitem" onClick={() => void handleDownload(contextEntry)}>
              <Download aria-hidden="true" />
              <span>{t("common.download")}</span>
            </button>
          )}
        </div>
      )}
    </aside>

    {preview.status !== "idle" && (
      <div className="remote-preview-overlay" onClick={handleClosePreview}>
        <div className="remote-preview-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="remote-file-preview">
          <div className="remote-preview-header">
            <span>
              {previewIcon}
              {selectedEntry?.name || preview.path}
              {isDirty && <strong className="remote-preview-dirty" title={t("files.unsavedMarker")}>*</strong>}
            </span>
            <div className="remote-preview-actions">
              {preview.status === "ready" && preview.preview.kind === "text" && (
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
              {preview.status === "ready" && selectedEntry && selectedEntry.type !== "directory" && (
                <button className="icon-button" type="button" title={t("common.download")} aria-label={t("common.download")} onClick={() => void handleDownload(selectedEntry)}>
                  <Download aria-hidden="true" />
                </button>
              )}
              <button className="icon-button" type="button" title={t("files.closePreview")} aria-label={t("files.closePreview")} onClick={handleClosePreview}>
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          {preview.status === "loading" && (
            <div className="remote-file-empty">{t("files.loadingPreview")}</div>
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
                      setPreviewSearchQuery(event.target.value);
                      setActivePreviewMatch(0);
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
                  <button type="button" title={t("files.clearPreviewSearch")} aria-label={t("files.clearPreviewSearch")} disabled={!previewSearchQuery} onClick={() => setPreviewSearchQuery("")}>
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
                </div>
                <div className="remote-preview-status">
                  <span>{formatSize(new TextEncoder().encode(editorContent).length)}</span>
                  <span>{saveState.status === "saving" ? t("common.saving") : isDirty ? t("common.unsavedChanges") : t("common.saved")}</span>
                </div>
              </>
            ) : preview.preview.kind === "too_large" ? (
              <div className="remote-file-empty">
                {t("files.tooLarge", { size: formatSize(preview.preview.size) })}
              </div>
            ) : preview.preview.kind === "image" ? (
              <div className="remote-preview-media">
                <img src={preview.preview.url} alt={preview.fileName} />
              </div>
            ) : preview.preview.kind === "video" ? (
              <div className="remote-preview-media">
                <video src={preview.preview.url} controls preload="metadata" />
              </div>
            ) : (
              <div className="remote-file-empty">{t("files.binary")}</div>
            )
          )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
