// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTokenStatsDashboard } from "./AgentTokenStatsDashboard";
import { I18nProvider } from "../../i18n";
import type { AgentTokenDashboard } from "../../vite-env";

const emptyTokens = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const defaultDashboard: AgentTokenDashboard = {
  generatedAt: Date.now(), range: "30d", provider: "all",
  summary: { sessionCount: 0, averageTokens: 0, skillCalls: 0, mcpCalls: 0, tokens: emptyTokens },
  dailyTrend: [], providerBreakdown: [
    { provider: "codex", sessionCount: 0, tokens: emptyTokens },
    { provider: "claude", sessionCount: 0, tokens: emptyTokens },
    { provider: "codebuddy", sessionCount: 0, tokens: emptyTokens }
  ],
  topSkills: [], topMcpServers: [],
  sessions: [], totalCount: 0, offset: 0, limit: 50
};
const getDashboard = vi.fn(async () => defaultDashboard);
const clear = vi.fn(async () => true);

describe("AgentTokenStatsDashboard", () => {
  afterEach(cleanup);
  beforeEach(() => {
    getDashboard.mockReset();
    getDashboard.mockResolvedValue(defaultDashboard);
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

  it("offers CodeBuddy as a provider filter", async () => {
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);
    await screen.findByText("CodeBuddy");
    fireEvent.change(screen.getByLabelText("Agent 类型"), { target: { value: "codebuddy" } });
    await waitFor(() => expect(getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "codebuddy" })));
  });

  it("shows aggregate capability calls and expands per-session details", async () => {
    getDashboard.mockResolvedValueOnce({
      ...defaultDashboard,
      summary: { ...defaultDashboard.summary, sessionCount: 1, skillCalls: 2, mcpCalls: 3 },
      topSkills: [{ name: "diagnosing-bugs", count: 2 }],
      topMcpServers: [{ name: "logView", count: 3, tools: [{ name: "search_logs", count: 3 }] }],
      sessions: [{
        id: "codex:one", provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", cwd: "C:\\work", location: "windows",
        models: ["gpt-5.6"], startedAt: 1, updatedAt: Date.now(), endedAt: null, status: "active", tokens: emptyTokens,
        capabilities: {
          skills: { availability: "available", totalCalls: 2, items: [{ name: "diagnosing-bugs", count: 2 }] },
          mcp: { availability: "available", totalCalls: 3, servers: [{ name: "logView", count: 3, tools: [{ name: "search_logs", count: 3 }] }] }
        }
      }],
      totalCount: 1
    });
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);

    expect(await screen.findAllByText("diagnosing-bugs")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "查看技能与 MCP" }));
    expect(screen.getAllByText("diagnosing-bugs")).toHaveLength(2);
    expect(screen.getByText("search_logs ×3")).toBeTruthy();
  });
});
