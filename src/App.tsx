import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, FileText, Search, Terminal as TerminalIcon, X } from "lucide-react";
import { SettingsModal } from "./components/settings/SettingsModal";
import { CreateSessionModal } from "./components/sessions/CreateSessionModal";
import { DebugSidebar } from "./components/agents/DebugSidebar";
import { AgentUsageStatus } from "./components/agents/AgentUsageStatus";
import { EditSessionModal } from "./components/sessions/EditSessionModal";
import { GitStatusPanel } from "./components/git/GitStatusPanel";
import { HookInstallModal } from "./components/agents/HookInstallModal";
import { SessionPickerModal } from "./components/sessions/SessionPickerModal";
import { SessionSidebar } from "./components/sessions/SessionSidebar";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { TerminalComposer } from "./components/terminal/TerminalComposer";
import { QuickCommandBar } from "./components/terminal/QuickCommandBar";
import { ProjectSearchModal } from "./components/remote/ProjectSearchModal";
import { FileTransferPanel } from "./components/remote/FileTransferPanel";
import { RemoteFilePanel, type RemotePreviewTabSummary } from "./components/remote/RemoteFilePanel";
import { RemoteSystemStatus } from "./components/remote/RemoteSystemStatus";
import { TitleBar } from "./components/app/TitleBar";
import { useRemoteSystemMetrics } from "./hooks/useRemoteSystemMetrics";
import { useAgentUsage } from "./hooks/useAgentUsage";
import { useRightToolsResize } from "./hooks/useRightToolsResize";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useTerminalInstances } from "./hooks/useTerminalInstances";
import { useTerminalSessions } from "./hooks/useTerminalSessions";
import { useWindowState } from "./hooks/useWindowState";
import { DEFAULT_LOCALE, I18nProvider, normalizeLocale, useI18n } from "./i18n";
import { APP_THEMES, DEFAULT_THEME_ID, getAppTheme } from "./themes";
import type { CreateSessionRequest } from "./components/sessions/CreateSessionModal";
import type { AgentHookDebugPayload, AgentProvider, FileTransferTask, Locale, MobileAccessState, QuickCommand, SshConfig, TerminalSession, ThemeId } from "./vite-env";

type ProjectSearchMode = "files" | "text";
type RightTool = "files" | "git" | "debug";
type WorkspaceTab = "terminal" | "preview" | "search" | "transfers";

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(".terminal-host")) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

function hasBlockingOverlay() {
  return Boolean(document.querySelector(
    ".modal-overlay, .remote-preview-overlay, .git-diff-overlay, .git-stash-overlay, .project-search-overlay"
  ));
}

function getBlockingOverlayDiagnostics() {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(
    ".modal-overlay, .remote-preview-overlay, .git-diff-overlay, .git-stash-overlay, .project-search-overlay"
  ));
  const activeElement = document.activeElement;
  const activeElementSummary = activeElement instanceof HTMLElement
    ? {
        tagName: activeElement.tagName.toLowerCase(),
        className: activeElement.className,
        id: activeElement.id
      }
    : null;
  return {
    overlays: overlays.map((overlay) => overlay.className),
    activeElement: activeElementSummary,
    bodyCursor: document.body.style.cursor,
    bodyUserSelect: document.body.style.userSelect
  };
}

type AppContentProps = {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
};

