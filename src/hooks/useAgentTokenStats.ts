import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTokenDashboard } from "../vite-env";

export type TokenStatsRange = "7d" | "30d" | "all" | "custom";
export type TokenStatsProvider = "all" | "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok";

export function useAgentTokenStats(range: TokenStatsRange, provider: TokenStatsProvider, offset: number, deviceId = "local", dates?: { startDate: string; endDate: string }) {
  const [dashboard, setDashboard] = useState<AgentTokenDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const requestId = useRef(0);
  const startDate = range === "custom" ? dates?.startDate : undefined;
  const endDate = range === "custom" ? dates?.endDate : undefined;
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const result = deviceId === "local"
        ? await window.agentTokenStatsApi.getDashboard({ range, provider, offset, limit: 50, ...(range === "custom" ? { startDate, endDate } : {}) })
        : await window.postgresBackupApi.getDashboard({ range, provider, offset, limit: 50, deviceId, ...(range === "custom" ? { startDate, endDate } : {}) });
      if (id === requestId.current) setDashboard(result);
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [deviceId, offset, provider, range, startDate, endDate]);

  useEffect(() => { void refresh(); return () => { requestId.current++; }; }, [refresh]);
  useEffect(() => window.agentTokenStatsApi.onChanged(() => { void refresh(); }), [refresh]);

  return { dashboard, loading, error, refresh };
}
