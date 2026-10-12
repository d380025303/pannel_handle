import { normalizeGraphicalMenuConfig, type GraphicalMenuConfig } from "../../src/utils/graphicalMenu";
import { useCallback, useRef, useState } from "react";
import { useRemoteTransport } from "./useRemoteTransport";
import type { RuntimeSession, SavedTemplate, ServerMessage, SessionOverview, WorkItemMessage } from "./types";

type TerminalMessage = Extract<ServerMessage,
  { type: "terminal.snapshot" | "terminal.data" | "terminal.exit" | "terminal.size-owner" }>;
type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.delta" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "graphical.result" | "graphical.opencode.auth-data" | "graphical.opencode.auth-state" | "command.ok" | "error" }>;
type FileMessage = Extract<ServerMessage, { type: "files.list.result" | "files.download.ready" | "error" }>;

export function useRemoteConnection() {
  const [mobileGraphicalSessionMinimalMode, setMobileGraphicalSessionMinimalMode] = useState(false);
  const [graphicalMenuConfig, setGraphicalMenuConfig] = useState<GraphicalMenuConfig>({});
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [overviews, setOverviews] = useState<Record<string, SessionOverview>>({});
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [lastLaunchedId, setLastLaunchedId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState("");
  const terminalListenersRef = useRef(new Set<(message: TerminalMessage) => void>());
  const graphicalListenersRef = useRef(new Set<(message: GraphicalMessage) => void>());
  const workItemListenersRef = useRef(new Set<(message: WorkItemMessage) => void>());
  const fileListenersRef = useRef(new Set<(message: FileMessage) => void>());

  const onMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case "graphical-menu.changed":
        setGraphicalMenuConfig(normalizeGraphicalMenuConfig(message.config));
        break;
      case "mobile-preferences.changed":
        setMobileGraphicalSessionMinimalMode(message.mobileGraphicalSessionMinimalMode === true);
        break;
      case "ready":
        setMobileGraphicalSessionMinimalMode(message.payload.mobileGraphicalSessionMinimalMode === true);
        setGraphicalMenuConfig(normalizeGraphicalMenuConfig(message.payload.graphicalMenuSecondaryActions));
        setSessions(message.payload.sessions);
        setOverviews({});
        setTemplates(message.payload.templates);
        break;
      case "sessions.changed":
        setSessions(message.sessions);
        setOverviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => message.sessions.some(session => session.id === id))));
        break;
      case "session.overview":
        setOverviews(current => ({ ...current, [message.overview.sessionId]: message.overview }));
        break;
      case "templates.changed":
        setTemplates(message.templates);
        break;
      case "session.launched":
        setLastLaunchedId(message.sessionId);
        setCommandError("");
        break;
      case "terminal.snapshot":
      case "terminal.data":
      case "terminal.exit":
      case "terminal.size-owner":
        terminalListenersRef.current.forEach(listener => listener(message));
        break;
      case "graphical.snapshot":
      case "graphical.delta":
      case "graphical.usage":
      case "graphical.history":
      case "graphical.opencode.auth-data":
      case "graphical.opencode.auth-state":
      case "graphical.result":
      case "graphical.upload.ready":
      case "command.ok":
        graphicalListenersRef.current.forEach(listener => listener(message));
        break;
      case "work-items.result":
      case "work-items.changed":
        workItemListenersRef.current.forEach(listener => listener(message));
        break;
      case "files.list.result":
      case "files.download.ready":
        fileListenersRef.current.forEach(listener => listener(message));
        break;
      case "error":
        workItemListenersRef.current.forEach(listener => listener(message));
        graphicalListenersRef.current.forEach(listener => listener(message));
        fileListenersRef.current.forEach(listener => listener(message));
        if (!["PASSWORD_INVALID", "PASSWORD_CHANGED", "CONNECTION_CLOSED", "SERVICE_STOPPED", "AUTH_RATE_LIMIT", "AUTH_REQUIRED", "PROTOCOL_MISMATCH", "GRAPHICAL_COMMAND_FAILED", "FILE_COMMAND_FAILED", "WORK_ITEM_COMMAND_FAILED"].includes(message.code)) {
          setCommandError(message.message);
        }
        break;
    }
  }, []);

  const transport = useRemoteTransport(onMessage);
  const onTerminalMessage = useCallback((listener: (message: TerminalMessage) => void) => {
    terminalListenersRef.current.add(listener);
    return () => terminalListenersRef.current.delete(listener);
  }, []);
  const onGraphicalMessage = useCallback((listener: (message: GraphicalMessage) => void) => {
    graphicalListenersRef.current.add(listener);
    return () => graphicalListenersRef.current.delete(listener);
  }, []);
  const onFileMessage = useCallback((listener: (message: FileMessage) => void) => {
    fileListenersRef.current.add(listener);
    return () => fileListenersRef.current.delete(listener);
  }, []);

  const onWorkItemMessage = useCallback((listener: (message: WorkItemMessage) => void) => {
    workItemListenersRef.current.add(listener);
    return () => { workItemListenersRef.current.delete(listener); };
  }, []);
  return { ...transport, mobileGraphicalSessionMinimalMode, graphicalMenuConfig, sessions, overviews, templates, lastLaunchedId, commandError,
    onWorkItemMessage, onTerminalMessage, onGraphicalMessage, onFileMessage };
}