function AppContent({ locale, onLocaleChange }: AppContentProps) {
  const { t } = useI18n();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [editDialogSession, setEditDialogSession] = useState<TerminalSession | null>(null);
  const [hookInstallSession, setHookInstallSession] = useState<TerminalSession | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [agentOutputHistoryMaxEntries, setAgentOutputHistoryMaxEntries] = useState(100);
  const [agentOutputMaxBytes, setAgentOutputMaxBytes] = useState(1024 * 1024);
  const [rightTool, setRightTool] = useState<RightTool>("files");
  const [rightToolsWidth, setRightToolsWidth] = useState(380);
  const [hookDebugEvents, setHookDebugEvents] = useState<AgentHookDebugPayload[]>([]);
  const [remoteFilesDirty, setRemoteFilesDirty] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("terminal");
  const [previewTabs, setPreviewTabs] = useState<RemotePreviewTabSummary[]>([]);
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null);
  const [closePreviewRequest, setClosePreviewRequest] = useState<{ tabId: string; requestId: number } | null>(null);
  const [previewHost, setPreviewHost] = useState<HTMLDivElement | null>(null);
  const [projectSearchMode, setProjectSearchMode] = useState<ProjectSearchMode | null>(null);
  const [projectSearchRoot, setProjectSearchRoot] = useState(".");
  const [filePanelPath, setFilePanelPath] = useState<{ sessionId: string; path: string } | null>(null);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ sessionId: string; path: string; requestId: number } | null>(null);
  const [fileTransfers, setFileTransfers] = useState<FileTransferTask[]>([]);
  const [gitSummary, setGitSummary] = useState<{ sessionId: string; changes: number; conflicts: number } | null>(null);
  const [showCloseGuard, setShowCloseGuard] = useState(false);
  const [mobileAccessState, setMobileAccessState] = useState<MobileAccessState | null>(null);
  const fileOpenRequestIdRef = useRef(0);
  const closePreviewRequestIdRef = useRef(0);
  const saveAllRemoteFilesRef = useRef<(() => Promise<boolean>) | null>(null);
  const lastBlockingOverlaySignatureRef = useRef("");
  const workspaceTabBySessionRef = useRef(new Map<string, WorkspaceTab>());
  const workspaceTabRef = useRef<WorkspaceTab>("terminal");
  workspaceTabRef.current = workspaceTab;
  const { isMaximized } = useWindowState();
  const { sidebarWidth, handleSplitterMouseDown } = useSidebarResize();
  const { rightToolsWidth: liveRightToolsWidth, handleSplitterMouseDown: handleRightSplitterMouseDown } = useRightToolsResize(
    rightToolsWidth,
    (w) => {
      setRightToolsWidth(w);
      window.terminalApi.setConfig({ rightToolsWidth: w });
    }
  );
  const terminalSessions = useTerminalSessions();
  const agentUsage = useAgentUsage(terminalSessions.activeSession, terminalSessions.activeAgentStatus);
  const remoteSystemMetrics = useRemoteSystemMetrics(terminalSessions.activeSession);
  const activeTheme = getAppTheme(themeId);
  const terminalInstances = useTerminalInstances({
    activeId: terminalSessions.activeId,
    isVisible: workspaceTab === "terminal",
    terminalTheme: activeTheme.terminal
  });
  const canSearchProject = Boolean(terminalSessions.activeSession);
  const activeSessionId = terminalSessions.activeSession?.id;

  useEffect(() => {
    let disposed = false;
    void window.mobileAccessApi.getState().then((state) => { if (!disposed) setMobileAccessState(state); });
    const removeListener = window.mobileAccessApi.onStateChanged((state) => { if (!disposed) setMobileAccessState(state); });
    return () => { disposed = true; removeListener(); };
  }, []);

  const handleGitSummaryChange = useCallback(({ changes, conflicts }: { changes: number; conflicts: number }) => {
    if (!activeSessionId) return;
    setGitSummary((current) => (
      current?.sessionId === activeSessionId && current.changes === changes && current.conflicts === conflicts
        ? current
        : { sessionId: activeSessionId, changes, conflicts }
    ));
  }, [activeSessionId]);

  useEffect(() => {
    let disposed = false;
    void window.fileTransferApi.list().then((tasks) => { if (!disposed) setFileTransfers(tasks); });
    const removeListener = window.fileTransferApi.onChanged(setFileTransfers);
    return () => { disposed = true; removeListener(); };
  }, []);

  useEffect(() => window.windowApi.onCloseRequested(() => {
    const hasActiveTransfers = fileTransfers.some((task) => task.status === "queued" || task.status === "running");
    if (!remoteFilesDirty && !hasActiveTransfers) {
      window.windowApi.resolveClose(true);
      return;
    }
    setShowCloseGuard(true);
  }), [fileTransfers, remoteFilesDirty]);

  const openProjectSearch = useCallback((mode: ProjectSearchMode, rootPath?: string) => {
    const activeSession = terminalSessions.activeSession;
    if (!activeSession) return;
    const currentPanelPath = filePanelPath?.sessionId === activeSession.id ? filePanelPath.path : null;
    setProjectSearchRoot(rootPath || currentPanelPath || activeSession.cwd || ".");
    setProjectSearchMode(mode);
    setWorkspaceTab("search");
  }, [filePanelPath, terminalSessions.activeSession]);

  const handleFilePanelPathChange = useCallback((path: string) => {
    if (activeSessionId) setFilePanelPath({ sessionId: activeSessionId, path });
  }, [activeSessionId]);

  useEffect(() => {
    let isDisposed = false;
    window.terminalApi.getConfig().then((config) => {
      if (!isDisposed) {
        setDebugMode(config.debugMode);
        setThemeId(config.themeId);
        onLocaleChange(normalizeLocale(config.locale));
        setRightToolsWidth(config.rightToolsWidth);
        setAgentOutputHistoryMaxEntries(config.listenerAgentHistoryMaxEntries);
        setAgentOutputMaxBytes(config.listenerAgentOutputMaxBytes);
      }
    });
    return () => {
      isDisposed = true;
    };
  }, [onLocaleChange]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeId;
  }, [themeId]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!terminalSessions.activeSession) {
        return;
      }
      const blockingOverlay = hasBlockingOverlay();
      if (projectSearchMode || blockingOverlay) {
        if ((debugMode || import.meta.env.DEV) && blockingOverlay) {
          const diagnostics = getBlockingOverlayDiagnostics();
          const signature = JSON.stringify(diagnostics);
          if (lastBlockingOverlaySignatureRef.current !== signature) {
            lastBlockingOverlaySignatureRef.current = signature;
            console.debug("[pannel-handle] keyboard shortcut blocked by overlay", diagnostics);
          }
        }
        return;
      }
      if (isEditableShortcutTarget(event.target)) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openProjectSearch("text");
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        openProjectSearch("files");
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (rightTool === "files" && remoteFilesDirty && !window.confirm(t("confirm.discardUnsavedFileChanges"))) {
          return;
        }
        setRightTool("git");
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [debugMode, openProjectSearch, projectSearchMode, remoteFilesDirty, rightTool, t, terminalSessions.activeSession]);

  useEffect(() => {
    if (gitSummary?.sessionId !== terminalSessions.activeSession?.id) {
      setGitSummary(null);
    }
  }, [gitSummary?.sessionId, terminalSessions.activeSession?.id]);

  useEffect(() => {
    if (!debugMode) {
      setHookDebugEvents([]);
      return undefined;
    }
    const removeHookListener = window.terminalApi.onAgentHookDebug((payload) => {
      setHookDebugEvents((current) => [...current, payload].slice(-300));
    });
    return () => {
      removeHookListener();
    };
  }, [debugMode]);

  const handleOpenCreateModal = useCallback(async () => {
    setShowCreateModal(true);
    const distros = await window.terminalApi.listWslDistros();
    setWslDistros(distros);
  }, []);

  const handleCreateSession = useCallback(async (request: CreateSessionRequest) => {
    if (remoteFilesDirty && !window.confirm(t("confirm.discardUnsavedFileChanges"))) {
      return;
    }
    await terminalSessions.createSession(request);
    setShowCreateModal(false);
  }, [remoteFilesDirty, terminalSessions, t]);

  const handleCloseSession = useCallback(async (id: string) => {
    if (id === terminalSessions.activeId && remoteFilesDirty && !window.confirm(t("confirm.discardUnsavedFileChanges"))) {
      return;
    }
    const closingSession = terminalSessions.sessions.find((session) => session.id === id);
    const hasActiveTransfer = fileTransfers.some((task) => task.sessionId === id && (task.status === "queued" || task.status === "running"));
    if (closingSession?.type === "ssh" && hasActiveTransfer && !window.confirm(t("files.closeSshTransfers"))) return;
    if (closingSession?.type === "ssh" && hasActiveTransfer) {
      await Promise.all(fileTransfers.filter((task) => task.sessionId === id && (task.status === "queued" || task.status === "running")).map((task) => window.fileTransferApi.cancel(task.id)));
    }
    await terminalSessions.closeSession(id);
    terminalInstances.disposeTerminal(id);
  }, [fileTransfers, remoteFilesDirty, terminalInstances, terminalSessions, t]);

  const handleSelectSession = useCallback((id: string) => {
    if (id === terminalSessions.activeId) {
      return;
    }
    const outgoingId = terminalSessions.activeId;
    if (outgoingId) {
      workspaceTabBySessionRef.current.set(outgoingId, workspaceTabRef.current);
    }
    const cached = workspaceTabBySessionRef.current.get(id);
    setWorkspaceTab(cached ?? "terminal");
    terminalSessions.setActiveId(id);
  }, [terminalSessions]);

  useEffect(() => {
    return window.terminalApi.onSessionSelectRequested(({ id }) => {
      if (terminalSessions.sessions.some((session) => session.id === id)) {
        handleSelectSession(id);
      }
    });
  }, [handleSelectSession, terminalSessions.sessions]);

  const handleLaunchSessions = useCallback(async (sessions: TerminalSession[]) => {
    if (remoteFilesDirty && !window.confirm(t("confirm.discardUnsavedFileChanges"))) {
      return;
    }
    await terminalSessions.launchSessions(sessions);
  }, [remoteFilesDirty, terminalSessions, t]);

  const handleStartFresh = useCallback(async () => {
    if (remoteFilesDirty && !window.confirm(t("confirm.discardUnsavedFileChanges"))) {
      return;
    }
    await terminalSessions.startFresh();
  }, [remoteFilesDirty, terminalSessions, t]);

  const handleRightToolChange = useCallback((tool: RightTool) => {
    if (tool !== "files" && remoteFilesDirty && !window.confirm(t("confirm.discardUnsavedFileChanges"))) {
      return;
    }
    setRightTool(tool);
  }, [remoteFilesDirty, t]);

  const handleSaveEdit = useCallback(async (id: string, title: string, cwd: string, initialCommand: string, agentProvider?: AgentProvider, quickCommands?: QuickCommand[], sshConfig?: SshConfig, tags?: string[]) => {
    await terminalSessions.updateSession(id, title, cwd, initialCommand, agentProvider, quickCommands, sshConfig, tags);
    setEditDialogSession(null);
  }, [terminalSessions]);

  const handleOpenSearchResult = useCallback((path: string) => {
    const activeSession = terminalSessions.activeSession;
    if (!activeSession) {
      return;
    }
    setRightTool("files");
    fileOpenRequestIdRef.current += 1;
    setFileOpenRequest({
      sessionId: activeSession.id,
      path,
      requestId: fileOpenRequestIdRef.current
    });
  }, [terminalSessions.activeSession]);

  const handleFileOpenRequestHandled = useCallback((requestId: number) => {
    setFileOpenRequest((current) => current?.requestId === requestId ? null : current);
  }, []);

  const handlePreviewTabsChange = useCallback((tabs: RemotePreviewTabSummary[]) => {
    setPreviewTabs(tabs);
    setActivePreviewTabId((current) => {
      if (current && tabs.some((tab) => tab.id === current)) {
        return current;
      }
      return tabs.at(-1)?.id ?? null;
    });
    setWorkspaceTab((current) => tabs.length === 0 && current === "preview" ? "terminal" : current);
  }, []);

  const handleActivePreviewTabChange = useCallback((tabId: string | null, fromRestore?: boolean) => {
    setActivePreviewTabId(tabId);
    if (!fromRestore) {
      setWorkspaceTab(tabId ? "preview" : "terminal");
    }
  }, []);

  const handleClosePreviewTab = useCallback((tabId: string) => {
    closePreviewRequestIdRef.current += 1;
    setClosePreviewRequest({ tabId, requestId: closePreviewRequestIdRef.current });
  }, []);

  const handleClosePreviewRequestHandled = useCallback((requestId: number) => {
    setClosePreviewRequest((current) => current?.requestId === requestId ? null : current);
  }, []);

  const handleClosePicker = useCallback(() => {
    terminalSessions.setPendingSessions(null);
    terminalSessions.setPickerManual(false);
  }, [terminalSessions]);

  const handleEditFromPicker = useCallback((session: TerminalSession) => {
    handleClosePicker();
    setEditDialogSession(session);
  }, [handleClosePicker]);

  const handleToggleDebugMode = useCallback(async () => {
    const config = await window.terminalApi.getConfig();
    const next = !config.debugMode;
    await window.terminalApi.setConfig({ debugMode: next });
    setDebugMode(next);
  }, []);

  const handleThemeChange = useCallback(async (nextThemeId: ThemeId) => {
    const config = await window.terminalApi.setConfig({ themeId: nextThemeId });
    setThemeId(config.themeId);
  }, []);

  const handleLocaleChange = useCallback(async (nextLocale: Locale) => {
    const config = await window.terminalApi.setConfig({ locale: nextLocale });
    onLocaleChange(normalizeLocale(config.locale));
  }, [onLocaleChange]);

  const handleAgentOutputHistoryChange = useCallback(async (maxEntries: number, maxOutputBytes: number) => {
    const config = await window.terminalApi.setConfig({
      listenerAgentHistoryMaxEntries: maxEntries,
      listenerAgentOutputMaxBytes: maxOutputBytes
    });
    setAgentOutputHistoryMaxEntries(config.listenerAgentHistoryMaxEntries);
    setAgentOutputMaxBytes(config.listenerAgentOutputMaxBytes);
  }, []);

  useEffect(() => {
    if (!terminalSessions.activeSession) {
      setRightTool(debugMode ? "debug" : "files");
      return;
    }
    if (!debugMode && rightTool === "debug") {
      setRightTool("files");
      return;
    }
  }, [debugMode, rightTool, terminalSessions.activeSession]);

  const showFilesPanel = Boolean(terminalSessions.activeSession);
  const showRightTools = showFilesPanel || debugMode;
  const activeRightTool: RightTool = showFilesPanel && (debugMode || rightTool !== "debug")
    ? rightTool
    : debugMode
      ? "debug"
      : "files";
  const appShellColumns = debugMode
    ? `${sidebarWidth}px 1px minmax(0, 1fr) 1px ${liveRightToolsWidth}px`
    : showRightTools
      ? `${sidebarWidth}px 1px minmax(0, 1fr) 1px ${liveRightToolsWidth}px`
    : `${sidebarWidth}px 1px minmax(0, 1fr)`;

  return (
    <>
      <div className="app-frame">
        <TitleBar activeTitle={terminalSessions.activeSession?.title} isMaximized={isMaximized} mobileAccessState={mobileAccessState} onOpenSettings={() => setShowSettingsModal(true)} />
        {terminalSessions.startupError && (
          <div className="startup-error-banner" role="alert">
            <span>{terminalSessions.startupError}</span>
            <button type="button" onClick={terminalSessions.clearStartupError} aria-label={t("common.close")}>×</button>
          </div>
        )}

        <main className="app-shell" style={{ gridTemplateColumns: appShellColumns }}>
          <SessionSidebar
            sessions={terminalSessions.sessions}
            activeId={terminalSessions.activeId}
            showInstanceIds={debugMode}
            agentStatusesBySessionId={terminalSessions.agentStatusesBySessionId}
            onSelectSession={handleSelectSession}
            onEditSession={setEditDialogSession}
            onInstallHooks={setHookInstallSession}
            onCloseSession={handleCloseSession}
            onOpenPicker={terminalSessions.openPicker}
            onOpenCreate={handleOpenCreateModal}
            onReorder={terminalSessions.reorderRunningSessions}
          />

          <div className="splitter" onMouseDown={handleSplitterMouseDown} />

          <div className="workspace-area">
            <div className="workspace-tabs" role="tablist" aria-label={t("tabs.workspace")}>
              <button
                className={`workspace-tab ${workspaceTab === "terminal" ? "active" : ""}`}
                type="button"
                role="tab"
                aria-selected={workspaceTab === "terminal"}
                onClick={() => setWorkspaceTab("terminal")}
              >
                <TerminalIcon aria-hidden="true" />
                <span>{t("tabs.terminal")}</span>
              </button>
              {previewTabs.map((tab) => (
                <div
                  className={`workspace-tab file-tab ${workspaceTab === "preview" && activePreviewTabId === tab.id ? "active" : ""}`}
                  role="tab"
                  tabIndex={0}
                  aria-selected={workspaceTab === "preview" && activePreviewTabId === tab.id}
                  title={tab.path}
                  key={tab.id}
                  onClick={() => handleActivePreviewTabChange(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleActivePreviewTabChange(tab.id);
                    }
                  }}
                >
                  <FileText aria-hidden="true" />
                  <span>{tab.fileName}</span>
                  {tab.dirty && <strong className="workspace-tab-dirty" title={t("files.unsavedMarker")}>*</strong>}
                  <button
                    className="workspace-tab-close"
                    type="button"
                    title={t("files.closePreview")}
                    aria-label={t("files.closePreview")}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleClosePreviewTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        handleClosePreviewTab(tab.id);
                      }
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
              {projectSearchMode && (
                <div className={`workspace-tab file-tab ${workspaceTab === "search" ? "active" : ""}`} role="tab" tabIndex={0} aria-selected={workspaceTab === "search"} onClick={() => setWorkspaceTab("search")}>
                  <Search aria-hidden="true" />
                  <span>{t("files.searchProject")}</span>
                  <button className="workspace-tab-close" type="button" title={t("projectSearch.close")} onClick={(event) => { event.stopPropagation(); setProjectSearchMode(null); setWorkspaceTab(activePreviewTabId ? "preview" : "terminal"); }}><X aria-hidden="true" /></button>
                </div>
              )}
              {fileTransfers.length > 0 && (
                <div className={`workspace-tab file-tab ${workspaceTab === "transfers" ? "active" : ""}`} role="tab" tabIndex={0} aria-selected={workspaceTab === "transfers"} onClick={() => setWorkspaceTab("transfers")}>
                  <ArrowDownToLine aria-hidden="true" />
                  <span>{t("files.transfers")}</span>
                  <strong className="workspace-tab-dirty">{fileTransfers.filter((task) => task.status === "queued" || task.status === "running").length || ""}</strong>
                </div>
              )}
            </div>
            <div className="workspace-content">
              <div className="terminal-area" style={{ display: workspaceTab === "terminal" ? undefined : "none" }}>
                <TerminalPanel
                  sessions={terminalSessions.sessions}
                  activeId={terminalSessions.activeId}
                  hostRefs={terminalInstances.terminalHostRefs}
                  onContextMenu={terminalInstances.handleTerminalContextMenu}
                  onWheel={terminalInstances.handleTerminalWheel}
                  sizeOwner={terminalInstances.activeSizeOwner}
                  onClaimSize={terminalInstances.claimActiveSize}
                />
                <TerminalComposer session={terminalSessions.activeSession} />
                {(terminalSessions.activeId != null || remoteSystemMetrics.status !== "hidden") && (
                  <footer className="terminal-footer">
                    <QuickCommandBar
                      quickCommands={terminalSessions.quickCommandsForActiveSession}
                      activeSessionId={terminalSessions.activeId}
                      onFocusTerminal={terminalInstances.focusActiveTerminal}
                      onAddQuickCommand={terminalSessions.addQuickCommandToActiveSession}
                      onRemoveQuickCommand={terminalSessions.removeQuickCommandFromActiveSession}
                    />
                    <div className="terminal-status-cluster">
                      <AgentUsageStatus state={agentUsage.state} onRefresh={agentUsage.refresh} />
                      <RemoteSystemStatus state={remoteSystemMetrics} />
                    </div>
                  </footer>
                )}
              </div>
              <div
                className="workspace-preview"
                ref={setPreviewHost}
                style={{ display: workspaceTab === "preview" ? undefined : "none" }}
              />
              {projectSearchMode && terminalSessions.activeSession && (
                <div className="workspace-search" style={{ display: workspaceTab === "search" ? undefined : "none" }}>
                  <ProjectSearchModal
                    embedded
                    mode={projectSearchMode}
                    initialRoot={projectSearchRoot}
                    session={terminalSessions.activeSession}
                    onClose={() => { setProjectSearchMode(null); setWorkspaceTab(activePreviewTabId ? "preview" : "terminal"); }}
                    onOpenPath={handleOpenSearchResult}
                  />
                </div>
              )}
              {fileTransfers.length > 0 && (
                <div className="workspace-search" style={{ display: workspaceTab === "transfers" ? undefined : "none" }}>
                  <FileTransferPanel tasks={fileTransfers} sessions={terminalSessions.sessions} />
                </div>
              )}
            </div>
          </div>

          {showRightTools && (
            <>
              <div className="splitter" onMouseDown={handleRightSplitterMouseDown} />
              <aside className="right-tools">
              {(showFilesPanel || debugMode) && (
                <div className="right-tool-tabs" role="tablist" aria-label="Right sidebar tools">
                  {showFilesPanel && (
                    <>
                      <button
                        className={activeRightTool === "files" ? "active" : ""}
                        type="button"
                        role="tab"
                        aria-selected={activeRightTool === "files"}
                        onClick={() => handleRightToolChange("files")}
                      >
                        {t("tabs.files")}
                      </button>
                      <button
                        className={activeRightTool === "git" ? "active" : ""}
                        type="button"
                        role="tab"
                        aria-selected={activeRightTool === "git"}
                        onClick={() => handleRightToolChange("git")}
                      >
                        <span>{t("tabs.git")}</span>
                        {gitSummary && gitSummary.sessionId === terminalSessions.activeSession?.id && gitSummary.changes > 0 && (
                          <strong className={`right-tool-badge ${gitSummary.conflicts > 0 ? "conflict" : ""}`} title={`${gitSummary.changes} changes, ${gitSummary.conflicts} conflicts`}>
                            {gitSummary.conflicts > 0 ? `!${gitSummary.conflicts}` : gitSummary.changes}
                          </strong>
                        )}
                      </button>
                    </>
                  )}
                  {debugMode && (
                    <button
                      className={activeRightTool === "debug" ? "active" : ""}
                      type="button"
                      role="tab"
                      aria-selected={activeRightTool === "debug"}
                      onClick={() => handleRightToolChange("debug")}
                    >
                      {t("tabs.debug")}
                    </button>
                  )}
                </div>
              )}
              {activeRightTool === "files" && showFilesPanel ? (
                <RemoteFilePanel
                  session={terminalSessions.activeSession}
                  openRequest={fileOpenRequest}
                  closePreviewRequest={closePreviewRequest}
                  previewHost={previewHost}
                  activePreviewTabId={activePreviewTabId}
                  onOpenRequestHandled={handleFileOpenRequestHandled}
                  onClosePreviewRequestHandled={handleClosePreviewRequestHandled}
                  onDirtyChange={setRemoteFilesDirty}
                  onPreviewTabsChange={handlePreviewTabsChange}
                  onActivePreviewTabChange={handleActivePreviewTabChange}
                  onCurrentPathChange={handleFilePanelPathChange}
                  onSearchRequest={openProjectSearch}
                  onFocusTerminal={terminalInstances.focusActiveTerminal}
                  transfers={fileTransfers}
                  onShowTransfers={() => setWorkspaceTab("transfers")}
                  onRegisterSaveAll={(handler) => { saveAllRemoteFilesRef.current = handler; }}
                />
              ) : activeRightTool === "git" && showFilesPanel ? (
                <GitStatusPanel
                  session={terminalSessions.activeSession}
                  onSummaryChange={handleGitSummaryChange}
                />
              ) : (
                <DebugSidebar
                  events={hookDebugEvents}
                  sessions={terminalSessions.sessions}
                  onClear={() => setHookDebugEvents([])}
                />
              )}
            </aside>
            </>
          )}
        </main>
      </div>

      {showCreateModal && (
        <CreateSessionModal
          wslDistros={wslDistros}
          tagSuggestions={terminalSessions.tagSuggestions}
          onCreate={handleCreateSession}
          onCancel={() => setShowCreateModal(false)}
        />
      )}

      {editDialogSession && (
        <EditSessionModal
          session={editDialogSession}
          tagSuggestions={terminalSessions.tagSuggestions}
          onSave={handleSaveEdit}
          onCancel={() => setEditDialogSession(null)}
        />
      )}

      {hookInstallSession && (
        <HookInstallModal
          session={hookInstallSession}
          onCancel={() => setHookInstallSession(null)}
        />
      )}

      {terminalSessions.pendingSessions !== null && (
        <SessionPickerModal
          pendingSessions={terminalSessions.pendingSessions}
          runningSessions={terminalSessions.sessions}
          pickerManual={terminalSessions.pickerManual}
          onLaunch={handleLaunchSessions}
          onStartFresh={handleStartFresh}
          onDelete={terminalSessions.deleteFromLibrary}
          onDuplicate={terminalSessions.duplicateFromLibrary}
          onEdit={handleEditFromPicker}
          onImport={terminalSessions.importLibrary}
          onExport={terminalSessions.exportLibrary}
          launchTemplates={terminalSessions.launchTemplates}
          onCreateLaunchTemplate={terminalSessions.createLaunchTemplate}
          onUpdateLaunchTemplate={terminalSessions.updateLaunchTemplate}
          onDeleteLaunchTemplate={terminalSessions.deleteLaunchTemplate}
          onLaunchTemplate={terminalSessions.launchLaunchTemplate}
          onCancel={handleClosePicker}
        />
      )}

      {showSettingsModal && (
        <SettingsModal
          autoRestore={terminalSessions.autoRestore}
          debugMode={debugMode}
          themeId={themeId}
          locale={locale}
          themes={APP_THEMES}
          agentOutputHistoryMaxEntries={agentOutputHistoryMaxEntries}
          agentOutputMaxBytes={agentOutputMaxBytes}
          onToggleAutoRestore={terminalSessions.toggleAutoRestore}
          onToggleDebugMode={handleToggleDebugMode}
          onThemeChange={handleThemeChange}
          onLocaleChange={handleLocaleChange}
          onSaveAgentOutputHistory={handleAgentOutputHistoryChange}
          onCancel={() => setShowSettingsModal(false)}
        />
      )}

      {showCloseGuard && (
        <div className="modal-overlay">
          <div className="file-operation-dialog close-guard-dialog">
            <h2>{t("files.closeGuardTitle")}</h2>
            {previewTabs.some((tab) => tab.dirty) && (
              <div><strong>{t("files.unsavedFiles")}</strong><ul>{previewTabs.filter((tab) => tab.dirty).map((tab) => <li key={tab.id}>{tab.fileName}</li>)}</ul></div>
            )}
            {fileTransfers.some((task) => task.status === "queued" || task.status === "running") && <p>{t("files.activeTransfersExit")}</p>}
            <div className="file-operation-actions">
              <button type="button" onClick={() => { setShowCloseGuard(false); window.windowApi.resolveClose(false); }}>{t("common.cancel")}</button>
              <button type="button" onClick={() => window.windowApi.resolveClose(true)}>{t("files.discardAndExit")}</button>
              {remoteFilesDirty && <button type="button" onClick={async () => { const saved = await saveAllRemoteFilesRef.current?.(); if (saved) window.windowApi.resolveClose(true); }}>{t("files.saveAllAndExit")}</button>}
            </div>
          </div>
        </div>
      )}

    </>
  );
}

export function App() {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  return (
    <I18nProvider locale={locale}>
      <AppContent locale={locale} onLocaleChange={setLocale} />
    </I18nProvider>
  );
}
