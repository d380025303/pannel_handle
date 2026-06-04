import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatusPayload, QuickCommand, TerminalSession } from "../vite-env";

type CreateSessionOptions = {
  selectedShellId: string;
  title?: string;
  initialCommand?: string;
};

export function useTerminalSessions() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [pendingSessions, setPendingSessions] = useState<TerminalSession[] | null>(null);
  const [pickerManual, setPickerManual] = useState(false);
  const [agentStatusesBySessionId, setAgentStatusesBySessionId] = useState<Record<string, AgentStatusPayload>>({});
  const pendingSelectTemplateId = useRef<string | undefined>(undefined);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [activeId, sessions]
  );
  const activeAgentStatus = activeId ? agentStatusesBySessionId[activeId] : undefined;

  const quickCommandsForActiveSession = useMemo(
    () => activeSession?.quickCommands ?? [],
    [activeSession]
  );

  useEffect(() => {
    let isDisposed = false;

    window.terminalApi.loadSavedSessions().then((saved) => {
      if (isDisposed) {
        return;
      }
      if (saved.length > 0) {
        setPendingSessions(saved);
        setPickerManual(false);
      } else {
        setPendingSessions(null);
      }
    });

    const removeSessionsListener = window.terminalApi.onSessionsChanged((nextSessions) => {
      setSessions(nextSessions);
      setAgentStatusesBySessionId((current) => {
        const activeSessionIds = new Set(nextSessions.map((session) => session.id));
        return Object.fromEntries(
          Object.entries(current).filter(([id]) => activeSessionIds.has(id))
        );
      });
      setActiveId((current) => {
        if (pendingSelectTemplateId.current) {
          const targetId = pendingSelectTemplateId.current;
          pendingSelectTemplateId.current = undefined;
          const matched = nextSessions.find(s => s.templateId === targetId);
          if (matched) return matched.id;
        }
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }
        return nextSessions[0]?.id;
      });
      setPendingSessions(null);
      setPickerManual(false);
    });

    const removeAgentStatusListener = window.terminalApi.onAgentStatus((payload) => {
      setAgentStatusesBySessionId((current) => ({
        ...current,
        [payload.id]: payload
      }));
    });

    return () => {
      isDisposed = true;
      removeSessionsListener();
      removeAgentStatusListener();
    };
  }, []);

  const createSession = useCallback(async ({ selectedShellId, title, initialCommand }: CreateSessionOptions) => {
    const isWsl = selectedShellId.startsWith("wsl:");
    const session = await window.terminalApi.createSession({
      type: isWsl ? "wsl" : "windows",
      ...(isWsl ? { wslDistro: selectedShellId.slice(4) } : {}),
      ...(title ? { title } : {}),
      ...(initialCommand ? { initialCommand } : {})
    });
    setActiveId(session.id);
  }, []);

  const closeSession = useCallback(async (id: string) => {
    await window.terminalApi.closeSession(id);
  }, []);

  const updateSession = useCallback(async (id: string, title: string, initialCommand: string, quickCommands?: QuickCommand[]) => {
    await window.terminalApi.updateSession(id, {
      title,
      initialCommand: initialCommand.trim() || undefined,
      quickCommands
    });
  }, []);

  const openPicker = useCallback(async () => {
    const library = await window.terminalApi.loadSavedSessions();
    setPendingSessions(library);
    setPickerManual(true);
  }, []);

  const launchSessions = useCallback(async (toLaunch: TerminalSession[]) => {
    pendingSelectTemplateId.current = toLaunch[0]?.id;
    await window.terminalApi.launchSessions(toLaunch);
  }, []);

  const startFresh = useCallback(async () => {
    await window.terminalApi.launchSessions([]);
  }, []);

  const deleteFromLibrary = useCallback(async (id: string) => {
    await window.terminalApi.deleteSavedSession(id);
    setPendingSessions((prev) => prev ? prev.filter((session) => session.id !== id) : null);
  }, []);

  const reorderLibrary = useCallback(async (orderedSessions: TerminalSession[]) => {
    setPendingSessions(orderedSessions);
    await window.terminalApi.reorderSavedSessions(orderedSessions.map(s => s.id));
  }, []);

  const reorderRunningSessions = useCallback(async (orderedIds: string[]) => {
    setSessions(prev => {
      const map = new Map(prev.map(s => [s.id, s]));
      return orderedIds
        .filter(id => map.has(id))
        .map(id => map.get(id)!);
    });
    await window.terminalApi.reorderRunningSessions(orderedIds);
  }, []);

  return {
    sessions,
    activeId,
    setActiveId,
    activeSession,
    agentStatusesBySessionId,
    activeAgentStatus,
    quickCommandsForActiveSession,
    pendingSessions,
    setPendingSessions,
    pickerManual,
    setPickerManual,
    createSession,
    closeSession,
    updateSession,
    openPicker,
    launchSessions,
    startFresh,
    deleteFromLibrary,
    reorderLibrary,
    reorderRunningSessions
  };
}
