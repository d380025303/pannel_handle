import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatusPayload, AppConfig, QuickCommand, SshConfig, TerminalSession } from "../vite-env";

type CreateSessionOptions = {
  selectedShellId: string;
  title?: string;
  cwd?: string;
  initialCommand?: string;
  sshConfig?: SshConfig;
  tags?: string[];
};

export function useTerminalSessions() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [pendingSessions, setPendingSessions] = useState<TerminalSession[] | null>(null);
  const [librarySessions, setLibrarySessions] = useState<TerminalSession[]>([]);
  const [pickerManual, setPickerManual] = useState(false);
  const [autoRestore, setAutoRestore] = useState<boolean>(true);
  const [agentStatusesBySessionId, setAgentStatusesBySessionId] = useState<Record<string, AgentStatusPayload>>({});
  const pendingSelectTemplateId = useRef<string | undefined>(undefined);
  const hasAutoRestored = useRef(false);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [activeId, sessions]
  );
  const activeAgentStatus = activeId ? agentStatusesBySessionId[activeId] : undefined;

  const quickCommandsForActiveSession = useMemo(
    () => activeSession?.quickCommands ?? [],
    [activeSession]
  );
  const tagSuggestions = useMemo(() => {
    const tags = new Map<string, string>();
    for (const session of librarySessions) {
      for (const tag of session.tags ?? []) {
        const key = tag.toLowerCase();
        if (!tags.has(key)) tags.set(key, tag);
      }
    }
    return Array.from(tags.values()).sort((a, b) => a.localeCompare(b));
  }, [librarySessions]);

  useEffect(() => {
    let isDisposed = false;

    Promise.all([
      window.terminalApi.loadSavedSessions(),
      window.terminalApi.getConfig()
    ]).then(([saved, config]) => {
      if (isDisposed) return;

      setAutoRestore(config.autoRestore);
      setLibrarySessions(saved);

      if (!hasAutoRestored.current && config.autoRestore && config.lastActiveSessionIds.length > 0) {
        hasAutoRestored.current = true;
        const toRestore: TerminalSession[] = [];
        for (const id of config.lastActiveSessionIds) {
          const template = saved.find(s => s.id === id);
          if (template) toRestore.push(template);
        }
        if (toRestore.length > 0) {
          pendingSelectTemplateId.current = toRestore[0]?.id;
          window.terminalApi.launchSessions(toRestore);
          return;
        }
      }
      setPendingSessions(null);
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
        console.log("[onSessionsChanged] pendingSelectTemplateId:", pendingSelectTemplateId.current, "current activeId:", current, "nextSessions:", nextSessions.map(s => ({ id: s.id, templateId: s.templateId, title: s.title })));
        if (pendingSelectTemplateId.current) {
          const targetId = pendingSelectTemplateId.current;
          pendingSelectTemplateId.current = undefined;
          const matched = nextSessions.find(s => s.templateId === targetId);
          console.log("[onSessionsChanged] looking for templateId:", targetId, "matched:", matched?.id);
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

  const createSession = useCallback(async ({ selectedShellId, title, cwd, initialCommand, sshConfig, tags }: CreateSessionOptions) => {
    const isWsl = selectedShellId.startsWith("wsl:");
    const isSsh = selectedShellId === "ssh";
    const session = await window.terminalApi.createSession({
      type: isSsh ? "ssh" : isWsl ? "wsl" : "windows",
      ...(isWsl ? { wslDistro: selectedShellId.slice(4) } : {}),
      ...(isSsh ? { sshConfig } : {}),
      ...(title ? { title } : {}),
      ...(cwd ? { cwd } : {}),
      ...(initialCommand ? { initialCommand } : {}),
      tags
    });
    setLibrarySessions(await window.terminalApi.loadSavedSessions());
    setActiveId(session.id);
  }, []);

  const closeSession = useCallback(async (id: string) => {
    await window.terminalApi.closeSession(id);
  }, []);

  const updateSession = useCallback(async (id: string, title: string, cwd: string, initialCommand: string, quickCommands?: QuickCommand[], sshConfig?: SshConfig, tags?: string[]) => {
    await window.terminalApi.updateSession(id, {
      title,
      cwd,
      initialCommand: initialCommand.trim() || undefined,
      sshConfig,
      quickCommands,
      tags
    });
    setLibrarySessions(await window.terminalApi.loadSavedSessions());
  }, []);

  const openPicker = useCallback(async () => {
    const library = await window.terminalApi.loadSavedSessions();
    setLibrarySessions(library);
    setPendingSessions(library);
    setPickerManual(true);
  }, []);

  const launchSessions = useCallback(async (toLaunch: TerminalSession[]) => {
    pendingSelectTemplateId.current = toLaunch[0]?.id;
    console.log("[launchSessions] pendingSelectTemplateId set:", pendingSelectTemplateId.current, "toLaunch:", toLaunch.map(s => s.id));
    await window.terminalApi.launchSessions(toLaunch);
  }, []);

  const startFresh = useCallback(async () => {
    await window.terminalApi.launchSessions([]);
  }, []);

  const deleteFromLibrary = useCallback(async (id: string) => {
    await window.terminalApi.deleteSavedSession(id);
    setLibrarySessions((prev) => prev.filter((session) => session.id !== id));
    setPendingSessions((prev) => prev ? prev.filter((session) => session.id !== id) : null);
  }, []);

  const reorderLibrary = useCallback(async (orderedSessions: TerminalSession[]) => {
    setPendingSessions(orderedSessions);
    setLibrarySessions(orderedSessions);
    await window.terminalApi.reorderSavedSessions(orderedSessions.map(s => s.id));
  }, []);

  const updateLibraryTags = useCallback(async (id: string, tags: string[]) => {
    await window.terminalApi.updateSession(id, { tags });
    const library = await window.terminalApi.loadSavedSessions();
    setLibrarySessions(library);
    setPendingSessions(library);
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

  const toggleAutoRestore = useCallback(async () => {
    const config = await window.terminalApi.getConfig();
    const next = !config.autoRestore;
    await window.terminalApi.setConfig({ autoRestore: next });
    setAutoRestore(next);
  }, []);

  return {
    sessions,
    activeId,
    setActiveId,
    activeSession,
    agentStatusesBySessionId,
    activeAgentStatus,
    quickCommandsForActiveSession,
    tagSuggestions,
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
    updateLibraryTags,
    reorderRunningSessions,
    autoRestore,
    toggleAutoRestore
  };
}
