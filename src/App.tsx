import type { EnvironmentSelection } from "./vite-env";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { ArrowDownToLine, FileText, MessageSquare, Search, Terminal as TerminalIcon, X } from "lucide-react";
import { SettingsModal } from "./components/settings/SettingsModal";
import { CreateSessionModal } from "./components/sessions/CreateSessionModal";
import { DebugSidebar } from "./components/agents/DebugSidebar";
import { AgentUsageStatus } from "./components/agents/AgentUsageStatus";
import { AgentTokenLiveStatus } from "./components/agents/AgentTokenLiveStatus";
import { CodeBuddyContextUsage } from "./components/agents/CodeBuddyContextUsage";
import { AgentSwitcher } from "./components/agents/AgentSwitcher";
import { SessionModeSwitch } from "./components/agents/SessionModeSwitch";
import { AgentTokenStatsDashboard } from "./components/agents/AgentTokenStatsDashboard";
import { AgentConversationPanel } from "./components/agents/AgentConversationPanel";
import type { CodexAppServerSessionHandle } from "./components/agents/CodexAppServerSession";
import { GraphicalSessionPanel } from "./components/agents/GraphicalSessionPanel";
import type { CodexCapabilityReference } from "./vite-env";
import { ProjectAssistantPage } from "./components/agents/ProjectAssistantPage";
import { RemoteAgentApprovalCard } from "./components/agents/RemoteAgentApprovalCard";
import { CodexWorkspaceTrustDialog } from "./components/agents/CodexWorkspaceTrustDialog";
import { EditSessionModal } from "./components/sessions/EditSessionModal";
import { GitStatusPanel } from "./components/git/GitStatusPanel";
import { IdeaRunPanel } from "./components/idea/IdeaRunPanel";
import { HookInstallModal } from "./components/agents/HookInstallModal";
import { SessionPickerModal } from "./components/sessions/SessionPickerModal";
import { SessionSidebar } from "./components/sessions/SessionSidebar";
import { getAgentProviderLabel } from "./components/sessions/agentProviders";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { SessionShellPanel } from "./components/terminal/SessionShellPanel";
import { TerminalComposer } from "./components/terminal/TerminalComposer";
import { QuickCommandBar } from "./components/terminal/QuickCommandBar";
import { ProjectSearchModal } from "./components/remote/ProjectSearchModal";
import { FileTransferPanel } from "./components/remote/FileTransferPanel";
import { RemoteFilePanel, type RemoteFilePanelNavigationState, type RemotePreviewTabSummary } from "./components/remote/RemoteFilePanel";
import { resolveCodexFileLink } from "./utils/codexFileLink";
import { RemoteSystemStatus } from "./components/remote/RemoteSystemStatus";
import { RemoteSystemPanel } from "./components/remote/RemoteSystemPanel";
import { TitleBar } from "./components/app/TitleBar";
import { DEFAULT_TITLE_BAR_ACTION_ORDER, withSettingsAction } from "./components/app/titleBarActions";
import type { TitleBarActionId } from "./components/app/titleBarActions";
import { SkillsManager } from "./components/skills/SkillsManager";
import { McpManager } from "./components/mcp/McpManager";
import { useRemoteSystemMetrics } from "./hooks/useRemoteSystemMetrics";
import { useAgentUsage } from "./hooks/useAgentUsage";
import { useAgentTokenLive } from "./hooks/useAgentTokenLive";
import { useCodexAppServerFooter } from "./hooks/useCodexAppServerFooter";
import { useAgentConversation } from "./hooks/useAgentConversation";
import { useRightToolsResize } from "./hooks/useRightToolsResize";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useTerminalInstances } from "./hooks/useTerminalInstances";
import { useTerminalSessions } from "./hooks/useTerminalSessions";
import { resolveRightTool, useSessionRightTool, type RightTool } from "./hooks/useSessionRightTool";
import { useWindowState } from "./hooks/useWindowState";
import { useInputRecovery } from "./hooks/inputRecovery";
import { DEFAULT_LOCALE, I18nProvider, normalizeLocale, useI18n } from "./i18n";
import { APP_THEMES, DEFAULT_THEME_ID, getAppTheme } from "./themes";
import { DEFAULT_SCREENSHOT_SHORTCUT, matchesScreenshotShortcut } from "./utils/screenshotShortcut";
import { getTerminalBackgroundUrl } from "./utils/terminalBackground";
import type { CreateSessionRequest } from "./components/sessions/CreateSessionModal";
import type { AgentHookDebugPayload, AgentLocation, AgentProvider, AgentModelSource, CodexBackend, FileTransferTask, Locale, MobileAccessState, QuickCommand, SshConfig, TerminalSession, ThemeId } from "./vite-env";

type ProjectSearchMode = "files" | "text";
type WorkspaceTab = "terminal" | "session-shell" | "preview" | "search" | "transfers";
const emptyDraftReferences: CodexCapabilityReference[] = [];

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
  return Array.from(document.querySelectorAll<HTMLElement>(
    ".modal-overlay, .remote-preview-overlay, .git-diff-overlay, .git-stash-overlay, .project-search-overlay"
  )).some(overlay => !overlay.closest('[aria-hidden="true"]'));
}

