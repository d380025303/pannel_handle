import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Terminal as TerminalIcon, X } from "lucide-react";
import { SettingsModal } from "./components/settings/SettingsModal";
import { CreateSessionModal } from "./components/sessions/CreateSessionModal";
import { DebugSidebar } from "./components/agents/DebugSidebar";
import { EditSessionModal } from "./components/sessions/EditSessionModal";
import { GitStatusPanel } from "./components/git/GitStatusPanel";
import { ListenerAgentPanel } from "./components/agents/ListenerAgentPanel";
import { HookInstallModal } from "./components/agents/HookInstallModal";
import { SessionPickerModal } from "./components/sessions/SessionPickerModal";
import { SessionSidebar } from "./components/sessions/SessionSidebar";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { TerminalComposer } from "./components/terminal/TerminalComposer";
import { CompletionDebugSidebar } from "./components/terminal/CompletionDebugSidebar";
import { mergeCompletionDebugEvent, type CompletionDebugEntry } from "./components/terminal/completionDebug";
import { QuickCommandBar } from "./components/terminal/QuickCommandBar";
import { ProjectSearchModal } from "./components/remote/ProjectSearchModal";
import { RemoteFilePanel, type RemotePreviewTabSummary } from "./components/remote/RemoteFilePanel";
import { RemoteSystemStatus } from "./components/remote/RemoteSystemStatus";
import { TitleBar } from "./components/app/TitleBar";
import { useRemoteSystemMetrics } from "./hooks/useRemoteSystemMetrics";
import { useRightToolsResize } from "./hooks/useRightToolsResize";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useTerminalInstances } from "./hooks/useTerminalInstances";
import { useTerminalSessions } from "./hooks/useTerminalSessions";
import { useWindowState } from "./hooks/useWindowState";
import { DEFAULT_LOCALE, I18nProvider, normalizeLocale, useI18n } from "./i18n";
import { APP_THEMES, DEFAULT_THEME_ID, getAppTheme } from "./themes";
import type { CreateSessionRequest } from "./components/sessions/CreateSessionModal";
import type { AgentHookDebugPayload, AgentProvider, Locale, QuickCommand, SshConfig, TerminalSession, ThemeId } from "./vite-env";

