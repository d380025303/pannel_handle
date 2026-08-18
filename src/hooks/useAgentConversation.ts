import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConversationSnapshot } from "../vite-env";

type MessageMarker = {
  sessionId: string | null;
  lastMessageId: string | null;
};

export function useAgentConversation(activeSessionId: string | undefined, visible: boolean) {
  const [snapshot, setSnapshot] = useState<AgentConversationSnapshot | null>(null);
  const [unread, setUnread] = useState(false);
  const markerRef = useRef<MessageMarker | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (visible) setUnread(false);
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
      setSnapshot(nextSnapshot);
    };

    void window.agentConversationApi.getSnapshot().then(applySnapshot);
    const removeListener = window.agentConversationApi.onSnapshot(applySnapshot);
    return () => {
      disposed = true;
      removeListener();
    };
  }, []);

  const markRead = useCallback(() => setUnread(false), []);

  return { snapshot, unread, markRead };
}
