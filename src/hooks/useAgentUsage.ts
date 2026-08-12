import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatusPayload, AgentUsageSnapshot, TerminalSession } from "../vite-env";

export const AGENT_USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;

export type AgentUsageViewState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "ready"; snapshot: AgentUsageSnapshot; refreshing: boolean }
  | { status: "error" };

export function useAgentUsage(session?: TerminalSession, agentStatus?: AgentStatusPayload) {
  const sessionId = session?.id;
  const isCodex = session?.agentProvider === "codex";
  const [state, setState] = useState<AgentUsageViewState>({ status: "hidden" });
  const requestSequenceRef = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!sessionId || !isCodex) return;
    const requestSequence = ++requestSequenceRef.current;
    setState((current) => current.status === "ready"
      ? { ...current, refreshing: true }
      : { status: "loading" });
    try {
      const snapshot = await window.agentUsageApi.getUsage(sessionId, { force });
      if (requestSequenceRef.current === requestSequence) {
        setState({ status: "ready", snapshot, refreshing: false });
      }
    } catch {
      if (requestSequenceRef.current === requestSequence) {
        setState({ status: "error" });
      }
    }
  }, [isCodex, sessionId]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    if (!sessionId || !isCodex) {
      setState({ status: "hidden" });
      return;
    }

    void load(false);
    const intervalId = window.setInterval(() => void load(false), AGENT_USAGE_POLL_INTERVAL_MS);
    return () => {
      requestSequenceRef.current += 1;
      window.clearInterval(intervalId);
      window.agentUsageApi.cancel(sessionId);
    };
  }, [isCodex, load, sessionId]);

  useEffect(() => {
    if (isCodex && sessionId && agentStatus?.id === sessionId && agentStatus.status === "completed") {
      void load(true);
    }
  }, [agentStatus?.id, agentStatus?.status, agentStatus?.timestamp, isCodex, load, sessionId]);

  return {
    state,
    refresh: () => load(true)
  };
}
