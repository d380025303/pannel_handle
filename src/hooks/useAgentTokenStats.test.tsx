// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAgentTokenStats } from "./useAgentTokenStats";
import type { AgentTokenDashboard } from "../vite-env";

it("ignores outdated responses and errors after dates or computers change", async () => {
  const pending: Array<{ resolve: (value: AgentTokenDashboard) => void; reject: (reason: Error) => void }> = [];
  const getDashboard = vi.fn(() => new Promise<AgentTokenDashboard>((resolve, reject) => pending.push({ resolve, reject })));
  Object.defineProperty(window, "agentTokenStatsApi", { configurable: true, value: { getDashboard, onChanged: () => () => {} } });
  Object.defineProperty(window, "postgresBackupApi", { configurable: true, value: { getDashboard } });
  const { result, rerender, unmount } = renderHook(({ device, startDate }) => useAgentTokenStats("custom", "codex", 0, device, { startDate, endDate: "2026-10-15" }), {
    initialProps: { device: "local", startDate: "2026-10-14" }
  });
  rerender({ device: "remote", startDate: "2026-10-15" });
  expect(getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ range: "custom", startDate: "2026-10-15", endDate: "2026-10-15", deviceId: "remote" }));
  const dashboard = { range: "custom", totalCount: 2 } as AgentTokenDashboard;
  await act(async () => pending[1].resolve(dashboard));
  await waitFor(() => expect(result.current.dashboard).toBe(dashboard));
  await act(async () => pending[0].reject(new Error("outdated")));
  expect(result.current.dashboard).toBe(dashboard);
  expect(result.current.error).toBe("");
  expect(result.current.loading).toBe(false);
  unmount();
});
