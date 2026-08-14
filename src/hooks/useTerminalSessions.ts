import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentLocation, AgentProvider, AgentStatusPayload, AppConfig, LaunchTemplate, LaunchTemplateResult, LaunchTemplateSaveInput, QuickCommand, SshConfig, TerminalSession } from "../vite-env";
import { updateAgentStatuses } from "../utils/agentStatus";
import { generateId } from "../utils/id";

type CreateSessionOptions = {
  selectedShellId: string;
  title?: string;
  cwd?: string;
  initialCommand?: string;
  agentProvider?: AgentProvider;
  agentLocation?: AgentLocation;
  sshConfig?: SshConfig;
  tags?: string[];
};

export function useTerminalSessions() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [pendingSessions, setPendingSessions] = useState<TerminalSession[] | null>(null);
  const [librarySessions, setLibrarySessions] = useState<TerminalSession[]>([]);
  const [launchTemplates, setLaunchTemplates] = useState<LaunchTemplate[]>([]);
  const [pickerManual, setPickerManual] = useState(false);
  const [autoRestore, setAutoRestore] = useState<boolean>(true);
  const [agentStatusesBySessionId, setAgentStatusesBySessionId] = useState<Record<string, AgentStatusPayload>>({});
  const [startupError, setStartupError] = useState<string | null>(null);
  const hasAutoRestored = useRef(false);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [activeId, sessions]
  );
  const activeAgentStatus = activeId ? agentStatusesBySessionId[activeId] : undefined;

  const quickCommandsForActiveSession = useMemo(
    () => (activeSession?.quickCommands ?? []).map((qc) => ({ ...qc, mode: qc.mode || 'write' as const })),
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
      window.terminalApi.getConfig(),
      window.launchTemplateApi.list()
    ]).then(([saved, config, savedLaunchTemplates]) => {
      if (isDisposed) return;

      setAutoRestore(config.autoRestore);
      setLibrarySessions(saved);
      setLaunchTemplates(savedLaunchTemplates);

      if (!hasAutoRestored.current && config.autoRestore && config.lastActiveSessionIds.length > 0) {
        hasAutoRestored.current = true;
        const toRestore: TerminalSession[] = [];
        for (const id of config.lastActiveSessionIds) {
          const template = saved.find(s => s.id === id);
          if (template) toRestore.push(template);
        }
        if (toRestore.length > 0) {
          const targetTemplateId = toRestore[0]?.id;
          window.terminalApi.launchSessions(toRestore, "restore").then((updatedSessions) => {
            if (isDisposed) return;
            const matches = updatedSessions.filter(s => s.templateId === targetTemplateId);
            const newest = matches[matches.length - 1];
            if (newest) setActiveId(newest.id);
          }).catch((err) => {
            if (isDisposed) return;
            setStartupError(err?.message || String(err));
            setPendingSessions(saved);
          });
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
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }
        return nextSessions[0]?.id;
      });
    });

    const removeAgentStatusListener = window.terminalApi.onAgentStatus((payload) => {
      setAgentStatusesBySessionId((current) => updateAgentStatuses(current, payload));
    });

    return () => {
      isDisposed = true;
      removeSessionsListener();
      removeAgentStatusListener();
    };
  }, []);

  const createSession = useCallback(async ({ selectedShellId, title, cwd, initialCommand, agentProvider, agentLocation, sshConfig, tags }: CreateSessionOptions) => {
    const isWsl = selectedShellId.startsWith("wsl:");
    const isSsh = selectedShellId === "ssh";
    const session = await window.terminalApi.createSession({
      type: isSsh ? "ssh" : isWsl ? "wsl" : "windows",
      ...(isWsl ? { wslDistro: selectedShellId.slice(4) } : {}),
      ...(isSsh ? { sshConfig } : {}),
      ...(title ? { title } : {}),
      ...(cwd ? { cwd } : {}),
      ...(initialCommand ? { initialCommand } : {}),
      ...(agentProvider ? { agentProvider } : {}),
      ...(isSsh && agentProvider ? { agentLocation: agentLocation || "remote" } : {}),
      tags
    });
    setLibrarySessions(await window.terminalApi.loadSavedSessions());
    setActiveId(session.id);
  }, []);

  const closeSession = useCallback(async (id: string) => {
    await window.terminalApi.closeSession(id);
  }, []);

  const updateSession = useCallback(async (id: string, title: string, cwd: string, initialCommand: string, agentProvider?: AgentProvider, agentLocation?: AgentLocation, quickCommands?: QuickCommand[], sshConfig?: SshConfig, tags?: string[]) => {
    await window.terminalApi.updateSession(id, {
      title,
      cwd,
      initialCommand: initialCommand.trim(),
      agentProvider: agentProvider ?? null,
      agentLocation: agentProvider ? agentLocation ?? null : null,
      sshConfig,
      quickCommands,
      tags
    });
    setLibrarySessions(await window.terminalApi.loadSavedSessions());
  }, []);

  const addQuickCommandToActiveSession = useCallback(async (command: string, mode: QuickCommand['mode']) => {
    const id = activeId;
    const session = activeSession;
    if (!id || !session) return;
    const newCmd: QuickCommand = { id: generateId(), command, mode };
    const updated = [...(session.quickCommands ?? []), newCmd];
    await updateSession(id, session.title, session.cwd, session.initialCommand ?? '', session.agentProvider, session.agentLocation, updated, session.sshConfig, session.tags);
  }, [activeId, activeSession, updateSession]);

  const removeQuickCommandFromActiveSession = useCallback(async (commandId: string) => {
    const id = activeId;
    const session = activeSession;
    if (!id || !session) return;
    const updated = (session.quickCommands ?? []).filter((qc) => qc.id !== commandId);
    await updateSession(id, session.title, session.cwd, session.initialCommand ?? '', session.agentProvider, session.agentLocation, updated, session.sshConfig, session.tags);
  }, [activeId, activeSession, updateSession]);

  const openPicker = useCallback(async () => {
    const [library, savedLaunchTemplates] = await Promise.all([
      window.terminalApi.loadSavedSessions(),
      window.launchTemplateApi.list()
    ]);
    setLibrarySessions(library);
    setLaunchTemplates(savedLaunchTemplates);
    setPendingSessions(library);
    setPickerManual(true);
  }, []);

  const exportLibrary = useCallback(async () => {
    return window.terminalApi.exportSavedSessions();
  }, []);

  const importLibrary = useCallback(async () => {
    const result = await window.terminalApi.importSavedSessions();
    if (!result.canceled && result.ok) {
      setLibrarySessions(result.sessions);
      setPendingSessions(result.sessions);
    }
    return result;
  }, []);

  const launchSessions = useCallback(async (toLaunch: TerminalSession[]) => {
    setStartupError(null);
    try {
      const targetTemplateId = toLaunch[0]?.id;
      const updatedSessions = await window.terminalApi.launchSessions(toLaunch, "manual");
      if (targetTemplateId) {
        const matches = updatedSessions.filter(s => s.templateId === targetTemplateId);
        const newest = matches[matches.length - 1];
        if (newest) setActiveId(newest.id);
      }
      setPendingSessions(null);
      setPickerManual(false);
    } catch (err: any) {
      setStartupError(err?.message || String(err));
      throw err;
    }
  }, []);

  const startFresh = useCallback(async () => {
    await window.terminalApi.launchSessions([], "manual");
    setPendingSessions(null);
    setPickerManual(false);
  }, []);

  const deleteFromLibrary = useCallback(async (id: string) => {
    await window.terminalApi.deleteSavedSession(id);
    setLibrarySessions((prev) => prev.filter((session) => session.id !== id));
    setPendingSessions((prev) => prev ? prev.filter((session) => session.id !== id) : null);
    setLaunchTemplates(await window.launchTemplateApi.list());
  }, []);

  const createLaunchTemplate = useCallback(async (input: LaunchTemplateSaveInput) => {
    const created = await window.launchTemplateApi.create(input);
    setLaunchTemplates((current) => [...current, created]);
    return created;
  }, []);

  const updateLaunchTemplate = useCallback(async (id: string, input: LaunchTemplateSaveInput) => {
    const updated = await window.launchTemplateApi.update(id, input);
    setLaunchTemplates((current) => current.map(item => item.id === id ? updated : item));
    return updated;
  }, []);

  const deleteLaunchTemplate = useCallback(async (id: string) => {
    const next = await window.launchTemplateApi.delete(id);
    setLaunchTemplates(next);
  }, []);

  const launchLaunchTemplate = useCallback(async (id: string): Promise<LaunchTemplateResult> => {
    const result = await window.launchTemplateApi.launch(id);
    if (result.launchedSessionIds[0]) setActiveId(result.launchedSessionIds[0]);
    if (result.failures.length === 0) {
      setPendingSessions(null);
      setPickerManual(false);
    }
    return result;
  }, []);

  const duplicateFromLibrary = useCallback(async (id: string) => {
    const duplicated = await window.terminalApi.duplicateSession(id);
    setLibrarySessions((prev) => [...prev, duplicated]);
    setPendingSessions((prev) => prev ? [...prev, duplicated] : null);
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
    startupError,
    clearStartupError: () => setStartupError(null),
    quickCommandsForActiveSession,
    tagSuggestions,
    launchTemplates,
    pendingSessions,
    setPendingSessions,
    pickerManual,
    setPickerManual,
    createSession,
    closeSession,
    updateSession,
    openPicker,
    exportLibrary,
    importLibrary,
    launchSessions,
    startFresh,
    deleteFromLibrary,
    duplicateFromLibrary,
    createLaunchTemplate,
    updateLaunchTemplate,
    deleteLaunchTemplate,
    launchLaunchTemplate,
    reorderRunningSessions,
    autoRestore,
    toggleAutoRestore,
    addQuickCommandToActiveSession,
    removeQuickCommandFromActiveSession
  };
}
