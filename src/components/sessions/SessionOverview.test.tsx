// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { AgentStatusPayload, TerminalSession } from "../../vite-env";
import { SessionOverview } from "./SessionOverview";

const local: TerminalSession = {
  id: "local",
  title: "Local terminal",
  shell: "pwsh.exe",
  cwd: "C:\\project",
  createdAt: 1,
  type: "windows",
  agentProvider: "codex"
};

const ssh: TerminalSession = {
  ...local,
  id: "ssh",
  title: "Remote terminal",
  type: "ssh",
  cwd: "/work",
  sshConfig: { host: "example.test", username: "deploy" },
  sshConnectionState: "reconnecting"
};

function renderOverview(sessions: TerminalSession[], statuses: Record<string, AgentStatusPayload> = {}, onSelectSession = vi.fn()) {
  return render(
    <I18nProvider locale="zh-CN">
      <SessionOverview sessions={sessions} agentStatusesBySessionId={statuses} onSelectSession={onSelectSession} />
    </I18nProvider>
  );
}

describe("SessionOverview", () => {
  afterEach(cleanup);

  it("keeps connection state separate from Agent state and opens the selected terminal", () => {
    const onSelectSession = vi.fn();
    const status: AgentStatusPayload = { id: "ssh", provider: "codex", status: "waiting_for_permission", eventName: "PermissionRequest", timestamp: 1, activitySummary: "等待确认部署命令" };
    renderOverview([local, ssh], { ssh: status }, onSelectSession);

    expect(screen.getByRole("button", { name: "打开终端：Local terminal" }).textContent).toContain("会话已打开");
    expect(screen.getByRole("button", { name: "打开终端：Local terminal" }).textContent).toContain("暂无活动摘要");
    const remoteCard = screen.getByRole("button", { name: "打开终端：Remote terminal" });
    expect(remoteCard.textContent).toContain("SSH 重连中");
    expect(remoteCard.textContent).toContain("Codex 等待确认");
    expect(remoteCard.textContent).toContain("等待确认部署命令");

    fireEvent.click(remoteCard);
    expect(onSelectSession).toHaveBeenCalledWith("ssh");
    expect(screen.queryByRole("button", { name: "返回终端" })).toBeNull();
  });

  it("updates stopped and running states from the current data and shows an empty state", () => {
    const { rerender } = renderOverview([ssh], {
      ssh: { id: "ssh", provider: "codex", status: "running", eventName: "Start", timestamp: 1, activitySummary: "执行测试" }
    });
    expect(screen.getByRole("button", { name: "打开终端：Remote terminal" }).textContent).toContain("Codex 运行中");

    rerender(
      <I18nProvider locale="zh-CN">
        <SessionOverview sessions={[{ ...ssh, sshConnectionState: "disconnected" }]} agentStatusesBySessionId={{ ssh: { id: "ssh", provider: "codex", status: "ended", eventName: "End", timestamp: 2 } }} onSelectSession={() => undefined} />
      </I18nProvider>
    );
    const card = screen.getByRole("button", { name: "打开终端：Remote terminal" });
    expect(card.textContent).toContain("SSH 已断开");
    expect(card.textContent).toContain("Codex 已结束");
    expect(card.textContent).toContain("暂无活动摘要");

    rerender(<I18nProvider locale="zh-CN"><SessionOverview sessions={[]} agentStatusesBySessionId={{}} onSelectSession={() => undefined} /></I18nProvider>);
    expect(screen.getByText("暂无终端实例")).toBeTruthy();
  });
});
