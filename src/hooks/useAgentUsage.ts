import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatusPayload, AgentUsageResetResult, AgentUsageSnapshot, TerminalSession } from "../vite-env";

export const AGENT_USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const CODEBUDDY_USAGE_POLL_INTERVAL_MS = 60 * 1000;
export const QODER_USAGE_POLL_INTERVAL_MS = 60 * 1000;

export type AgentUsageViewState =
  | { status: "hidden" }
  | { status: "loading"; provider: "codex" | "codebuddy" | "qoder" | "copilot" | "gemini" | "grok" }
  | { status: "ready"; snapshot: AgentUsageSnapshot; refreshing: boolean }
  | { status: "error"; provider: "codex" | "codebuddy" | "qoder" | "copilot" | "gemini" | "grok" };

export function useAgentUsage(session?: TerminalSession, agentStatus?: AgentStatusPayload) {
  const sessionId = session?.id;
  const provider = session?.agentProvider === "codex" || session?.agentProvider === "codebuddy" || session?.agentProvider === "qoder" || session?.agentProvider === "copilot" || session?.agentProvider === "gemini" || session?.agentProvider === "grok"
    ? session.agentProvider
    : undefined;
  const isSupported = (provider === "codex" && session?.codexBackend !== "openrouter")
    || provider === "copilot" || provider === "grok"
    || (provider === "codebuddy" && session?.type === "windows")
    || (provider === "qoder" && (session?.type === "windows" || session?.type === "wsl"))
    || (provider === "gemini" && (session?.type === "windows" || session?.type === "wsl"));
  const [state, setState] = useState<AgentUsageViewState>({ status: "hidden" });
  const requestSequenceRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const load = useCallback(async (force = false) => {
    if (!sessionId || !provider || !isSupported) return;
    if (provider === "copilot" || provider === "grok") {
      setState({ status: "error", provider });
      return;
    }
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

    if (provider === "copilot" || provider === "grok") {
      setState({ status: "error", provider });
      return;
    }

    void load(false);
    const pollIntervalMs = provider === "codebuddy"
      ? CODEBUDDY_USAGE_POLL_INTERVAL_MS
      : provider === "qoder"
        ? QODER_USAGE_POLL_INTERVAL_MS
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

  const consumeResetCredit = useCallback(async (
    creditId: string,
    idempotencyKey: string
  ): Promise<AgentUsageResetResult | undefined> => {
    if (!sessionId || provider !== "codex") throw new Error("Codex usage reset is unavailable.");
    const requestedSessionId = sessionId;
    const result = await window.agentUsageApi.consumeResetCredit(requestedSessionId, creditId, idempotencyKey);
    if (sessionIdRef.current !== requestedSessionId) return undefined;
    if (result.snapshot) {
      requestSequenceRef.current += 1;
      setState({ status: "ready", snapshot: result.snapshot, refreshing: false });
    }
    return result;
  }, [provider, sessionId]);

  return {
    state,
    refresh: () => load(true),
    consumeResetCredit
  };
}
