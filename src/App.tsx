import { useCallback, useEffect, useState } from "react";
import { SettingsModal } from "./components/SettingsModal";
import { CreateSessionModal } from "./components/CreateSessionModal";
import { DebugSidebar } from "./components/DebugSidebar";
import { EditSessionModal } from "./components/EditSessionModal";
import { SessionPickerModal } from "./components/SessionPickerModal";
import { SessionSidebar } from "./components/SessionSidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { QuickCommandBar } from "./components/QuickCommandBar";
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
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [hookDebugEvents, setHookDebugEvents] = useState<AgentHookDebugPayload[]>([]);
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
    await terminalSessions.createSession(request);
    setShowCreateModal(false);
  }, [terminalSessions]);

  const handleCloseSession = useCallback(async (id: string) => {
    await terminalSessions.closeSession(id);
    terminalInstances.disposeTerminal(id);
  }, [terminalInstances, terminalSessions]);

  const handleSaveEdit = useCallback(async (id: string, title: string, initialCommand: string, quickCommands?: QuickCommand[], sshConfig?: SshConfig) => {
    await terminalSessions.updateSession(id, title, initialCommand, quickCommands, sshConfig);
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

  const appShellColumns = debugMode
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
            onSelectSession={terminalSessions.setActiveId}
            onEditSession={setEditDialogSession}
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
            />
          </div>

          {debugMode && (
            <DebugSidebar
              events={hookDebugEvents}
              onClear={() => setHookDebugEvents([])}
            />
          )}
        </main>
      </div>

      {showCreateModal && (
        <CreateSessionModal
          wslDistros={wslDistros}
          onCreate={handleCreateSession}
          onCancel={() => setShowCreateModal(false)}
        />
      )}

      {editDialogSession && (
        <EditSessionModal
          session={editDialogSession}
          onSave={handleSaveEdit}
          onCancel={() => setEditDialogSession(null)}
        />
      )}

      {terminalSessions.pendingSessions !== null && (
        <SessionPickerModal
          pendingSessions={terminalSessions.pendingSessions}
          runningSessions={terminalSessions.sessions}
          pickerManual={terminalSessions.pickerManual}
          onLaunch={terminalSessions.launchSessions}
          onStartFresh={terminalSessions.startFresh}
          onDelete={terminalSessions.deleteFromLibrary}
          onReorder={terminalSessions.reorderLibrary}
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
