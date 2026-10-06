import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { ConnectionStatus, RuntimeSession, ServerMessage } from "./types";

type TextDraft = { text: string; version: number };
type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.delta" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "graphical.result" | "graphical.opencode.auth-data" | "graphical.opencode.auth-state" | "command.ok" | "error" }>;

export function useSessionDrafts(sessions: RuntimeSession[], status: ConnectionStatus,
  onGraphicalMessage: (listener: (message: GraphicalMessage) => void) => () => void) {
  const [graphicalDrafts, setGraphicalDrafts] = useState<Record<string, TextDraft>>({});
  const [pasteDrafts, setPasteDrafts] = useState<Record<string, string>>({});
  const [pasteOpenBySession, setPasteOpenBySession] = useState<Record<string, boolean>>({});
  const [pendingBySession, setPendingBySession] = useState<Record<string, string>>({});
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const removedDrafts = useRef(new Map<string, TextDraft>());
  const pendingSubmissions = useRef(new Map<string, { sessionId: string; version: number }>());

  const updateGraphicalDraft = useCallback((sessionId: string, update: SetStateAction<string>) => {
    setGraphicalDrafts(current => {
      const previous = current[sessionId] ?? { text: "", version: 0 };
      const text = typeof update === "function" ? update(previous.text) : update;
      if (text === previous.text) return current;
      return { ...current, [sessionId]: { text, version: previous.version + 1 } };
    });
  }, []);

  useEffect(() => {
    const unsubscribe = onGraphicalMessage(message => {
      if (message.type === "graphical.result") {
        const result = message.result as { id?: string; previousSessionId?: string } | null;
        if (result?.previousSessionId === message.sessionId && typeof result.id === "string") {
          const replacementId = result.id, recovered = removedDrafts.current.get(message.sessionId);
          removedDrafts.current.delete(message.sessionId);
          setGraphicalDrafts(current => { const previous = current[message.sessionId] || recovered; return previous?.text && !current[replacementId]?.text ? { ...current, [replacementId]: previous } : current; });
        }
        return;
      }
      if (message.type !== "command.ok" && message.type !== "error") return;
      if (!message.requestId) return;
      const pending = pendingSubmissions.current.get(message.requestId);
      if (!pending) return;
      pendingSubmissions.current.delete(message.requestId);
      setPendingBySession(current => {
        if (current[pending.sessionId] !== message.requestId) return current;
        const next = { ...current };
        delete next[pending.sessionId];
        return next;
      });
      if (message.type === "command.ok") setGraphicalDrafts(current => {
        const draft = current[pending.sessionId];
        if (!draft || draft.version !== pending.version) return current;
        return { ...current, [pending.sessionId]: { text: "", version: draft.version + 1 } };
      });
    });
    return () => { unsubscribe(); };
  }, [onGraphicalMessage]);

  useEffect(() => {
    if (status !== "connected") return;
    const ids = new Set(sessions.map(session => session.id));
    setGraphicalDrafts(current => {
      for (const [id, draft] of Object.entries(current)) if (!ids.has(id) && draft.text) removedDrafts.current.set(id, draft);
      while (removedDrafts.current.size > 32) removedDrafts.current.delete(removedDrafts.current.keys().next().value!);
      return Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
    });
    setPasteDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    setPasteOpenBySession(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    setPendingBySession(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    for (const [requestId, pending] of pendingSubmissions.current) {
      if (!ids.has(pending.sessionId)) pendingSubmissions.current.delete(requestId);
    }
  }, [sessions, status]);

  useEffect(() => {
    if (status === "connected" || pendingSubmissions.current.size === 0) return;
    pendingSubmissions.current.clear();
    setPendingBySession({});
    setRecoveryNotice("连接中断，发送结果未确认；请核对会话内容后再重试。草稿已保留。");
  }, [status]);

  const trackGraphicalSubmit = (sessionId: string, requestId: string) => {
    pendingSubmissions.current.set(requestId, { sessionId, version: graphicalDrafts[sessionId]?.version ?? 0 });
    setPendingBySession(current => ({ ...current, [sessionId]: requestId }));
  };

  const setPasteText = (sessionId: string, update: SetStateAction<string>) =>
    setPasteDrafts(current => ({ ...current, [sessionId]: typeof update === "function" ? update(current[sessionId] ?? "") : update }));
  const setPasteOpen = (sessionId: string, open: boolean) =>
    setPasteOpenBySession(current => ({ ...current, [sessionId]: open }));

  return { graphicalDrafts, pasteDrafts, pasteOpenBySession, pendingBySession, recoveryNotice,
    setRecoveryNotice, updateGraphicalDraft, trackGraphicalSubmit, setPasteText, setPasteOpen };
}
