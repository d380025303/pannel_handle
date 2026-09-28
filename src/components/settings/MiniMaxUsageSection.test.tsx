// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { MiniMaxUsageSnapshot } from "../../vite-env";
import { MiniMaxUsageSection } from "./MiniMaxUsageSection";

const PLAN_SNAPSHOT: MiniMaxUsageSnapshot = {
  provider: "minimax",
  fetchedAt: Date.now(),
  primaryLimitId: "MiniMax-M2:interval",
  limits: [
    { id: "MiniMax-M2:interval", name: "MiniMax-M2 · 5 小时", usedPercent: 25, remainingPercent: 75, resetsAt: 1893456000000 },
    { id: "MiniMax-M2:weekly", name: "MiniMax-M2 · 每周", usedPercent: 10, remainingPercent: 90 }
  ]
};

const BALANCE_SNAPSHOT: MiniMaxUsageSnapshot = {
  provider: "minimax",
  fetchedAt: Date.now(),
  primaryLimitId: "",
  limits: [],
  summary: { kind: "currency", currency: "CNY", available: 12.34, cash: 10, voucher: 2, credit: 0.34, owed: 0 }
};

describe("MiniMaxUsageSection", () => {
  beforeEach(() => {
    Object.defineProperty(window, "miniMaxApi", {
      configurable: true,
      value: {
        getUsage: vi.fn().mockResolvedValue(PLAN_SNAPSHOT)
      }
    });
  });

  afterEach(cleanup);

  it("renders nothing without a configured key", () => {
    render(<I18nProvider locale="zh-CN"><MiniMaxUsageSection hasApiKey={false} /></I18nProvider>);
    expect(screen.queryByRole("button", { name: "刷新额度" })).toBeNull();
    expect(window.miniMaxApi.getUsage).not.toHaveBeenCalled();
  });

  it("loads token plan usage on mount and shows the primary summary", async () => {
    render(<I18nProvider locale="zh-CN"><MiniMaxUsageSection hasApiKey /></I18nProvider>);
    expect(window.miniMaxApi.getUsage).toHaveBeenCalledWith(undefined);

    expect(await screen.findByText("主额度剩余 75%")).toBeTruthy();
  });

  it("shows the balance summary for pay-as-you-go keys", async () => {
    window.miniMaxApi.getUsage = vi.fn().mockResolvedValue(BALANCE_SNAPSHOT);
    render(<I18nProvider locale="zh-CN"><MiniMaxUsageSection hasApiKey /></I18nProvider>);

    expect(await screen.findByText("可用余额 ¥12.34")).toBeTruthy();
  });

  it("expands and collapses plan window details from the summary", async () => {
    render(<I18nProvider locale="zh-CN"><MiniMaxUsageSection hasApiKey /></I18nProvider>);
    const summary = await screen.findByText("主额度剩余 75%");

    fireEvent.click(summary);
    expect(screen.getByText("MiniMax-M2 · 5 小时")).toBeTruthy();
    expect(screen.getByText("剩余 75%")).toBeTruthy();
    expect(screen.getByText("剩余 90%")).toBeTruthy();

    fireEvent.click(summary);
    expect(screen.queryByText("MiniMax-M2 · 5 小时")).toBeNull();
  });

  it("shows balance details when expanded", async () => {
    window.miniMaxApi.getUsage = vi.fn().mockResolvedValue(BALANCE_SNAPSHOT);
    render(<I18nProvider locale="zh-CN"><MiniMaxUsageSection hasApiKey /></I18nProvider>);

    fireEvent.click(await screen.findByText("可用余额 ¥12.34"));
    expect(screen.getByText("现金 ¥10 · 代金券 ¥2 · 授信 ¥0.34 · 欠款 ¥0")).toBeTruthy();
  });

  it("refreshes with force when the refresh button is clicked", async () => {
    window.miniMaxApi.getUsage = vi.fn().mockResolvedValue(PLAN_SNAPSHOT);
    render(<I18nProvider locale="zh-CN"><MiniMaxUsageSection hasApiKey /></I18nProvider>);
    await screen.findByText("主额度剩余 75%");

    fireEvent.click(screen.getByRole("button", { name: "刷新额度" }));
    await vi.waitFor(() => expect(window.miniMaxApi.getUsage).toHaveBeenCalledWith({ force: true }));
  });

  it("shows the error message and retries via the refresh button", async () => {
    window.miniMaxApi.getUsage = vi.fn().mockRejectedValueOnce(new Error("额度接口不可用"))
      .mockResolvedValue(PLAN_SNAPSHOT);
    render(<I18nProvider locale="zh-CN"><MiniMaxUsageSection hasApiKey /></I18nProvider>);

    expect(await screen.findByText("读取额度失败")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("额度接口不可用");

    fireEvent.click(screen.getByRole("button", { name: "刷新额度" }));
    expect(await screen.findByText("主额度剩余 75%")).toBeTruthy();
  });
});
