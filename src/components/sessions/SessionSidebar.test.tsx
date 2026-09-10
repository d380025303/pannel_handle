// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
        onDuplicateSession={async () => undefined}
        onInstallHooks={noop}
        onReconnectSession={async () => undefined}
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

  it("does not render status or summary for a cleared event", () => {
    const { container } = renderSidebar({
      id: session.id,
      provider: "codex",
      status: "cleared",
      eventName: "SessionStart",
      timestamp: 1
    });

    expect(container.querySelector(".agent-status-badge")).toBeNull();
    expect(container.querySelector(".agent-status-summary")).toBeNull();
  });

  it("clamps long summaries to two lines", () => {
    expect(componentStyles).toMatch(/\.agent-status-summary\s*{[^}]*display:\s*-webkit-box;[^}]*-webkit-line-clamp:\s*2;[^}]*overflow:\s*hidden;/s);
  });

  it("duplicates a running session without selecting it", async () => {
    const onSelectSession = vi.fn();
    let finishDuplicate: () => void = () => undefined;
    const onDuplicateSession = vi.fn(() => new Promise<void>((resolve) => {
      finishDuplicate = resolve;
    }));
    const noop = () => undefined;
    render(
      <I18nProvider locale="zh-CN">
        <SessionSidebar
          sessions={[session]}
          activeId={session.id}
          agentStatusesBySessionId={{}}
          onSelectSession={onSelectSession}
          onEditSession={noop}
          onDuplicateSession={onDuplicateSession}
          onInstallHooks={noop}
          onReconnectSession={async () => undefined}
          onCloseSession={noop}
          onReorder={noop}
        />
      </I18nProvider>
    );

    const duplicateAction = screen.getByTitle("复制并在后台启动新会话");
    fireEvent.click(duplicateAction);
    fireEvent.click(duplicateAction);

    await waitFor(() => expect(onDuplicateSession).toHaveBeenCalledWith(session.id));
    expect(onDuplicateSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
    finishDuplicate();
    await waitFor(() => expect(screen.getByTitle("复制并在后台启动新会话")).toBeTruthy());
  });

  it("shows SSH reconnect state and retries immediately", async () => {
    const onReconnectSession = vi.fn(async () => undefined);
    const noop = () => undefined;
    render(
      <I18nProvider locale="zh-CN">
        <SessionSidebar
          sessions={[{
            ...session,
            type: "ssh",
            shell: "ssh2",
            sshConfig: { host: "example.com" },
            sshConnectionState: "reconnecting",
            sshReconnectAttempt: 2
          }]}
          activeId={session.id}
          agentStatusesBySessionId={{}}
          onSelectSession={noop}
          onEditSession={noop}
          onDuplicateSession={async () => undefined}
          onInstallHooks={noop}
          onReconnectSession={onReconnectSession}
          onCloseSession={noop}
          onReorder={noop}
        />
      </I18nProvider>
    );

    expect(screen.getByText("SSH 重连中（第 2 次）")).toBeTruthy();
    fireEvent.click(screen.getByTitle("立即重连 SSH"));
    await waitFor(() => expect(onReconnectSession).toHaveBeenCalledWith(session.id));
  });
});
