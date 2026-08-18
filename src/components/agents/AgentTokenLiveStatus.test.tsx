// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { AgentTokenLiveStatus } from "./AgentTokenLiveStatus";

const snapshot = {
  panelSessionId: "panel-1",
  provider: "codex" as const,
  state: "generating" as const,
  tokens: {
    inputTokens: 12_000,
    cachedInputTokens: 8_000,
    cacheWriteInputTokens: 0,
    outputTokens: 450,
    reasoningOutputTokens: 120,
    totalTokens: 12_450
  },
  capabilities: {
    skills: { availability: "available" as const, totalCalls: 2, items: [{ name: "diagnosing-bugs", count: 2 }] },
    mcp: { availability: "available" as const, totalCalls: 3, servers: [{ name: "logView", count: 3, tools: [{ name: "search_logs", count: 3 }] }] }
  },
  turnOutputTokens: 150,
  outputTokensPerSecond: 37.5,
  models: ["gpt-5.6"],
  updatedAt: Date.now()
};

afterEach(cleanup);

describe("AgentTokenLiveStatus", () => {
  it("renders compact live totals and opens session details", () => {
    render(
      <I18nProvider locale="zh-CN">
        <AgentTokenLiveStatus state={{ status: "ready", snapshot }} />
      </I18nProvider>
    );

    expect(screen.getByText("37.5 tok/s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Codex 实时 Token" }));
    expect(screen.getByRole("dialog", { name: "Codex 实时 Token" })).toBeTruthy();
    expect(screen.getByText("本轮输出")).toBeTruthy();
    expect(screen.getByText("gpt-5.6")).toBeTruthy();
    expect(screen.getByText("diagnosing-bugs")).toBeTruthy();
    expect(screen.getByText("search_logs ×3")).toBeTruthy();
  });

  it("shows a non-blocking unavailable state", () => {
    render(
      <I18nProvider locale="zh-CN">
        <AgentTokenLiveStatus state={{ status: "ready", snapshot: { ...snapshot, state: "unavailable" } }} />
      </I18nProvider>
    );
    expect(screen.getByText("Token 暂不可用")).toBeTruthy();
  });
});
