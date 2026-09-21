// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { AgentUsageSnapshot } from "../../vite-env";
import { CodeBuddyQuotaSettings } from "./CodeBuddyQuotaSettings";

function snapshot(): AgentUsageSnapshot {
  return {
    provider: "codebuddy",
    fetchedAt: new Date("2026-09-20T08:00:00+08:00").getTime(),
    primaryLimitId: "codebuddy-total",
    summary: { kind: "credits", total: 1000, used: 250, remaining: 750, usedPercent: 25, remainingPercent: 75, unit: "Credits" },
    limits: [{
      id: "base",
      name: "基础额度",
      category: "base",
      totalAmount: 1000,
      usedAmount: 250,
      remainingAmount: 750,
      usedPercent: 25,
      remainingPercent: 75,
      unit: "Credits",
      expiresAt: new Date("2026-10-01T00:00:00+08:00").getTime()
    }]
  };
}

describe("CodeBuddyQuotaSettings", () => {
  const getCodeBuddyUsage = vi.fn();
  const cancelCodeBuddyUsage = vi.fn();

  beforeEach(() => {
    getCodeBuddyUsage.mockReset();
    cancelCodeBuddyUsage.mockReset();
    Object.defineProperty(window, "agentUsageApi", {
      configurable: true,
      value: {
        getUsage: vi.fn(),
        getCodeBuddyUsage,
        consumeResetCredit: vi.fn(),
        cancel: vi.fn(),
        cancelCodeBuddyUsage
      }
    });
  });

  afterEach(cleanup);

  it("loads and displays the complete account quota without a terminal session", async () => {
    getCodeBuddyUsage.mockResolvedValue(snapshot());
    const view = render(<I18nProvider locale="zh-CN"><CodeBuddyQuotaSettings /></I18nProvider>);

    expect((await screen.findAllByText("剩余 750 / 1,000 Credits")).length).toBeGreaterThan(0);
    expect(screen.getByText("基础额度")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "基础额度" }).getAttribute("aria-valuenow")).toBe("25");
    expect(getCodeBuddyUsage).toHaveBeenCalledWith({ force: false });

    view.unmount();
    expect(cancelCodeBuddyUsage).toHaveBeenCalledTimes(1);
  });

  it("force refreshes and recovers from an initial error", async () => {
    getCodeBuddyUsage
      .mockRejectedValueOnce(new Error("not signed in"))
      .mockResolvedValueOnce(snapshot());
    render(<I18nProvider locale="zh-CN"><CodeBuddyQuotaSettings /></I18nProvider>);

    expect(await screen.findByText("CodeBuddy 额度暂不可用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试读取 CodeBuddy 额度" }));
    expect((await screen.findAllByText("剩余 750 / 1,000 Credits")).length).toBeGreaterThan(0);
    expect(getCodeBuddyUsage).toHaveBeenLastCalledWith({ force: true });
  });
});
