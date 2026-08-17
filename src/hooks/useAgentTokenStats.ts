import { useCallback, useEffect, useState } from "react";
import type { AgentTokenDashboard } from "../vite-env";

export type TokenStatsRange = "7d" | "30d" | "all";
export type TokenStatsProvider = "all" | "codex" | "claude";

export function useAgentTokenStats(range: TokenStatsRange, provider: TokenStatsProvider, offset: number) {
  const [dashboard, setDashboard] = useState<AgentTokenDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDashboard(await window.agentTokenStatsApi.getDashboard({ range, provider, offset, limit: 50 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [offset, provider, range]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.agentTokenStatsApi.onChanged(() => { void refresh(); }), [refresh]);

  return { dashboard, loading, error, refresh };
}