type ProjectSearchMode = "files" | "text";
type RightTool = "files" | "git" | "agents" | "debug" | "completionDebug";
type WorkspaceTab = "terminal" | "preview";

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
  const [rightTool, setRightTool] = useState<RightTool>("files");
  const [rightToolsWidth, setRightToolsWidth] = useState(380);
  const [hookDebugEvents, setHookDebugEvents] = useState<AgentHookDebugPayload[]>([]);
  const [completionDebugEntries, setCompletionDebugEntries] = useState<CompletionDebugEntry[]>([]);
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
  const fileOpenRequestIdRef = useRef(0);
  const closePreviewRequestIdRef = useRef(0);
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
  const remoteSystemMetrics = useRemoteSystemMetrics(terminalSessions.activeSession);
  const activeTheme = getAppTheme(themeId);
  const terminalInstances = useTerminalInstances({
    activeId: terminalSessions.activeId,
    isVisible: workspaceTab === "terminal",
    terminalTheme: activeTheme.terminal
  });
  const canSearchProject = Boolean(terminalSessions.activeSession && terminalSessions.activeSession.type !== "ssh");
  const activeSessionId = terminalSessions.activeSession?.id;

  const openProjectSearch = useCallback((mode: ProjectSearchMode, rootPath?: string) => {
    const activeSession = terminalSessions.activeSession;
    if (!activeSession || activeSession.type === "ssh") return;
    const currentPanelPath = filePanelPath?.sessionId === activeSession.id ? filePanelPath.path : null;
    setProjectSearchRoot(rootPath || currentPanelPath || activeSession.cwd || ".");
    setProjectSearchMode(mode);
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
      if (!terminalSessions.activeSession || terminalSessions.activeSession.type === "ssh") {
        return;
      }
      if (projectSearchMode || hasBlockingOverlay()) {
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
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [openProjectSearch, projectSearchMode, terminalSessions.activeSession]);

  useEffect(() => {
    if (!debugMode) {
      setHookDebugEvents([]);
      setCompletionDebugEntries([]);
      return undefined;
    }
    const removeHookListener = window.terminalApi.onAgentHookDebug((payload) => {
      setHookDebugEvents((current) => [...current, payload].slice(-300));
    });
    const removeCompletionListener = window.completionApi.onDebugEvent((payload) => {
      setCompletionDebugEntries((current) => mergeCompletionDebugEvent(current, payload));
    });
    return () => {
      removeHookListener();
      removeCompletionListener();
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
    await terminalSessions.closeSession(id);
    terminalInstances.disposeTerminal(id);
  }, [remoteFilesDirty, terminalInstances, terminalSessions, t]);

  const handleSelectSession = useCallback((id: string) => {
    if (id === terminalSessions.activeId) {
      return;
    }
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
    if (!activeSession || activeSession.type === "ssh") {
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

  const handleActivePreviewTabChange = useCallback((tabId: string | null) => {
    setActivePreviewTabId(tabId);
    setWorkspaceTab(tabId ? "preview" : "terminal");
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

  useEffect(() => {
    if (!terminalSessions.activeSession) {
      setRightTool(debugMode ? "debug" : "files");
      return;
    }
    if (!debugMode && (rightTool === "debug" || rightTool === "completionDebug")) {
      setRightTool("files");
      return;
    }
  }, [debugMode, rightTool, terminalSessions.activeSession]);

  const showFilesPanel = Boolean(terminalSessions.activeSession);
  const showRightTools = showFilesPanel || debugMode;
  const activeRightTool: RightTool = showFilesPanel && (debugMode || (rightTool !== "debug" && rightTool !== "completionDebug"))
    ? rightTool
    : debugMode
      ? rightTool === "completionDebug" ? "completionDebug" : "debug"
      : "files";
  const appShellColumns = debugMode
    ? `${sidebarWidth}px 1px minmax(0, 1fr) 1px ${liveRightToolsWidth}px`
    : showRightTools
      ? `${sidebarWidth}px 1px minmax(0, 1fr) 1px ${liveRightToolsWidth}px`
    : `${sidebarWidth}px 1px minmax(0, 1fr)`;

  return (
    <>
      <div className="app-frame">
        <TitleBar activeTitle={terminalSessions.activeSession?.title} isMaximized={isMaximized} onOpenSettings={() => setShowSettingsModal(true)} />
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
            </div>
            <div className="workspace-content">
              <div className="terminal-area" style={{ display: workspaceTab === "terminal" ? undefined : "none" }}>
                <TerminalPanel
                  sessions={terminalSessions.sessions}
                  activeId={terminalSessions.activeId}
                  hostRefs={terminalInstances.terminalHostRefs}
                  onContextMenu={terminalInstances.handleTerminalContextMenu}
                  onWheel={terminalInstances.handleTerminalWheel}
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
                    <RemoteSystemStatus state={remoteSystemMetrics} />
                  </footer>
                )}
              </div>
              <div
                className="workspace-preview"
                ref={setPreviewHost}
                style={{ display: workspaceTab === "preview" ? undefined : "none" }}
              />
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
                        {t("tabs.git")}
                      </button>
                      <button
                        className={activeRightTool === "agents" ? "active" : ""}
                        type="button"
                        role="tab"
                        aria-selected={activeRightTool === "agents"}
                        onClick={() => handleRightToolChange("agents")}
                      >
                        {locale === "zh-CN" ? "Agent" : "Agents"}
                      </button>
                    </>
                  )}
                  {debugMode && (
                    <>
                      <button
                        className={activeRightTool === "debug" ? "active" : ""}
                        type="button"
                        role="tab"
                        aria-selected={activeRightTool === "debug"}
                        onClick={() => handleRightToolChange("debug")}
                      >
                        {t("tabs.debug")}
                      </button>
                      <button
                        className={activeRightTool === "completionDebug" ? "active" : ""}
                        type="button"
                        role="tab"
                        aria-selected={activeRightTool === "completionDebug"}
                        onClick={() => handleRightToolChange("completionDebug")}
                      >
                        {t("tabs.completionDebug")}
                      </button>
                    </>
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
                />
              ) : activeRightTool === "git" && showFilesPanel ? (
                <GitStatusPanel session={terminalSessions.activeSession} />
              ) : activeRightTool === "agents" && showFilesPanel ? (
                <ListenerAgentPanel session={terminalSessions.activeSession!} />
              ) : activeRightTool === "completionDebug" ? (
                <CompletionDebugSidebar
                  entries={completionDebugEntries}
                  sessions={terminalSessions.sessions}
                  onClear={() => setCompletionDebugEntries([])}
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
          onReorder={terminalSessions.reorderLibrary}
          onImport={terminalSessions.importLibrary}
          onExport={terminalSessions.exportLibrary}
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
          onToggleAutoRestore={terminalSessions.toggleAutoRestore}
          onToggleDebugMode={handleToggleDebugMode}
          onThemeChange={handleThemeChange}
          onLocaleChange={handleLocaleChange}
          onCancel={() => setShowSettingsModal(false)}
        />
      )}

      {projectSearchMode && terminalSessions.activeSession && canSearchProject && (
        <ProjectSearchModal
          mode={projectSearchMode}
          initialRoot={projectSearchRoot}
          session={terminalSessions.activeSession}
          onClose={() => setProjectSearchMode(null)}
          onOpenPath={handleOpenSearchResult}
        />
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
