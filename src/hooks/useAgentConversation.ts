import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConversationAppend, AgentConversationSnapshot } from "../vite-env";

type MessageMarker = {
  sessionId: string | null;
  lastMessageId: string | null;
};

export function useAgentConversation(activeSessionId: string | undefined, visible: boolean) {
  const [snapshot, setSnapshot] = useState<AgentConversationSnapshot | null>(null);
  const [unread, setUnread] = useState(false);
  const markerRef = useRef<MessageMarker | null>(null);
  const pendingRef = useRef<AgentConversationSnapshot | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (visible) {
      setUnread(false);
      const pending = pendingRef.current;
      if (pending) setSnapshot({ ...pending, turn: pending.turn ? { ...pending.turn, messages: [...pending.turn.messages] } : null });
    }
  }, [visible]);

  useEffect(() => {
    window.agentConversationApi.setActiveSession(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    let disposed = false;
    const applySnapshot = (nextSnapshot: AgentConversationSnapshot) => {
      if (disposed) return;
      const nextMarker = {
        sessionId: nextSnapshot.activeSessionId,
        lastMessageId: nextSnapshot.turn?.messages.at(-1)?.id || null
      };
      const previousMarker = markerRef.current;
      if (
        previousMarker
        && previousMarker.sessionId === nextMarker.sessionId
        && nextMarker.lastMessageId
        && nextMarker.lastMessageId !== previousMarker.lastMessageId
        && !visibleRef.current
      ) {
        setUnread(true);
      }
      if (!previousMarker || previousMarker.sessionId !== nextMarker.sessionId) {
        setUnread(false);
      }
      markerRef.current = nextMarker;
      pendingRef.current = { ...nextSnapshot, turn: nextSnapshot.turn ? { ...nextSnapshot.turn, messages: [...nextSnapshot.turn.messages] } : null };
      setSnapshot(nextSnapshot);
    };

    const applyAppend = (update: AgentConversationAppend) => {
      if (disposed) return;
      const pending = pendingRef.current;
      if (!pending?.turn || pending.activeSessionId !== update.sessionId) return;
      const messages = pending.turn.messages;
      // An initial snapshot may already contain some of a queued append.
      if (update.startIndex > messages.length) return;
      const added = update.messages.slice(Math.max(0, messages.length - update.startIndex));
      if (!added.length) return;
      for (const message of added) messages.push(message);
      markerRef.current = { sessionId: update.sessionId, lastMessageId: messages.at(-1)?.id || null };
      if (visibleRef.current) {
        setSnapshot({ ...pending, turn: { ...pending.turn, messages: [...messages] } });
      } else {
        setUnread(true);
      }
    };
    let loading = true;
    const queued: Array<() => void> = [];
    const receive = (apply: () => void) => {
      if (disposed) return;
      if (loading) queued.push(apply);
      else apply();
    };
    const removeListener = window.agentConversationApi.onSnapshot(value => receive(() => applySnapshot(value)));
    const removeAppendListener = window.agentConversationApi.onAppend(value => receive(() => applyAppend(value)));
    void window.agentConversationApi.getSnapshot().then(value => {
      if (disposed) return;
      applySnapshot(value);
      loading = false;
      for (const apply of queued) apply();
      queued.length = 0;
    });
    return () => {
      disposed = true;
      removeListener();
      removeAppendListener();
    };
  }, []);

  const markRead = useCallback(() => setUnread(false), []);

  return { snapshot, unread, markRead };
}
