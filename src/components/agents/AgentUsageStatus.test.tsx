// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsageSnapshot } from "../../vite-env";
import { AgentUsageStatus } from "./AgentUsageStatus";

function snapshot(primaryRemaining = 51): AgentUsageSnapshot {
  return {
    provider: "codex",
    fetchedAt: new Date("2026-08-12T08:00:00Z").getTime(),
    primaryLimitId: "codex",
    limits: [
      {
        id: "codex",
        name: "Codex",
        usedPercent: 100 - primaryRemaining,
        remainingPercent: primaryRemaining,
        windowDurationMins: 10080,
        resetsAt: new Date("2026-08-19T08:00:00Z").getTime()
      },
      {
        id: "codex_spark",
        name: "GPT Spark",
        usedPercent: 0,
        remainingPercent: 100
      }
    ]
  };
}

function codeBuddySnapshot(): AgentUsageSnapshot {
  return {
    provider: "codebuddy",
    fetchedAt: new Date("2026-08-17T08:00:00Z").getTime(),
    primaryLimitId: "codebuddy-total",
    summary: {
      kind: "credits",
      total: 1200,
      used: 450,
      remaining: 750,
      usedPercent: 38,
      remainingPercent: 62,
      unit: "Credits"
    },
    limits: [{
      id: "base-1",
      name: "Free plan",
      usedPercent: 50,
      remainingPercent: 50,
      category: "base",
      totalAmount: 1000,
      usedAmount: 500,
      remainingAmount: 500,
      unit: "Credits",
      expiresAt: new Date("2026-09-01T08:00:00Z").getTime()
    }, {
      id: "bonus-1",
      name: "Bonus",
      usedPercent: 0,
      remainingPercent: 100,
      category: "bonus",
      totalAmount: 250,
      usedAmount: 0,
      remainingAmount: 250,
      unit: "Credits"
    }]
  };
}

function qoderSnapshot(): AgentUsageSnapshot {
  return {
    provider: "qoder",
    fetchedAt: new Date("2026-08-23T08:00:00Z").getTime(),
    primaryLimitId: "qoder-total",
    summary: {
      kind: "credits",
      total: 4100,
      used: 800,
      remaining: 3300,
      usedPercent: 20,
      remainingPercent: 80,
      unit: "Credits"
    },
    activities: [{
      id: "qwen38_800_invoke",
      name: "Qwen3.8-Max 免费额度",
      totalAmount: 800,
      usedAmount: 0,
      remainingAmount: 800,
      usedPercent: 0,
      remainingPercent: 100,
      unit: "Credits",
      statusText: "剩余 800 次",
      tag: "限时特惠",
      description: "活动期内每人 800 次免费调用",
      expiresAt: new Date("2026-09-30T15:59:00Z").getTime()
    }],
    limits: [{
      id: "qoder-plan",
      name: "pro",
      usedPercent: 25,
      remainingPercent: 75,
      category: "base",
      totalAmount: 2000,
      usedAmount: 500,
      remainingAmount: 1500,
      unit: "Credits",
      expiresAt: new Date("2026-09-01T08:00:00Z").getTime()
    }, {
      id: "qoder-addon",
      name: "Add-on Credits",
      usedPercent: 33,
      remainingPercent: 67,
      category: "extra",
      totalAmount: 300,
      usedAmount: 100,
      remainingAmount: 200,
      unit: "Credits"
    }, {
      id: "qoder-organization",
      name: "Organization Resource Package",
      usedPercent: 20,
      remainingPercent: 80,
      category: "organization",
      totalAmount: 1000,
      usedAmount: 200,
      remainingAmount: 800,
      unit: "Credits",
      available: false
    }]
  };
}

function resetCreditSnapshot(availableCount = 2): AgentUsageSnapshot {
  return {
    ...snapshot(),
    resetCredits: {
      availableCount,
      credits: availableCount > 0 ? [{
        id: "reset-1",
        title: "每周重置奖励",
        description: "可重置符合条件的 Codex 限额。",
        status: "available",
        resetType: "codexRateLimits",
        grantedAt: new Date("2026-08-20T08:00:00Z").getTime(),
        expiresAt: new Date("2026-09-01T08:00:00Z").getTime()
      }] : []
    }
  };
}

