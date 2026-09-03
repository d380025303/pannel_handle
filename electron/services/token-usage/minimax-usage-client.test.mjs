import { describe, expect, it, vi } from "vitest";
import minimaxUsageModule from "./minimax-usage-client.cjs";

const { MINIMAX_ACCOUNT_BALANCE_URL, MINIMAX_TOKEN_PLAN_USAGE_URL, normalizeMiniMaxBalance, normalizeMiniMaxQuota, readMiniMaxUsage, resolveQuotaCounts } = minimaxUsageModule;

describe("MiniMax usage", () => {
  it("normalizes interval and weekly Token Plan windows", () => {
    const snapshot = normalizeMiniMaxQuota({ model_remains: [{
      model_name: "MiniMax-M*",
      end_time: 2_000,
      weekly_end_time: 3_000,
      current_interval_total_count: 1500,
      current_interval_usage_count: 300,
      current_interval_remaining_percent: 80,
      current_weekly_total_count: 6000,
      current_weekly_usage_count: 1500,
      current_weekly_remaining_percent: 75
    }] }, 1000);
    expect(snapshot).toMatchObject({ provider: "minimax", primaryLimitId: "MiniMax-M*:interval" });
    expect(snapshot.limits).toEqual([
      expect.objectContaining({ remainingPercent: 80, usedPercent: 20, resetsAt: 2000 }),
      expect.objectContaining({ remainingPercent: 75, usedPercent: 25, resetsAt: 3000 })
    ]);
  });

  it("uses authoritative remaining percentages for time-based plans with zero counts", () => {
    const snapshot = normalizeMiniMaxQuota({ model_remains: [
      {
        model_name: "general",
        current_interval_status: 1,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 100,
        current_weekly_status: 1,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_remaining_percent: 64
      }
    ] });
    expect(snapshot.limits.find(limit => limit.id === "general:interval")).toMatchObject({ remainingPercent: 100, usedPercent: 0 });
    expect(snapshot.limits.find(limit => limit.id === "general:interval")).not.toHaveProperty("available", false);
    expect(snapshot.limits.find(limit => limit.id === "general:weekly")).toMatchObject({ remainingPercent: 64, usedPercent: 36 });
  });

  it("distinguishes unlimited from a window without percentage or count quota", () => {
    const snapshot = normalizeMiniMaxQuota({ model_remains: [
      { model_name: "general", current_interval_status: 3, current_interval_total_count: 0, current_weekly_status: 3, current_weekly_total_count: 0 },
      { model_name: "video", current_interval_status: 1, current_interval_total_count: 0, current_weekly_status: 1, current_weekly_total_count: 0 }
    ] });
    expect(snapshot.limits.find(limit => limit.id === "general:interval")).toMatchObject({ unlimited: true, remainingPercent: 100 });
    expect(snapshot.limits.find(limit => limit.id === "video:interval")).toMatchObject({ available: false, remainingPercent: 0 });
  });

  it("normalizes a pay-as-you-go CNY balance", () => {
    expect(normalizeMiniMaxBalance({ available_amount: "12.5", cash_balance: "10", voucher_balance: "2.5", credit_balance: "0", owed_amount: "1" }, 100)).toMatchObject({
      provider: "minimax",
      summary: { kind: "currency", currency: "CNY", available: 12.5, owed: 1 }
    });
  });

  it("routes Token Plan and ordinary API keys to their matching usage endpoints", async () => {
    const tokenFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ model_remains: [{ model_name: "general", current_interval_status: 3, current_interval_total_count: 0, current_weekly_status: 3, current_weekly_total_count: 0 }] }) });
    await readMiniMaxUsage({ apiKey: "sk-cp-test", fetchImpl: tokenFetch });
    expect(tokenFetch).toHaveBeenCalledWith(MINIMAX_TOKEN_PLAN_USAGE_URL, expect.any(Object));

    const balanceFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available_amount: "8" }) });
    await readMiniMaxUsage({ apiKey: "sk-api-test", fetchImpl: balanceFetch });
    expect(balanceFetch).toHaveBeenCalledWith(MINIMAX_ACCOUNT_BALANCE_URL, expect.any(Object));
  });

  it("keeps compatibility with ambiguous legacy count semantics", () => {
    expect(resolveQuotaCounts(20, 100, 20)).toEqual({ total: 100, used: 80, remaining: 20 });
    expect(resolveQuotaCounts(20, 100, 80)).toEqual({ total: 100, used: 20, remaining: 80 });
  });
});
