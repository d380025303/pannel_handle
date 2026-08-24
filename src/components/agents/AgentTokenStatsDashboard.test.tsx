// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    { provider: "codebuddy", sessionCount: 0, tokens: emptyTokens },
    { provider: "qoder", sessionCount: 0, tokens: emptyTokens }
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

  it("offers OpenCode as a provider filter", async () => {
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);
    await screen.findByText("OpenCode");
    fireEvent.change(screen.getByRole("combobox", { name: /Agent/ }), { target: { value: "opencode" } });
    await waitFor(() => expect(getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "opencode" })));
  });

  it("offers Qoder as a provider filter", async () => {
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);
    await screen.findByText("Qoder");
    fireEvent.change(screen.getByLabelText("Agent 类型"), { target: { value: "qoder" } });
    await waitFor(() => expect(getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "qoder" })));
  });

  it("shows only date labels below the trend and reveals token details on hover", async () => {
    getDashboard.mockResolvedValueOnce({
      ...defaultDashboard,
      dailyTrend: [
        { date: "2026-08-17", tokens: { ...emptyTokens, inputTokens: 60, cachedInputTokens: 20, outputTokens: 40, totalTokens: 100 } },
        { date: "2026-08-18", tokens: { ...emptyTokens, inputTokens: 120, cachedInputTokens: 30, outputTokens: 80, totalTokens: 200 } }
      ]
    });
    render(<I18nProvider locale="en-US"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);

    const point = await screen.findByRole("button", { name: "2026-08-17: Total tokens 100" });
    expect(document.querySelector(".token-stats-trend-labels")?.textContent).toBe("2026-08-172026-08-18");
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(point);
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("2026-08-17")).toBeTruthy();
    expect(within(tooltip).getByText("Total tokens").nextElementSibling?.textContent).toBe("100");
    expect(within(tooltip).getByText("Input").nextElementSibling?.textContent).toBe("60");
    expect(within(tooltip).getByText("Cached input").nextElementSibling?.textContent).toBe("20");
    expect(within(tooltip).getByText("Output").nextElementSibling?.textContent).toBe("40");

    fireEvent.mouseLeave(point);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows trend details when a data point receives keyboard focus", async () => {
    getDashboard.mockResolvedValueOnce({
      ...defaultDashboard,
      dailyTrend: [{ date: "2026-08-17", tokens: { ...emptyTokens, inputTokens: 60, outputTokens: 40, totalTokens: 100 } }]
    });
    render(<I18nProvider locale="en-US"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);

    const point = await screen.findByRole("button", { name: "2026-08-17: Total tokens 100" });
    fireEvent.focus(point);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(point);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows aggregate capability calls and expands per-session details", async () => {
    getDashboard.mockResolvedValueOnce({
      ...defaultDashboard,
      summary: { ...defaultDashboard.summary, sessionCount: 1, skillCalls: 2, mcpCalls: 3 },
      topSkills: [{ name: "diagnosing-bugs", count: 2 }],
      topMcpServers: [{ name: "logView", count: 3, tools: [{ name: "search_logs", count: 3 }] }],
      sessions: [{
        id: "codex:one", provider: "codex", agentSessionId: "one", panelSessionId: "panel", title: "Work", cwd: "C:\\work", location: "windows",
        models: ["gpt-5.6"], startedAt: 1, updatedAt: Date.now(), endedAt: null, tokens: emptyTokens,
        capabilities: {
          skills: { availability: "available", totalCalls: 2, items: [{ name: "diagnosing-bugs", count: 2 }] },
          mcp: { availability: "available", totalCalls: 3, servers: [{ name: "logView", count: 3, tools: [{ name: "search_logs", count: 3 }] }] }
        }
      }],
      totalCount: 1
    });
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);

    expect(await screen.findAllByText("diagnosing-bugs")).toHaveLength(1);
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "查看技能与 MCP" }));
    expect(screen.getAllByText("diagnosing-bugs")).toHaveLength(2);
    expect(screen.getByText("search_logs ×3")).toBeTruthy();
    expect(document.querySelector(".token-capability-row td")?.getAttribute("colspan")).toBe("7");
  });

  it("uses the localized display name for the internal remote bridge", async () => {
    getDashboard.mockResolvedValueOnce({
      ...defaultDashboard,
      summary: { ...defaultDashboard.summary, sessionCount: 1, mcpCalls: 4 },
      topMcpServers: [{ name: "pannel_handle_remote", count: 4, tools: [{ name: "remote_exec", count: 4 }] }],
      sessions: [{
        id: "codex:remote", provider: "codex", agentSessionId: "remote", panelSessionId: "panel", title: "Remote", cwd: "/", location: "ssh",
        models: ["gpt-5.6"], startedAt: 1, updatedAt: Date.now(), endedAt: null, tokens: emptyTokens,
        capabilities: {
          skills: { availability: "available", totalCalls: 0, items: [] },
          mcp: { availability: "available", totalCalls: 4, servers: [{ name: "pannel_handle_remote", count: 4, tools: [{ name: "remote_exec", count: 4 }] }] }
        }
      }],
      totalCount: 1
    });
    render(<I18nProvider locale="zh-CN"><AgentTokenStatsDashboard onClose={() => undefined} /></I18nProvider>);

    expect(await screen.findByText("Pannel Handle 远程桥")).toBeTruthy();
    expect(screen.queryByText("pannel_handle_remote")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看技能与 MCP" }));
    expect(screen.getAllByText("Pannel Handle 远程桥")).toHaveLength(2);
    expect(screen.getByText("remote_exec ×4")).toBeTruthy();
  });
});
