import { useEffect, useState } from "react";
import type { AgentTokenLiveSnapshot, TerminalSession } from "../vite-env";

export type AgentTokenLiveViewState =
  | { status: "hidden" }
  | { status: "loading"; provider: "codex" | "claude" | "codebuddy" }
  | { status: "waiting"; provider: "codex" | "claude" | "codebuddy" }
  | { status: "ready"; snapshot: AgentTokenLiveSnapshot };

export function useAgentTokenLive(session?: TerminalSession) {
  const provider = session?.agentProvider === "codex" || session?.agentProvider === "claude" || session?.agentProvider === "codebuddy"
    ? session.agentProvider
    : undefined;
  const supported = Boolean(provider && (session?.type === "windows" || session?.type === "wsl" || session?.type === "ssh"));
  const sessionId = session?.id;
  const [state, setState] = useState<AgentTokenLiveViewState>({ status: "hidden" });

  useEffect(() => {
    let disposed = false;
    if (!supported || !provider || !sessionId) {
      setState({ status: "hidden" });
      return;
    }

    setState({ status: "loading", provider });
    void window.agentTokenStatsApi.getLive(sessionId)
      .then((snapshot) => {
        if (disposed) return;
        setState(snapshot ? { status: "ready", snapshot } : { status: "waiting", provider });
      })
      .catch(() => {
        if (!disposed) setState({ status: "waiting", provider });
      });
    const removeListener = window.agentTokenStatsApi.onLiveChanged((snapshot) => {
      if (!disposed && snapshot.panelSessionId === sessionId) {
        setState({ status: "ready", snapshot });
      }
    });
    return () => {
      disposed = true;
      removeListener();
    };
  }, [provider, sessionId, supported]);

  return state;
}
