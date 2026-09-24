import { useEffect, useState } from "react";
import type { AgentTokenLiveViewState } from "./useAgentTokenLive";
import type { CodexAppServerSnapshot } from "../vite-env";

export function useCodexAppServerFooter(sessionId?: string) {
  const [current, setCurrent] = useState<{ sessionId: string; snapshot: CodexAppServerSnapshot } | null>(null);

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    setCurrent(null);
    if (!sessionId) return;
    void window.codexAppServerApi.snapshot(sessionId).then(value => {
      if (active && !receivedChange) setCurrent({ sessionId, snapshot: value });
    }).catch(() => {});
    const removeListener = window.codexAppServerApi.onChanged(payload => {
      if (active && payload.id === sessionId) {
        receivedChange = true;
        setCurrent({ sessionId, snapshot: payload.snapshot });
      }
    });
    return () => { active = false; removeListener(); };
  }, [sessionId]);

  const snapshot = current && current.sessionId === sessionId ? current.snapshot : null;
  let tokenState: AgentTokenLiveViewState = { status: "hidden" };
  if (sessionId) {
    if (!snapshot) tokenState = { status: "loading", provider: "codex" };
    else if (!snapshot.tokenUsage || !snapshot.tokenUpdatedAt) tokenState = { status: "waiting", provider: "codex" };
    else tokenState = {
      status: "ready",
      snapshot: {
        panelSessionId: sessionId,
        provider: "codex",
        state: snapshot.busy ? "generating" : "completed",
        tokens: snapshot.tokenUsage.total,
        capabilities: {
          skills: { availability: "unavailable", totalCalls: 0, items: [] },
          mcp: { availability: "unavailable", totalCalls: 0, servers: [] }
        },
        turnOutputTokens: snapshot.turnOutputTokens || 0,
        outputTokensPerSecond: snapshot.outputTokensPerSecond || 0,
        outputRateAvailable: snapshot.outputRateAvailable,
        models: snapshot.model ? [snapshot.model] : [],
        updatedAt: snapshot.tokenUpdatedAt
      }
    };
  }

  return { tokenState, canSubmit: Boolean(snapshot?.threadId && !snapshot.busy) };
}
