import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionStatus, RuntimeSession } from "./types";

const ACTIVE_SESSION_STORAGE_KEY = "pannel-handle-mobile-active-session";

function readActiveSessionId() {
  try { return localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY); }
  catch { return null; }
}

export function useSessionNavigation(sessions: RuntimeSession[], status: ConnectionStatus, lastLaunchedId: string | null) {
  const [view, setView] = useState<"home" | "detail">("home");
  const [filesOpen, setFilesOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(readActiveSessionId);
  const handledLaunchedId = useRef<string | null>(null);
  const activeSession = useMemo(() => sessions.find(session => session.id === activeId) ?? null, [activeId, sessions]);

  useEffect(() => {
    if (status !== "connected") return;
    if (activeId && sessions.some(session => session.id === activeId)) return;
    setActiveId(sessions[0]?.id ?? null);
  }, [activeId, sessions, status]);

  useEffect(() => {
    if (lastLaunchedId && handledLaunchedId.current !== lastLaunchedId
      && sessions.some(session => session.id === lastLaunchedId)) {
      handledLaunchedId.current = lastLaunchedId;
      setActiveId(lastLaunchedId);
      setView("detail");
      setFilesOpen(false);
      setDrawerOpen(false);
    }
  }, [lastLaunchedId, sessions]);

  useEffect(() => {
    if (status === "connected" && view === "detail" && !activeSession) setView("home");
  }, [activeSession, status, view]);

  useEffect(() => {
    if (status !== "connected") return;
    if (activeId && !sessions.some(session => session.id === activeId)) return;
    try {
      if (activeId) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeId);
      else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    } catch { /* Session selection still works when browser storage is unavailable. */ }
  }, [activeId, sessions, status]);

  const openSession = (sessionId: string) => {
    setActiveId(sessionId);
    setView("detail");
    setFilesOpen(false);
    setDrawerOpen(false);
  };

  return { view, setView, filesOpen, setFilesOpen, drawerOpen, setDrawerOpen, activeId, activeSession, openSession };
}
