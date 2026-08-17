import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatusPayload, AgentUsageSnapshot, TerminalSession } from "../vite-env";

export const AGENT_USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const CODEBUDDY_USAGE_POLL_INTERVAL_MS = 60 * 1000;

export type AgentUsageViewState =
  | { status: "hidden" }
  | { status: "loading"; provider: "codex" | "codebuddy" }
  | { status: "ready"; snapshot: AgentUsageSnapshot; refreshing: boolean }
  | { status: "error"; provider: "codex" | "codebuddy" };

export function useAgentUsage(session?: TerminalSession, agentStatus?: AgentStatusPayload) {
  const sessionId = session?.id;
  const provider = session?.agentProvider === "codex" || session?.agentProvider === "codebuddy"
    ? session.agentProvider
    : undefined;
  const isSupported = provider === "codex" || (provider === "codebuddy" && session?.type === "windows");
  const [state, setState] = useState<AgentUsageViewState>({ status: "hidden" });
  const requestSequenceRef = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!sessionId || !provider || !isSupported) return;
    const requestSequence = ++requestSequenceRef.current;
    setState((current) => current.status === "ready"
      ? { ...current, refreshing: true }
      : { status: "loading", provider });
    try {
      const snapshot = await window.agentUsageApi.getUsage(sessionId, { force });
      if (requestSequenceRef.current === requestSequence) {
        setState({ status: "ready", snapshot, refreshing: false });
      }
    } catch {
      if (requestSequenceRef.current === requestSequence) {
        setState({ status: "error", provider });
      }
    }
  }, [isSupported, provider, sessionId]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    if (!sessionId || !provider || !isSupported) {
      setState({ status: "hidden" });
      return;
    }

    void load(false);
    const pollIntervalMs = provider === "codebuddy"
      ? CODEBUDDY_USAGE_POLL_INTERVAL_MS
      : AGENT_USAGE_POLL_INTERVAL_MS;
    const intervalId = window.setInterval(() => void load(false), pollIntervalMs);
    return () => {
      requestSequenceRef.current += 1;
      window.clearInterval(intervalId);
      window.agentUsageApi.cancel(sessionId);
    };
  }, [isSupported, load, provider, sessionId]);

  useEffect(() => {
    if (isSupported && sessionId && agentStatus?.id === sessionId && agentStatus.status === "completed") {
      void load(true);
    }
  }, [agentStatus?.id, agentStatus?.status, agentStatus?.timestamp, isSupported, load, sessionId]);

  return {
    state,
    refresh: () => load(true)
  };
}