describe("AgentUsageStatus", () => {
  beforeEach(() => {
    Object.defineProperty(window, "workBuddyCheckinApi", {
      configurable: true,
      value: {
        getStatus: vi.fn(async () => ({
          active: true,
          todayCheckedIn: false,
          streakDays: 2,
          dailyCredit: 100,
          todayCredit: 0,
          totalCredits: 200,
          weekProgress: [true, false, false, false, false, false, false]
        })),
        claim: vi.fn(async () => ({
          alreadyCheckedIn: false,
          status: {
            active: true,
            todayCheckedIn: true,
            streakDays: 3,
            dailyCredit: 100,
            todayCredit: 100,
            totalCredits: 300,
            weekProgress: [true, true, false, false, false, false, false]
          }
        }))
      }
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "workBuddyCheckinApi");
  });

  it("hides non-Codex state and renders loading and retry states", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<AgentUsageStatus state={{ status: "hidden" }} onRefresh={onRefresh} />);
    expect(screen.queryByText(/Codex/)).toBeNull();

    rerender(<AgentUsageStatus state={{ status: "loading", provider: "codex" }} onRefresh={onRefresh} />);
    expect(screen.getByRole("status").textContent).toContain("正在读取 Codex 用量");

    rerender(<AgentUsageStatus state={{ status: "error", provider: "codex" }} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex 用量不可用" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows Copilot quota as explicitly unavailable without a retry action", () => {
    const onRefresh = vi.fn();

    render(<AgentUsageStatus state={{ status: "error", provider: "copilot" }} onRefresh={onRefresh} />);

    const status = screen.getByRole("button", { name: "GitHub Copilot 暂无稳定的账户额度接口" });
    expect((status as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(status);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("shows the primary remaining amount and opens all limit details", () => {
    const onRefresh = vi.fn();
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: snapshot(), refreshing: false }}
        onRefresh={onRefresh}
      />
    );

    const trigger = screen.getByRole("button", { name: "Codex 剩余 51%" });
    expect(trigger.classList.contains("normal")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Codex 用量" })).not.toBeNull();
    expect(screen.getByText("GPT Spark")).not.toBeNull();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getAllByText(/重置/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "刷新用量" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Codex 用量" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses warning and danger classes at the configured thresholds", () => {
    const { rerender } = render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: snapshot(49), refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Codex 剩余 49%" }).classList.contains("warning")).toBe(true);

    rerender(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: snapshot(20), refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Codex 剩余 20%" }).classList.contains("danger")).toBe(true);
  });

  it("requires a second click before consuming a specific Codex reset credit", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
    const onConsumeResetCredit = vi.fn(async () => ({ outcome: "reset" as const }));
    const { rerender } = render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: resetCreditSnapshot(), refreshing: false }}
        onRefresh={() => undefined}
        onConsumeResetCredit={onConsumeResetCredit}
      />
    );
    fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-usage-status")!);

    const resetCredits = document.querySelector(".codex-reset-credits");
    expect(resetCredits?.textContent).toContain("2 个可用");
    expect(resetCredits?.textContent).toContain("每周重置奖励");
    expect(resetCredits?.textContent).not.toContain("可重置符合条件的 Codex 限额。");
    expect(resetCredits?.textContent).toContain("发放时间");
    expect(resetCredits?.textContent).toContain("过期时间");
    const times = resetCredits?.querySelectorAll("time");
    expect(times?.[0].dateTime).toBe("2026-08-20T08:00:00.000Z");
    expect(times?.[1].dateTime).toBe("2026-09-01T08:00:00.000Z");
    const dateFormat = new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
    expect(times?.[0].textContent).toBe(dateFormat.format(new Date("2026-08-20T08:00:00Z")));
    expect(times?.[1].textContent).toBe(dateFormat.format(new Date("2026-09-01T08:00:00Z")));
    expect(resetCredits?.querySelector(".codex-reset-credit-status.available")).toBeNull();
    const resetButton = screen.getByRole("button", { name: "重置限额" });
    fireEvent.click(resetButton);
    expect(onConsumeResetCredit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "再次点击确认重置" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "再次点击确认重置" }));
    await waitFor(() => expect(onConsumeResetCredit).toHaveBeenCalledWith(
      "reset-1",
      "11111111-1111-4111-8111-111111111111"
    ));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Codex 使用限额已重置"));

    const noExpiration = resetCreditSnapshot();
    noExpiration.resetCredits!.credits![0].expiresAt = undefined;
    rerender(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: noExpiration, refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    expect(screen.getByText("长期有效")).not.toBeNull();
    expect(document.querySelectorAll(".codex-reset-credit-meta time")).toHaveLength(1);

    rerender(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: resetCreditSnapshot(0), refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    expect(document.querySelector(".codex-reset-credits")?.textContent).toContain("当前没有可用重置额度");
    expect(document.querySelector(".codex-reset-credit")).toBeNull();

    rerender(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: snapshot(), refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    expect(document.querySelector(".codex-reset-credits")).toBeNull();
  });

  it("retries a failed reset with the same idempotency key", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("22222222-2222-4222-8222-222222222222");
    const onConsumeResetCredit = vi.fn()
      .mockRejectedValueOnce(new Error("network interrupted"))
      .mockResolvedValueOnce({ outcome: "alreadyRedeemed" as const });
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: resetCreditSnapshot(), refreshing: false }}
        onRefresh={() => undefined}
        onConsumeResetCredit={onConsumeResetCredit}
      />
    );
    fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-usage-status")!);
    fireEvent.click(screen.getByRole("button", { name: "重置限额" }));
    fireEvent.click(screen.getByRole("button", { name: "再次点击确认重置" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("network interrupted"));

    fireEvent.click(screen.getByRole("button", { name: "重试重置" }));
    await waitFor(() => expect(onConsumeResetCredit).toHaveBeenCalledTimes(2));
    expect(onConsumeResetCredit.mock.calls[0]).toEqual(onConsumeResetCredit.mock.calls[1]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("本次重置已完成"));
  });

  it("explains when Codex reports a reset count without selectable details", () => {
    const value = resetCreditSnapshot();
    value.resetCredits = { availableCount: 2 };
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: value, refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-usage-status")!);
    expect(screen.getByText(/暂无可操作的额度明细/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "重置限额" })).toBeNull();
  });

  it("shows CodeBuddy total credits, grouped packages, and WorkBuddy check-in", async () => {
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: codeBuddySnapshot(), refreshing: false }}
        onRefresh={() => undefined}
      />
    );

    const trigger = screen.getByRole("button", { name: /750 Credits/ });
    expect(trigger.classList.contains("normal")).toBe(true);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog").textContent).toContain("750 / 1,200 Credits");
    expect(screen.getByText("Free plan")).not.toBeNull();
    expect(screen.getByText("Bonus")).not.toBeNull();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(document.querySelector(".codex-reset-credits")).toBeNull();
    await waitFor(() => expect(document.querySelector(".workbuddy-checkin-ready")?.textContent).toContain("100 Credits"));
    expect(window.workBuddyCheckinApi.getStatus).toHaveBeenCalledTimes(1);
  });

  it("shows complete Qoder quota buckets without the WorkBuddy section", () => {
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: qoderSnapshot(), refreshing: false }}
        onRefresh={() => undefined}
      />
    );

    const trigger = screen.getByRole("button", { name: /Qoder.*3,300 Credits/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Qoder 额度" }).textContent).toContain("3,300 / 4,100 Credits");
    expect(screen.getByText("pro")).not.toBeNull();
    expect(screen.getByText("Add-on Credits")).not.toBeNull();
    expect(screen.getByText("Organization Resource Package")).not.toBeNull();
    expect(screen.getByText(/Qwen3.8-Max 免费额度/)).not.toBeNull();
    expect(screen.getByText("剩余 800 Credits")).not.toBeNull();
    expect(screen.getByText("0 / 800 Credits")).not.toBeNull();
    expect(screen.getByText("当前不可使用")).not.toBeNull();
    expect(document.querySelector(".workbuddy-checkin")).toBeNull();
  });

  it("keeps Qoder Credits visible when promotional quota is unavailable", () => {
    const value = qoderSnapshot();
    value.activities = [];
    value.activityError = "Qoder activity quota is unavailable.";
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: value, refreshing: false }}
        onRefresh={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Qoder.*3,300 Credits/ }));
    expect(screen.getByRole("dialog").textContent).toContain("3,300 / 4,100 Credits");
    expect(document.querySelector(".qoder-activity-quota")?.textContent).toContain("活动额度暂不可用");
  });

  it("claims once, renders the checked-in state, and refreshes quota", async () => {
    const onRefresh = vi.fn();
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: codeBuddySnapshot(), refreshing: false }}
        onRefresh={onRefresh}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /750 Credits/ }));
    await waitFor(() => expect(document.querySelector(".workbuddy-checkin-ready button")).not.toBeNull());
    const checkinButton = document.querySelector<HTMLButtonElement>(".workbuddy-checkin-ready button");
    expect(checkinButton?.disabled).toBe(false);
    fireEvent.click(checkinButton!);

    await waitFor(() => expect(window.workBuddyCheckinApi.claim).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>(".workbuddy-checkin-ready button")?.disabled).toBe(true));
    expect(document.querySelector(".workbuddy-checkin-ready")?.textContent).toContain("100 Credits");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps quota visible and retries when WorkBuddy status is unavailable", async () => {
    vi.mocked(window.workBuddyCheckinApi.getStatus)
      .mockRejectedValueOnce(new Error("WorkBuddy is not installed"));
    render(
      <AgentUsageStatus
        state={{ status: "ready", snapshot: codeBuddySnapshot(), refreshing: false }}
        onRefresh={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /750 Credits/ }));
    await waitFor(() => expect(document.querySelector(".workbuddy-checkin-error")?.textContent).toContain("WorkBuddy is not installed"));
    expect(screen.getByText("Free plan")).not.toBeNull();
    fireEvent.click(document.querySelector<HTMLButtonElement>(".workbuddy-checkin-error button")!);
    await waitFor(() => expect(window.workBuddyCheckinApi.getStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector(".workbuddy-checkin-ready")).not.toBeNull());
  });
});
