// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import type { AgentStatusPayload, TerminalSession } from "../../vite-env";
import { SessionSidebar } from "./SessionSidebar";

const componentStyles = readFileSync(path.join(process.cwd(), "src/styles/components.css"), "utf8");

const session: TerminalSession = {
  id: "run-1",
  title: "Agent 会话",
  shell: "powershell.exe",
  cwd: "C:\\work",
  createdAt: 1,
  type: "windows"
};

function renderSidebar(agentStatus?: AgentStatusPayload) {
  const noop = () => undefined;
  return render(
    <I18nProvider locale="zh-CN">
      <SessionSidebar
        sessions={[session]}
        activeId={session.id}
        agentStatusesBySessionId={agentStatus ? { [session.id]: agentStatus } : {}}
        onSelectSession={noop}
        onEditSession={noop}
        onInstallHooks={noop}
        onCloseSession={noop}
        onReorder={noop}
      />
    </I18nProvider>
  );
}

describe("SessionSidebar Agent summary", () => {
  afterEach(cleanup);

  it("shows Agent activity below its status with the full text as a tooltip", () => {
    const summary = "已完成登录页修复并通过相关测试";
    renderSidebar({
      id: session.id,
      provider: "codex",
      status: "completed",
      eventName: "Stop",
      timestamp: 1,
      activitySummary: summary
    });

    expect(screen.getByText(summary).getAttribute("title")).toBe(summary);
    expect(screen.getByText("Codex 已完成")).toBeTruthy();
  });

  it("does not render an empty summary placeholder", () => {
    const { container } = renderSidebar({
      id: session.id,
      provider: "codex",
      status: "running",
      eventName: "PreToolUse",
      timestamp: 1,
      activitySummary: "   "
    });

    expect(container.querySelector(".agent-status-summary")).toBeNull();
  });

  it("clamps long summaries to two lines", () => {
    expect(componentStyles).toMatch(/\.agent-status-summary\s*{[^}]*display:\s*-webkit-box;[^}]*-webkit-line-clamp:\s*2;[^}]*overflow:\s*hidden;/s);
  });
});
