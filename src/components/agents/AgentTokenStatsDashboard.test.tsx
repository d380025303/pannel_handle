// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTokenStatsDashboard } from "./AgentTokenStatsDashboard";
import { I18nProvider } from "../../i18n";

const emptyTokens = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const getDashboard = vi.fn(async () => ({
  generatedAt: Date.now(), range: "30d", provider: "all",
  summary: { sessionCount: 0, averageTokens: 0, tokens: emptyTokens },
  dailyTrend: [], providerBreakdown: [
    { provider: "codex", sessionCount: 0, tokens: emptyTokens },
    { provider: "claude", sessionCount: 0, tokens: emptyTokens }
  ],
  sessions: [], totalCount: 0, offset: 0, limit: 50
}));
const clear = vi.fn(async () => true);

describe("AgentTokenStatsDashboard", () => {
  afterEach(cleanup);
  beforeEach(() => {
    getDashboard.mockClear();
    clear.mockClear();
    Object.defineProperty(window, "agentTokenStatsApi", {
      configurable: true,
      value: { getDashboard, clear, onChanged: vi.fn(() => () => undefined) }
    });
  });

  it("loads the dashboard and requires a second click before clearing", async () => {
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);
    expect(await screen.findByText("还没有 Token 统计")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空统计" }));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "再次点击确认清空" }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  });

  it("switches the date range and reloads", async () => {
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);
    await screen.findByText("还没有 Token 统计");
    fireEvent.change(screen.getByLabelText("统计时间范围"), { target: { value: "7d" } });
    await waitFor(() => expect(getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ range: "7d" })));
  });
});