function getBlockingOverlayDiagnostics() {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(
    ".modal-overlay, .remote-preview-overlay, .git-diff-overlay, .git-stash-overlay, .project-search-overlay"
  )).filter(overlay => !overlay.closest('[aria-hidden="true"]'));
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
  const [quickAgentError, setQuickAgentError] = useState<string | null>(null);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [editDialogSession, setEditDialogSession] = useState<TerminalSession | null>(null);
  const [hookInstallSession, setHookInstallSession] = useState<TerminalSession | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showTokenStats, setShowTokenStats] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showProjectAssistant, setShowProjectAssistant] = useState(false);
  const [showIdea, setShowIdea] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [screenshotEnabled, setScreenshotEnabled] = useState(true);
  const [screenshotShortcut, setScreenshotShortcut] = useState(DEFAULT_SCREENSHOT_SHORTCUT);
  const [titleBarActionOrder, setTitleBarActionOrder] = useState<TitleBarActionId[]>(DEFAULT_TITLE_BAR_ACTION_ORDER);
  const [titleBarHiddenActions, setTitleBarHiddenActions] = useState<TitleBarActionId[]>([]);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [autoWorkBuddyCheckin, setAutoWorkBuddyCheckin] = useState(true);
  const [autoCollapseFileChains, setAutoCollapseFileChains] = useState(true);
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [savedSidebarWidth, setSavedSidebarWidth] = useState(290);
  const [rightToolsWidth, setRightToolsWidth] = useState(380);
  const [terminalBackgroundImage, setTerminalBackgroundImage] = useState("");
  const [terminalBackgroundOpacity, setTerminalBackgroundOpacity] = useState(40);
  const [terminalBackgroundBlur, setTerminalBackgroundBlur] = useState(0);
  const [terminalBackgroundPositionX, setTerminalBackgroundPositionX] = useState(50);
  const [terminalBackgroundPositionY, setTerminalBackgroundPositionY] = useState(50);
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const [terminalBackgroundAreaSize, setTerminalBackgroundAreaSize] = useState<{ width: number; height: number } | null>(null);
  const savedTerminalBackgroundPosition = useRef({ x: 50, y: 50 });
  const [hookDebugEvents, setHookDebugEvents] = useState<AgentHookDebugPayload[]>([]);
  const [remoteFilesDirty, setRemoteFilesDirty] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("terminal");
  const [openedShellIds, setOpenedShellIds] = useState<Set<string>>(() => new Set());
  const [previewTabs, setPreviewTabs] = useState<RemotePreviewTabSummary[]>([]);
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null);
  const [closePreviewRequest, setClosePreviewRequest] = useState<{ tabId: string; requestId: number } | null>(null);
  const [previewHost, setPreviewHost] = useState<HTMLDivElement | null>(null);
  const [projectSearchMode, setProjectSearchMode] = useState<ProjectSearchMode | null>(null);
  const [projectSearchRoot, setProjectSearchRoot] = useState(".");
  const [filePanelPath, setFilePanelPath] = useState<{ sessionId: string; path: string } | null>(null);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ sessionId: string; path: string; line?: number; requestId: number } | null>(null);
  const [appServerLinkError, setAppServerLinkError] = useState<string | null>(null);
  const [fileTransfers, setFileTransfers] = useState<FileTransferTask[]>([]);
  const [gitSummary, setGitSummary] = useState<{ sessionId: string; changes: number; conflicts: number } | null>(null);
  const [showCloseGuard, setShowCloseGuard] = useState(false);
  const [mobileAccessState, setMobileAccessState] = useState<MobileAccessState | null>(null);
  const [appServerDrafts, setAppServerDrafts] = useState<Record<string, string>>({});
  const [appServerDraftReferences, setAppServerDraftReferences] = useState<Record<string, CodexCapabilityReference[]>>({});
  const fileOpenRequestIdRef = useRef(0);
  const closePreviewRequestIdRef = useRef(0);
  const saveAllRemoteFilesRef = useRef<(() => Promise<boolean>) | null>(null);
  const saveMcpRef = useRef<(() => Promise<boolean>) | null>(null);
  const lastBlockingOverlaySignatureRef = useRef("");
  const appServerSessionRefs = useRef(new Map<string, CodexAppServerSessionHandle>());
  const appServerSessionIdsRef = useRef(new Set<string>());
  const workspaceTabBySessionRef = useRef(new Map<string, WorkspaceTab>());
  const filePanelNavigationBySessionRef = useRef(new Map<string, RemoteFilePanelNavigationState>());
  const workspaceTabRef = useRef<WorkspaceTab>("terminal");
  workspaceTabRef.current = workspaceTab;
  const { isMaximized } = useWindowState();
  const { sidebarWidth, handleSplitterMouseDown } = useSidebarResize(
    savedSidebarWidth,
    (width) => {
      setSavedSidebarWidth(width);
      window.terminalApi.setConfig({ sidebarWidth: width });
    }
  );
  const { rightToolsWidth: liveRightToolsWidth, handleSplitterMouseDown: handleRightSplitterMouseDown } = useRightToolsResize(
    rightToolsWidth,
    (w) => {
      setRightToolsWidth(w);
      window.terminalApi.setConfig({ rightToolsWidth: w });
    }
  );
  const terminalSessions = useTerminalSessions();
  appServerSessionIdsRef.current = new Set(terminalSessions.sessions.map((session) => session.id));
  const { rightTool, setRightTool } = useSessionRightTool(
    terminalSessions.activeId,
    terminalSessions.sessions.map((session) => session.id)
  );
  const agentConversation = useAgentConversation(terminalSessions.activeId, rightTool === "conversation");
  const agentUsage = useAgentUsage(terminalSessions.activeSession, terminalSessions.activeAgentStatus);
  const agentTokenLive = useAgentTokenLive(terminalSessions.activeSession?.runtimeMode === "app-server"
    && terminalSessions.activeSession.agentProvider !== "codebuddy" ? undefined : terminalSessions.activeSession);
  const remoteSystemMetrics = useRemoteSystemMetrics(
    terminalSessions.activeSession,
    terminalSessions.sessions.map((session) => session.id)
  );
  const activeTheme = getAppTheme(themeId);
  const isAppServerSession = terminalSessions.activeSession?.runtimeMode === "app-server";
  const appServerFooter = useCodexAppServerFooter(isAppServerSession ? terminalSessions.activeId : undefined);
  const activeTerminalId = isAppServerSession ? undefined : terminalSessions.activeId;
  useEffect(() => {
    if (workspaceTab === "session-shell" && (!isAppServerSession || !terminalSessions.activeId || !openedShellIds.has(terminalSessions.activeId))) {
      setWorkspaceTab("terminal");
    }
  }, [workspaceTab, isAppServerSession, terminalSessions.activeId, openedShellIds]);
  const terminalTheme = useMemo(() => (
    terminalBackgroundImage
      ? { ...activeTheme.terminal, background: "#00000000" }
      : activeTheme.terminal
  ), [activeTheme, terminalBackgroundImage]);
  const terminalBackground = useMemo(() => {
    const imageUrl = getTerminalBackgroundUrl(terminalBackgroundImage);
    return imageUrl
      ? { imageUrl, opacity: terminalBackgroundOpacity, blur: terminalBackgroundBlur, positionX: terminalBackgroundPositionX, positionY: terminalBackgroundPositionY }
      : undefined;
  }, [terminalBackgroundImage, terminalBackgroundOpacity, terminalBackgroundBlur, terminalBackgroundPositionX, terminalBackgroundPositionY]);
  useLayoutEffect(() => {
    if (!showSettingsModal || !terminalAreaRef.current) return;
    const area = terminalAreaRef.current;
    const updateSize = () => {
      const { width, height } = area.getBoundingClientRect();
      if (width > 0 && height > 0) {
        setTerminalBackgroundAreaSize(current => current?.width === width && current.height === height ? current : { width, height });
      }
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(area);
    return () => observer.disconnect();
  }, [showSettingsModal]);
  const terminalInstances = useTerminalInstances({
    activeId: activeTerminalId,
    isVisible: !isAppServerSession && workspaceTab === "terminal" && !(showTokenStats || showSkills || showMcp || showProjectAssistant || showIdea),
    terminalTheme,
    sessions: terminalSessions.sessions
  });
  useInputRecovery({
    debug: debugMode || import.meta.env.DEV,
    resetTerminalInput: terminalInstances.resetActiveTerminalInput
  });
  const canSearchProject = Boolean(terminalSessions.activeSession);
  const activeSessionId = terminalSessions.activeSession?.id;
  const handleAppServerDraftChange = useCallback((sessionId: string, value: SetStateAction<string>) => {
    setAppServerDrafts(current => {
      if (!appServerSessionIdsRef.current.has(sessionId)) return current;
      const nextDraft = typeof value === "function" ? value(current[sessionId] ?? "") : value;
      if (nextDraft === (current[sessionId] ?? "")) return current;
      if (!nextDraft) {
        const next = { ...current };
        delete next[sessionId];
        return next;
      }
      return { ...current, [sessionId]: nextDraft };
    });
  }, []);
  const handleAppServerDraftReferencesChange = useCallback((sessionId: string, value: SetStateAction<CodexCapabilityReference[]>) => {
    setAppServerDraftReferences(current => {
      if (!appServerSessionIdsRef.current.has(sessionId)) return current;
      const next = typeof value === "function" ? value(current[sessionId] ?? []) : value;
      return { ...current, [sessionId]: next };
    });
  }, []);

  const handleCaptureScreenshot = useCallback(async () => {
    if (!screenshotEnabled) return;
    setScreenshotError(null);
    try {
      await window.screenshotApi.captureRegion();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScreenshotError(t("screenshot.captureFailed", { message }));
    }
  }, [screenshotEnabled, t]);

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
    if (!remoteFilesDirty && !mcpDirty && !hasActiveTransfers) {
      window.windowApi.resolveClose(true);
      return;
    }
    setShowCloseGuard(true);
  }), [fileTransfers, mcpDirty, remoteFilesDirty]);

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

  const handleFilePanelNavigationChange = useCallback((sessionId: string, state: RemoteFilePanelNavigationState) => {
    filePanelNavigationBySessionRef.current.set(sessionId, state);
  }, []);

  useEffect(() => {
    const runningSessionIds = new Set(terminalSessions.sessions.map((session) => session.id));
    for (const sessionId of filePanelNavigationBySessionRef.current.keys()) {
      if (!runningSessionIds.has(sessionId)) filePanelNavigationBySessionRef.current.delete(sessionId);
    }
    setAppServerDrafts(current => {
      const entries = Object.entries(current).filter(([sessionId]) => runningSessionIds.has(sessionId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    setAppServerDraftReferences(current => {
      const entries = Object.entries(current).filter(([sessionId]) => runningSessionIds.has(sessionId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [terminalSessions.sessions]);

  useEffect(() => {
    let isDisposed = false;
    window.terminalApi.getConfig().then((config) => {
      if (!isDisposed) {
        setDebugMode(config.debugMode);
        setScreenshotEnabled(config.screenshotEnabled);
        setScreenshotShortcut(config.screenshotShortcut);
        setTitleBarActionOrder(withSettingsAction(config.titleBarActionOrder));
        setTitleBarHiddenActions(config.titleBarHiddenActions);
        setAutoWorkBuddyCheckin(config.autoWorkBuddyCheckin);
        setAutoCollapseFileChains(config.autoCollapseFileChains);
        setThemeId(config.themeId);
        onLocaleChange(normalizeLocale(config.locale));
        setSavedSidebarWidth(config.sidebarWidth);
        setRightToolsWidth(config.rightToolsWidth);
        setTerminalBackgroundImage(config.terminalBackgroundImage);
        setTerminalBackgroundOpacity(config.terminalBackgroundOpacity);
        setTerminalBackgroundBlur(config.terminalBackgroundBlur);
        setTerminalBackgroundPositionX(config.terminalBackgroundPositionX);
        setTerminalBackgroundPositionY(config.terminalBackgroundPositionY);
        savedTerminalBackgroundPosition.current = { x: config.terminalBackgroundPositionX, y: config.terminalBackgroundPositionY };
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
      const blockingOverlay = hasBlockingOverlay();
      if (screenshotEnabled
        && !event.repeat
        && !blockingOverlay
        && !isEditableShortcutTarget(event.target)
        && matchesScreenshotShortcut(event, screenshotShortcut)) {
        event.preventDefault();
        event.stopPropagation();
        void handleCaptureScreenshot();
        return;
      }
      if (!terminalSessions.activeSession) {
        return;
      }
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
  }, [debugMode, handleCaptureScreenshot, openProjectSearch, projectSearchMode, remoteFilesDirty, rightTool, screenshotEnabled, screenshotShortcut, t, terminalSessions.activeSession]);

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

  const handleQuickCreateAgent = useCallback(async (provider: AgentProvider) => {
    if (remoteFilesDirty && !window.confirm(t("confirm.discardUnsavedFileChanges"))) {
      return;
    }
    if (mcpDirty && !window.confirm(t("mcp.discardChanges"))) {
      return;
    }

    setQuickAgentError(null);
    try {
      await terminalSessions.createSession({
        selectedShellId: "default",
        title: getAgentProviderLabel(provider),
        agentProvider: provider,
        persist: false
      });
      setShowTokenStats(false);
      setShowSkills(false);
      setShowMcp(false);
      setShowProjectAssistant(false);
      setShowIdea(false);
      setMcpDirty(false);
      setWorkspaceTab("terminal");
    } catch (err: any) {
      setQuickAgentError(err?.message || t("session.createFailed"));
    }
  }, [mcpDirty, remoteFilesDirty, t, terminalSessions]);

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
    setOpenedShellIds(current => { const next = new Set(current); next.delete(id); return next; });
    workspaceTabBySessionRef.current.delete(id);
    if (id === terminalSessions.activeId && workspaceTabRef.current === "session-shell") setWorkspaceTab("terminal");
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
    setWorkspaceTab(cached === "session-shell" && !openedShellIds.has(id) ? "terminal" : cached ?? "terminal");
    terminalSessions.setActiveId(id);
  }, [openedShellIds, terminalSessions]);

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
    if (tool === "conversation") agentConversation.markRead();
    setRightTool(tool);
  }, [agentConversation, remoteFilesDirty, t]);

  const handleSaveEdit = useCallback(async (id: string, title: string, cwd: string, initialCommand: string, agentProvider?: AgentProvider, agentLocation?: AgentLocation, localAgentCwd?: string, codexBackend?: CodexBackend, codexModel?: string, quickCommands?: QuickCommand[], sshConfig?: SshConfig, tags?: string[], codexExperimentalAcknowledged?: boolean, environment?: EnvironmentSelection, graphicalSessionEnabled?: boolean, modelSource?: AgentModelSource, modelId?: string) => {
    await terminalSessions.updateSession(id, title, cwd, initialCommand, agentProvider, agentLocation, localAgentCwd, codexBackend, codexModel, quickCommands, sshConfig, tags, codexExperimentalAcknowledged, environment, graphicalSessionEnabled, modelSource, modelId);
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

  const handleAppServerLink = useCallback((session: TerminalSession, href: string) => {
    setAppServerLinkError(null);
    const target = resolveCodexFileLink(session.cwd, href);
    if (target.kind === "ignore") return;
    if (target.kind === "external") {
      void window.externalLinkApi.open(target.url).catch((error: unknown) => setAppServerLinkError(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (target.kind === "error") {
      setAppServerLinkError(target.message);
      return;
    }
    setRightTool("files");
    fileOpenRequestIdRef.current += 1;
    setFileOpenRequest({ sessionId: session.id, path: target.path, line: target.line, requestId: fileOpenRequestIdRef.current });
  }, [setRightTool]);

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

  const handleToggleAutoWorkBuddyCheckin = useCallback(async () => {
    const config = await window.terminalApi.setConfig({ autoWorkBuddyCheckin: !autoWorkBuddyCheckin });
    setAutoWorkBuddyCheckin(config.autoWorkBuddyCheckin);
  }, [autoWorkBuddyCheckin]);

  const handleScreenshotEnabledChange = useCallback(async (enabled: boolean) => {
    const config = await window.terminalApi.setConfig({ screenshotEnabled: enabled });
    setScreenshotEnabled(config.screenshotEnabled);
  }, []);

  const handleScreenshotShortcutChange = useCallback(async (shortcut: string) => {
    const config = await window.terminalApi.setConfig({ screenshotShortcut: shortcut });
    setScreenshotShortcut(config.screenshotShortcut);
  }, []);

  const handleToggleAutoCollapseFileChains = useCallback(async () => {
    const config = await window.terminalApi.setConfig({ autoCollapseFileChains: !autoCollapseFileChains });
    setAutoCollapseFileChains(config.autoCollapseFileChains);
  }, [autoCollapseFileChains]);

  const handleThemeChange = useCallback(async (nextThemeId: ThemeId) => {
    const config = await window.terminalApi.setConfig({ themeId: nextThemeId });
    setThemeId(config.themeId);
  }, []);

  const handleLocaleChange = useCallback(async (nextLocale: Locale) => {
    const config = await window.terminalApi.setConfig({ locale: nextLocale });
    onLocaleChange(normalizeLocale(config.locale));
  }, [onLocaleChange]);

  const handleChooseTerminalBackground = useCallback(async () => {
    const result = await window.terminalApi.chooseTerminalBackgroundImage();
    if (result.canceled || !result.name) return;
    const config = await window.terminalApi.setConfig({ terminalBackgroundImage: result.name });
    setTerminalBackgroundImage(config.terminalBackgroundImage);
  }, []);

  const handleClearTerminalBackground = useCallback(async () => {
    const config = await window.terminalApi.setConfig({ terminalBackgroundImage: "" });
    setTerminalBackgroundImage(config.terminalBackgroundImage);
  }, []);

  const handleTerminalBackgroundOpacityChange = useCallback(async (value: number) => {
    setTerminalBackgroundOpacity(value);
    const config = await window.terminalApi.setConfig({ terminalBackgroundOpacity: value });
    setTerminalBackgroundOpacity(config.terminalBackgroundOpacity);
  }, []);

  const handleTerminalBackgroundBlurChange = useCallback(async (value: number) => {
    setTerminalBackgroundBlur(value);
    const config = await window.terminalApi.setConfig({ terminalBackgroundBlur: value });
    setTerminalBackgroundBlur(config.terminalBackgroundBlur);
  }, []);

  const handleTitleBarActionsChange = useCallback(async (change: { titleBarActionOrder?: TitleBarActionId[]; titleBarHiddenActions?: TitleBarActionId[] }) => {
    const config = await window.terminalApi.setConfig(change);
    setTitleBarActionOrder(withSettingsAction(config.titleBarActionOrder));
    setTitleBarHiddenActions(config.titleBarHiddenActions);
  }, []);

  const handleTerminalBackgroundPositionPreview = useCallback((x: number, y: number) => {
    setTerminalBackgroundPositionX(x);
    setTerminalBackgroundPositionY(y);
  }, []);

  const handleTerminalBackgroundPositionCommit = useCallback(async (x: number, y: number) => {
    try {
      const config = await window.terminalApi.setConfig({ terminalBackgroundPositionX: x, terminalBackgroundPositionY: y });
      savedTerminalBackgroundPosition.current = { x: config.terminalBackgroundPositionX, y: config.terminalBackgroundPositionY };
      setTerminalBackgroundPositionX(config.terminalBackgroundPositionX);
      setTerminalBackgroundPositionY(config.terminalBackgroundPositionY);
    } catch (error) {
      setTerminalBackgroundPositionX(savedTerminalBackgroundPosition.current.x);
      setTerminalBackgroundPositionY(savedTerminalBackgroundPosition.current.y);
      throw error;
    }
  }, []);

  useEffect(() => {
    if (!terminalSessions.activeSession) {
      if (rightTool === "files" || rightTool === "git" || rightTool === "monitor") {
        setRightTool(debugMode ? "debug" : "conversation");
      }
      return;
    }
    if (rightTool === "monitor" && terminalSessions.activeSession.type !== "ssh") {
      setRightTool("files");
      return;
    }
    if (!debugMode && rightTool === "debug") {
      setRightTool("files");
      return;
    }
  }, [debugMode, rightTool, terminalSessions.activeSession]);

  const showFilesPanel = Boolean(terminalSessions.activeSession);
  const showMonitorPanel = terminalSessions.activeSession?.type === "ssh";
  const showRightTools = true;
  const activeRightTool: RightTool = resolveRightTool(rightTool, {
    hasSession: showFilesPanel,
    showMonitor: showMonitorPanel,
    debugMode
  });

  useEffect(() => {
    const tab = document.querySelector<HTMLElement>(".right-tool-tabs [aria-selected='true']");
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeRightTool, showMonitorPanel, debugMode, liveRightToolsWidth, locale]);
  const appShellColumns = debugMode
    ? `${sidebarWidth}px 1px minmax(0, 1fr) 1px ${liveRightToolsWidth}px`
    : showRightTools
      ? `${sidebarWidth}px 1px minmax(0, 1fr) 1px ${liveRightToolsWidth}px`
    : `${sidebarWidth}px 1px minmax(0, 1fr)`;

  return (
    <>
      <div className="app-frame">
        <TitleBar
          activeTitle={showProjectAssistant ? t("projectAssistant.title") : showMcp ? t("mcp.title") : showSkills ? t("skills.title") : showIdea ? t("tabs.idea") : showTokenStats ? t("tokenStats.title") : undefined}
          isMaximized={isMaximized}
          mobileAccessState={mobileAccessState}
          screenshotEnabled={screenshotEnabled}
          actionOrder={titleBarActionOrder}
          hiddenActions={titleBarHiddenActions}
          onCaptureScreenshot={() => void handleCaptureScreenshot()}
          onOpenSettings={() => setShowSettingsModal(true)}
          onOpenPicker={terminalSessions.openPicker}
          onOpenCreate={handleOpenCreateModal}
          onQuickCreateAgent={handleQuickCreateAgent}
          onOpenTerminal={() => {
            if (mcpDirty && !window.confirm(t("mcp.discardChanges"))) return;
            setShowTokenStats(false);
            setShowSkills(false);
            setShowMcp(false);
            setShowProjectAssistant(false);
            setShowIdea(false);
          }}
          onOpenStats={() => {
            if (mcpDirty && !window.confirm(t("mcp.discardChanges"))) return;
            setShowSkills(false);
            setShowMcp(false);
            setShowTokenStats(true);
            setShowProjectAssistant(false);
            setShowIdea(false);
          }}
          onOpenSkills={() => {
            if (mcpDirty && !window.confirm(t("mcp.discardChanges"))) return;
            setShowTokenStats(false);
            setShowMcp(false);
            setShowSkills(true);
            setShowProjectAssistant(false);
            setShowIdea(false);
          }}
          onOpenMcp={() => {
            setShowTokenStats(false);
            setShowSkills(false);
            setShowMcp(true);
            setShowProjectAssistant(false);
            setShowIdea(false);
          }}
          onOpenProjectAssistant={() => {
            if (mcpDirty && !window.confirm(t("mcp.discardChanges"))) return;
            setShowTokenStats(false);
            setShowSkills(false);
            setShowMcp(false);
            setShowProjectAssistant(true);
            setShowIdea(false);
          }}
          onOpenIdea={() => {
            setShowTokenStats(false);
            setShowSkills(false);
            setShowMcp(false);
            setShowProjectAssistant(false);
            setShowIdea(true);
          }}
        />
        {terminalSessions.startupError && (
          <div className="startup-error-banner" role="alert">
            <span>{terminalSessions.startupError}</span>
            <button type="button" onClick={terminalSessions.clearStartupError} aria-label={t("common.close")}><X aria-hidden="true" /></button>
          </div>
        )}
        {quickAgentError && (
          <div className="startup-error-banner" role="alert">
            <span>{quickAgentError}</span>
            <button type="button" onClick={() => setQuickAgentError(null)} aria-label={t("common.close")}><X aria-hidden="true" /></button>
          </div>
        )}
        {screenshotError && (
          <div className="startup-error-banner" role="alert">
            <span>{screenshotError}</span>
            <button type="button" onClick={() => setScreenshotError(null)} aria-label={t("common.close")}><X aria-hidden="true" /></button>
          </div>
        )}
        {terminalSessions.activeAgentWarning && (
          <div className="startup-error-banner" role="alert">
            <span>{t("agent.openCodeEmptyResponse")}</span>
            <button type="button" onClick={terminalSessions.dismissActiveAgentWarning} aria-label={t("common.close")}><X aria-hidden="true" /></button>
          </div>
        )}

        {showTokenStats && <AgentTokenStatsDashboard />}
        {showSkills && <SkillsManager key={terminalSessions.activeSession?.id || "personal"} session={terminalSessions.activeSession} />}
        {showIdea && <IdeaRunPanel />}
        {showProjectAssistant && <ProjectAssistantPage initialSessionId={terminalSessions.activeSession?.agentProvider === "codex" ? terminalSessions.activeSession.id : undefined} />}
        {showMcp && (
          <McpManager
            session={terminalSessions.activeSession}
            onDirtyChange={setMcpDirty}
            onRegisterSave={(handler) => { saveMcpRef.current = handler; }}
          />
        )}
        <main className="app-shell" style={{ gridTemplateColumns: appShellColumns, display: showTokenStats || showSkills || showMcp || showProjectAssistant || showIdea ? "none" : undefined }}>
          <SessionSidebar
            sessions={terminalSessions.sessions}
            activeId={terminalSessions.activeId}
            showInstanceIds={debugMode}
            agentStatusesBySessionId={terminalSessions.agentStatusesBySessionId}
            onSelectSession={handleSelectSession}
            onEditSession={setEditDialogSession}
            onDuplicateSession={terminalSessions.duplicateRunningSession}
            onInstallHooks={setHookInstallSession}
            onReconnectSession={terminalSessions.reconnectSession}
            onCloseSession={handleCloseSession}
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
                {isAppServerSession ? <MessageSquare aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />}
                <span>{t(isAppServerSession ? "tabs.conversation" : "tabs.terminal")}</span>
              </button>
              {isAppServerSession && terminalSessions.activeId && (
                <div
                  className={`workspace-tab file-tab ${workspaceTab === "session-shell" ? "active" : ""}`}
                  role="tab"
                  tabIndex={0}
                  aria-selected={workspaceTab === "session-shell"}
                  onClick={() => {
                    setOpenedShellIds(current => new Set(current).add(terminalSessions.activeId!));
                    setWorkspaceTab("session-shell");
                  }}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpenedShellIds(current => new Set(current).add(terminalSessions.activeId!));
                      setWorkspaceTab("session-shell");
                    }
                  }}
                >
                  <TerminalIcon aria-hidden="true" />
                  <span>{t("tabs.terminal")}</span>
                  {openedShellIds.has(terminalSessions.activeId) && <button className="workspace-tab-close" type="button" title={t("tabs.closeSessionShell")} aria-label={t("tabs.closeSessionShell")}
                    onKeyDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      const id = terminalSessions.activeId!;
                      void window.sessionShellApi.close(id, "");
                      setOpenedShellIds(current => { const next = new Set(current); next.delete(id); return next; });
                      if (workspaceTab === "session-shell") setWorkspaceTab("terminal");
                      workspaceTabBySessionRef.current.set(id, "terminal");
                    }}><X aria-hidden="true" /></button>}
                </div>
              )}
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
              <div
                ref={terminalAreaRef}
                className={`terminal-area${terminalBackground ? " has-bg" : ""}`}
                style={{ display: workspaceTab === "terminal" ? undefined : "none" }}
              >
                {terminalBackground && (
                  <div
                    className="terminal-bg-layer"
                    aria-hidden="true"
                    style={{
                      backgroundImage: `url("${terminalBackground.imageUrl}")`,
                      backgroundPosition: `${terminalBackground.positionX}% ${terminalBackground.positionY}%`,
                      opacity: terminalBackground.opacity / 100,
                      filter: terminalBackground.blur > 0 ? `blur(${terminalBackground.blur}px)` : undefined,
                      inset: -terminalBackground.blur
                    }}
                  />
                )}
                <TerminalPanel
                  sessions={terminalSessions.sessions}
                  activeId={activeTerminalId}
                  isVisible={!isAppServerSession}
                  hostRefs={terminalInstances.terminalHostRefs}
                  onContextMenu={terminalInstances.handleTerminalContextMenu}
                  onWheel={terminalInstances.handleTerminalWheel}
                  sizeOwner={terminalInstances.activeSizeOwner}
                  onClaimSize={terminalInstances.claimActiveSize}
                />
                {terminalSessions.sessions.filter(session => session.runtimeMode === "app-server").map(session =>
                  <GraphicalSessionPanel key={session.id} session={session}
                    isActive={isAppServerSession && activeSessionId === session.id && workspaceTab === "terminal"}
                    draft={appServerDrafts[session.id] ?? ""} draftReferences={appServerDraftReferences[session.id] ?? emptyDraftReferences}
                    onDraftChange={handleAppServerDraftChange} onDraftReferencesChange={handleAppServerDraftReferencesChange}
                    onLinkClick={handleAppServerLink} onReconnectModels={terminalSessions.reconnectOpenCodeModels} onSwitchCodeBuddyModel={terminalSessions.switchCodeBuddyModel} onSwitchCodexModel={terminalSessions.switchCodexGraphicalModel} sessionRefs={appServerSessionRefs.current} />)}
                {isAppServerSession && appServerLinkError && <div role="alert" className="codex-app-server-error">
                  <span>{appServerLinkError}</span>
                  <button type="button" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => setAppServerLinkError(null)}><X aria-hidden="true" /></button>
                </div>}
                {!isAppServerSession && <TerminalComposer
                  session={terminalSessions.activeSession}
                  onFocusTerminal={terminalInstances.focusActiveTerminal}
                />}
                {!isAppServerSession && (terminalSessions.activeId != null || remoteSystemMetrics.status !== "hidden") && (
                  <footer className="terminal-footer">
                    <QuickCommandBar
                      quickCommands={terminalSessions.quickCommandsForActiveSession}
                      activeSessionId={terminalSessions.activeId}
                      onFocusTerminal={terminalInstances.focusActiveTerminal}
                      onAddQuickCommand={terminalSessions.addQuickCommandToActiveSession}
                      onRemoveQuickCommand={terminalSessions.removeQuickCommandFromActiveSession}
                      onTogglePinned={terminalSessions.toggleQuickCommandPinnedForActiveSession}
                    />
                    <div className="terminal-status-cluster">
                      <SessionModeSwitch session={terminalSessions.activeSession} onOpenOtherMode={terminalSessions.openOtherSessionMode} />
                      <AgentSwitcher session={terminalSessions.activeSession} onSwitch={terminalSessions.switchAgent} />
                      <AgentTokenLiveStatus state={agentTokenLive} />
                      <AgentUsageStatus
                        state={agentUsage.state}
                        onRefresh={agentUsage.refresh}
                        onConsumeResetCredit={agentUsage.consumeResetCredit}
                      />
                      <RemoteSystemStatus
                        state={remoteSystemMetrics}
                        active={activeRightTool === "monitor"}
                        onOpen={() => handleRightToolChange("monitor")}
                      />
                    </div>
                  </footer>
                )}
                {isAppServerSession && <footer className="terminal-footer">
                  <QuickCommandBar
                    quickCommands={terminalSessions.quickCommandsForActiveSession}
                    activeSessionId={terminalSessions.activeId}
                    onFocusTerminal={() => {}}
                    onAddQuickCommand={terminalSessions.addQuickCommandToActiveSession}
                    onRemoveQuickCommand={terminalSessions.removeQuickCommandFromActiveSession}
                    onTogglePinned={terminalSessions.toggleQuickCommandPinnedForActiveSession}
                    onExecuteCommand={command => terminalSessions.activeId ? appServerSessionRefs.current.get(terminalSessions.activeId)?.applyQuickCommand(command) ?? false : false}
                    autoEnterDisabled={!appServerFooter.canSubmit}
                  />
                  <div className="terminal-status-cluster">
                    <SessionModeSwitch session={terminalSessions.activeSession} onOpenOtherMode={terminalSessions.openOtherSessionMode} />
                    <AgentSwitcher session={terminalSessions.activeSession} onSwitch={terminalSessions.switchAgent} />
                    <AgentTokenLiveStatus
                      state={terminalSessions.activeSession?.agentProvider === "codebuddy" ? agentTokenLive : appServerFooter.tokenState}
                      source={terminalSessions.activeSession?.agentProvider === "codebuddy" ? "transcript" : "app-server"}
                    />
                    {appServerFooter.contextUsage !== undefined && <CodeBuddyContextUsage usage={appServerFooter.contextUsage}
                      provider={terminalSessions.activeSession?.agentProvider === "opencode" ? "opencode" : "codebuddy"} />}
                    <AgentUsageStatus
                      state={agentUsage.state}
                      onRefresh={agentUsage.refresh}
                      onConsumeResetCredit={agentUsage.consumeResetCredit}
                    />
                  </div>
                </footer>}
              </div>
              {terminalSessions.sessions.filter(session => session.runtimeMode === "app-server" && openedShellIds.has(session.id)).map(session => (
                <SessionShellPanel key={session.id} sessionId={session.id} theme={terminalTheme}
                  visible={workspaceTab === "session-shell" && terminalSessions.activeId === session.id} />
              ))}
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
              {showRightTools && (
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
                  {showMonitorPanel && (
                    <button
                      className={activeRightTool === "monitor" ? "active" : ""}
                      type="button"
                      role="tab"
                      aria-selected={activeRightTool === "monitor"}
                      onClick={() => handleRightToolChange("monitor")}
                    >
                      {t("tabs.monitor")}
                    </button>
                  )}
                  <button
                    className={activeRightTool === "conversation" ? "active" : ""}
                    type="button"
                    role="tab"
                    aria-selected={activeRightTool === "conversation"}
                    onClick={() => handleRightToolChange("conversation")}
                  >
                    <span>{t("tabs.conversation")}</span>
                    {agentConversation.unread && <span className="right-tool-unread" aria-label={t("conversation.unread")} />}
                  </button>
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
                  rememberedNavigationState={terminalSessions.activeId ? filePanelNavigationBySessionRef.current.get(terminalSessions.activeId) : undefined}
                  onNavigationStateChange={handleFilePanelNavigationChange}
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
                  autoCollapseFileChains={autoCollapseFileChains}
                  onToggleAutoCollapseFileChains={handleToggleAutoCollapseFileChains}
                  onFocusTerminal={terminalInstances.focusActiveTerminal}
                  onAddToGraphicalInput={(sessionId, path) => {
                    if (terminalSessions.activeSession?.id !== sessionId) return;
                    setWorkspaceTab("terminal");
                    appServerSessionRefs.current.get(sessionId)?.appendFilePath(path);
                  }}
                  transfers={fileTransfers}
                  onShowTransfers={() => setWorkspaceTab("transfers")}
                  onRegisterSaveAll={(handler) => { saveAllRemoteFilesRef.current = handler; }}
                />
              ) : activeRightTool === "git" && showFilesPanel ? (
                <GitStatusPanel
                  session={terminalSessions.activeSession}
                  onSummaryChange={handleGitSummaryChange}
                />
              ) : activeRightTool === "monitor" && showMonitorPanel ? (
                <RemoteSystemPanel
                  state={remoteSystemMetrics}
                  sessionTitle={terminalSessions.activeSession!.title}
                  preferredDiskMountPoint={terminalSessions.activeSession?.preferredDiskMountPoint}
                  onSelectDisk={(mountPoint) => { void terminalSessions.setActivePreferredDiskMountPoint(mountPoint); }}
                />
              ) : activeRightTool === "conversation" ? (
                <AgentConversationPanel snapshot={agentConversation.snapshot} session={terminalSessions.activeSession} />
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

      <RemoteAgentApprovalCard sessions={terminalSessions.sessions} />
      <CodexWorkspaceTrustDialog />

      {showCreateModal && (
        <CreateSessionModal
          defaultWindowsShell={terminalSessions.defaultWindowsShell}
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
          defaultWindowsShell={terminalSessions.defaultWindowsShell}
          onDefaultWindowsShellChange={terminalSessions.changeDefaultWindowsShell}
          autoRestore={terminalSessions.autoRestore}
          autoWorkBuddyCheckin={autoWorkBuddyCheckin}
          debugMode={debugMode}
          screenshotEnabled={screenshotEnabled}
          screenshotShortcut={screenshotShortcut}
          titleBarActionOrder={titleBarActionOrder}
          titleBarHiddenActions={titleBarHiddenActions}
          onTitleBarActionsChange={handleTitleBarActionsChange}
          themeId={themeId}
          locale={locale}
          themes={APP_THEMES}
          onToggleAutoRestore={terminalSessions.toggleAutoRestore}
          onToggleAutoWorkBuddyCheckin={handleToggleAutoWorkBuddyCheckin}
          onToggleDebugMode={handleToggleDebugMode}
          onScreenshotEnabledChange={handleScreenshotEnabledChange}
          onScreenshotShortcutChange={handleScreenshotShortcutChange}
          onThemeChange={handleThemeChange}
          onLocaleChange={handleLocaleChange}
          terminalBackgroundImage={terminalBackgroundImage}
          terminalBackgroundOpacity={terminalBackgroundOpacity}
          terminalBackgroundBlur={terminalBackgroundBlur}
          terminalBackgroundPositionX={terminalBackgroundPositionX}
          terminalBackgroundPositionY={terminalBackgroundPositionY}
          terminalBackgroundAreaSize={terminalBackgroundAreaSize}
          onChooseTerminalBackground={handleChooseTerminalBackground}
          onClearTerminalBackground={handleClearTerminalBackground}
          onTerminalBackgroundOpacityChange={handleTerminalBackgroundOpacityChange}
          onTerminalBackgroundBlurChange={handleTerminalBackgroundBlurChange}
          onTerminalBackgroundPositionPreview={handleTerminalBackgroundPositionPreview}
          onTerminalBackgroundPositionCommit={handleTerminalBackgroundPositionCommit}
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
            {mcpDirty && <p>{t("mcp.unsavedClose")}</p>}
            <div className="file-operation-actions">
              <button type="button" onClick={() => { setShowCloseGuard(false); window.windowApi.resolveClose(false); }}>{t("common.cancel")}</button>
              <button type="button" onClick={() => window.windowApi.resolveClose(true)}>{t("files.discardAndExit")}</button>
              {(remoteFilesDirty || mcpDirty) && <button type="button" onClick={async () => {
                const remoteSaved = !remoteFilesDirty || await saveAllRemoteFilesRef.current?.();
                const mcpSaved = !mcpDirty || await saveMcpRef.current?.();
                if (remoteSaved && mcpSaved) window.windowApi.resolveClose(true);
              }}>{t("files.saveAllAndExit")}</button>}
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
