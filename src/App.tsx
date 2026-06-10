import { useCallback, useEffect, useState } from "react";
import { SettingsModal } from "./components/SettingsModal";
import { CreateSessionModal } from "./components/CreateSessionModal";
import { DebugSidebar } from "./components/DebugSidebar";
import { EditSessionModal } from "./components/EditSessionModal";
import { HookInstallModal } from "./components/HookInstallModal";
import { SessionPickerModal } from "./components/SessionPickerModal";
import { SessionSidebar } from "./components/SessionSidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { QuickCommandBar } from "./components/QuickCommandBar";
import { RemoteFilePanel } from "./components/RemoteFilePanel";
import { TitleBar } from "./components/TitleBar";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useTerminalInstances } from "./hooks/useTerminalInstances";
import { useTerminalSessions } from "./hooks/useTerminalSessions";
import { useWindowState } from "./hooks/useWindowState";
import type { CreateSessionRequest } from "./components/CreateSessionModal";
import type { AgentHookDebugPayload, QuickCommand, SshConfig, TerminalSession } from "./vite-env";

export function App() {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [editDialogSession, setEditDialogSession] = useState<TerminalSession | null>(null);
  const [hookInstallSession, setHookInstallSession] = useState<TerminalSession | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [rightTool, setRightTool] = useState<"files" | "debug">("files");
  const [hookDebugEvents, setHookDebugEvents] = useState<AgentHookDebugPayload[]>([]);
  const [remoteFilesDirty, setRemoteFilesDirty] = useState(false);
  const { isMaximized } = useWindowState();
  const { sidebarWidth, handleSplitterMouseDown } = useSidebarResize();
  const terminalSessions = useTerminalSessions();
  const terminalInstances = useTerminalInstances({
    activeId: terminalSessions.activeId
  });

  useEffect(() => {
    let isDisposed = false;
    window.terminalApi.getConfig().then((config) => {
      if (!isDisposed) {
        setDebugMode(config.debugMode);
      }
    });
    return () => {
      isDisposed = true;
    };
  }, []);

  useEffect(() => {
    if (!debugMode) return undefined;
    return window.terminalApi.onAgentHookDebug((payload) => {
      setHookDebugEvents((current) => [...current, payload].slice(-300));
    });
  }, [debugMode]);

  const handleOpenCreateModal = useCallback(async () => {
    setShowCreateModal(true);
    const distros = await window.terminalApi.listWslDistros();
    setWslDistros(distros);
  }, []);

  const handleCreateSession = useCallback(async (request: CreateSessionRequest) => {
    if (remoteFilesDirty && !window.confirm("Discard unsaved remote file changes?")) {
      return;
    }
    await terminalSessions.createSession(request);
    setShowCreateModal(false);
  }, [remoteFilesDirty, terminalSessions]);

  const handleCloseSession = useCallback(async (id: string) => {
    if (id === terminalSessions.activeId && remoteFilesDirty && !window.confirm("Discard unsaved remote file changes?")) {
      return;
    }
    await terminalSessions.closeSession(id);
    terminalInstances.disposeTerminal(id);
  }, [remoteFilesDirty, terminalInstances, terminalSessions]);

  const handleSelectSession = useCallback((id: string) => {
    if (id === terminalSessions.activeId) {
      return;
    }
    if (remoteFilesDirty && !window.confirm("Discard unsaved remote file changes?")) {
      return;
    }
    terminalSessions.setActiveId(id);
  }, [remoteFilesDirty, terminalSessions]);

  const handleLaunchSessions = useCallback(async (sessions: TerminalSession[]) => {
    if (remoteFilesDirty && !window.confirm("Discard unsaved remote file changes?")) {
      return;
    }
    await terminalSessions.launchSessions(sessions);
  }, [remoteFilesDirty, terminalSessions]);

  const handleStartFresh = useCallback(async () => {
    if (remoteFilesDirty && !window.confirm("Discard unsaved remote file changes?")) {
      return;
    }
    await terminalSessions.startFresh();
  }, [remoteFilesDirty, terminalSessions]);

  const handleRightToolChange = useCallback((tool: "files" | "debug") => {
    if (tool !== "files" && remoteFilesDirty && !window.confirm("Discard unsaved remote file changes?")) {
      return;
    }
    setRightTool(tool);
  }, [remoteFilesDirty]);

  const handleSaveEdit = useCallback(async (id: string, title: string, cwd: string, initialCommand: string, quickCommands?: QuickCommand[], sshConfig?: SshConfig, tags?: string[]) => {
    await terminalSessions.updateSession(id, title, cwd, initialCommand, quickCommands, sshConfig, tags);
    setEditDialogSession(null);
  }, [terminalSessions]);

  const handleClosePicker = useCallback(() => {
    terminalSessions.setPendingSessions(null);
    terminalSessions.setPickerManual(false);
  }, [terminalSessions]);

  const handleToggleDebugMode = useCallback(async () => {
    const config = await window.terminalApi.getConfig();
    const next = !config.debugMode;
    await window.terminalApi.setConfig({ debugMode: next });
    setDebugMode(next);
  }, []);

  useEffect(() => {
    if (!debugMode && terminalSessions.activeSession?.type === "ssh") {
      setRightTool("files");
      return;
    }
    if (debugMode && terminalSessions.activeSession?.type !== "ssh") {
      setRightTool("debug");
    }
  }, [debugMode, terminalSessions.activeSession?.type]);

  const showFilesPanel = terminalSessions.activeSession?.type === "ssh";
  const showRightTools = showFilesPanel || debugMode;
  const activeRightTool = showFilesPanel && (!debugMode || rightTool === "files") ? "files" : "debug";
  const appShellColumns = debugMode
    ? `${sidebarWidth}px 1px minmax(0, 1fr) clamp(320px, 28vw, 460px)`
    : showRightTools
      ? `${sidebarWidth}px 1px minmax(0, 1fr) clamp(320px, 28vw, 460px)`
    : `${sidebarWidth}px 1px minmax(0, 1fr)`;

  return (
    <>
      <div className="app-frame">
        <TitleBar activeTitle={terminalSessions.activeSession?.title} isMaximized={isMaximized} onOpenSettings={() => setShowSettingsModal(true)} />

        <main className="app-shell" style={{ gridTemplateColumns: appShellColumns }}>
          <SessionSidebar
            sessions={terminalSessions.sessions}
            activeId={terminalSessions.activeId}
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

          <div className="terminal-area">
            <TerminalPanel
              terminalHostRef={terminalInstances.terminalHostRef}
              onContextMenu={terminalInstances.handleTerminalContextMenu}
            />
            <QuickCommandBar
              quickCommands={terminalSessions.quickCommandsForActiveSession}
              activeSessionId={terminalSessions.activeId}
              onFocusTerminal={terminalInstances.focusActiveTerminal}
            />
          </div>

          {showRightTools && (
            <aside className="right-tools">
              {debugMode && (
                <div className="right-tool-tabs" role="tablist" aria-label="Right sidebar tools">
                  {showFilesPanel && (
                    <button
                      className={activeRightTool === "files" ? "active" : ""}
                      type="button"
                      role="tab"
                      aria-selected={activeRightTool === "files"}
                      onClick={() => handleRightToolChange("files")}
                    >
                      Files
                    </button>
                  )}
                  <button
                    className={activeRightTool === "debug" ? "active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={activeRightTool === "debug"}
                  onClick={() => handleRightToolChange("debug")}
                  >
                    Debug
                  </button>
                </div>
              )}
              {activeRightTool === "files" && showFilesPanel ? (
                <RemoteFilePanel session={terminalSessions.activeSession} onDirtyChange={setRemoteFilesDirty} />
              ) : (
                <DebugSidebar
                  events={hookDebugEvents}
                  onClear={() => setHookDebugEvents([])}
                />
              )}
            </aside>
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
          onReorder={terminalSessions.reorderLibrary}
          onUpdateTags={terminalSessions.updateLibraryTags}
          onCancel={handleClosePicker}
        />
      )}

      {showSettingsModal && (
        <SettingsModal
          autoRestore={terminalSessions.autoRestore}
          debugMode={debugMode}
          onToggleAutoRestore={terminalSessions.toggleAutoRestore}
          onToggleDebugMode={handleToggleDebugMode}
          onCancel={() => setShowSettingsModal(false)}
        />
      )}
    </>
  );
}
