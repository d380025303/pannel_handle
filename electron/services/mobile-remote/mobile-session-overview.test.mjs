import { expect, it, vi } from "vitest";
import overviewModule from "./mobile-session-overview.cjs";

const { graphicalOverview, terminalOverview, sessionOverview } = overviewModule;

it("summarizes the latest graphical message and prioritizes pending interaction", () => {
  const session = { id: "graph-1", runtimeMode: "app-server", type: "windows", cwd: "C:\\work" };
  const snapshot = { busy: true, approvals: [{ requestId: 1 }], items: [
    { type: "agentMessage", text: "Earlier answer" },
    { type: "userMessage", text: "  Please review\nthis  " }
  ] };
  expect(graphicalOverview(session, snapshot)).toEqual({
    sessionId: "graph-1", status: "待确认", detail: "等待授权", summary: "Please review this"
  });
  expect(graphicalOverview(session, { ...snapshot, approvals: [], error: "failed" }).status).toBe("错误");
  expect(graphicalOverview(session, { ...snapshot, approvals: [], busy: false, error: null }).status).toBe("空闲");
  expect(graphicalOverview(session, snapshot)).toMatchObject({ detail: "等待授权" });
  expect(graphicalOverview(session, { ...snapshot, approvals: [], questions: [{ params: { questions: [{ question: "选择部署环境" }] } }] }))
    .toMatchObject({ status: "待确认", detail: "需要用户输入", summary: "选择部署环境" });
  expect(graphicalOverview(session, { ...snapshot, approvals: [], pendingPlan: { itemId: "plan" } }))
    .toMatchObject({ status: "待确认", detail: "等待确认计划", summary: "确认执行计划" });
});

it("uses the last readable terminal line and reports SSH disconnection", async () => {
  const session = { id: "ssh-1", runtimeMode: "terminal", type: "ssh", sshConnectionState: "reconnecting", cwd: "/srv/app" };
  const stateHub = { getText: vi.fn(async () => "old line\nnew result\n") };
  expect(await terminalOverview(session, stateHub)).toEqual({
    sessionId: "ssh-1", status: "重连中", summary: "new result"
  });
  stateHub.getText.mockResolvedValue("");
  expect((await sessionOverview(session, null, stateHub)).summary).toBe("/srv/app");
});

it("uses terminal Agent status and activity, then restores the ordinary status when cleared", async () => {
  const session = { id: "terminal-1", runtimeMode: "terminal", type: "windows", agentStatus: "running" };
  const stateHub = { getText: vi.fn(async () => "terminal output") };
  const waiting = { status: "e_prompt", resolution: "provide_input", activitySummary: "请选择继续方式" };
  expect(await terminalOverview(session, stateHub, waiting)).toEqual({
    sessionId: "terminal-1", status: "待确认", detail: "需要用户输入", summary: "请选择继续方式"
  });
  expect(await terminalOverview(session, stateHub, { status: "waiting_for_permission", toolName: "shell" }))
    .toMatchObject({ status: "待确认", detail: "等待授权" });
  session.agentStatus = "cleared";
  expect(await terminalOverview(session, stateHub)).toEqual({ sessionId: "terminal-1", status: "运行中", summary: "terminal output" });
  session.type = "ssh";
  session.sshConnectionState = "disconnected";
  expect(await terminalOverview(session, stateHub, waiting)).toMatchObject({ status: "已断开" });
});

it("only allows completed sessions without pending interaction", async () => {
  const terminal = { id: "one", runtimeMode: "terminal", agentStatus: "completed" };
  expect((await sessionOverview(terminal, null, {})).canCloseCompleted).toBe(true);
  for (const status of [{ status: "running" }, { status: "e_prompt" }, { status: "failed" },
    { status: "completed", eventName: "AppServerPlanPending" }, { status: "completed", eventName: "AppServerQuestion" },
    { status: "completed", eventName: "AcpQuestion" }, { status: "completed", resolution: "provide_input" }])
    expect(overviewModule.canCloseCompleted(terminal, null, status)).toBe(false);
  const session = { ...terminal, runtimeMode: "app-server" };
  expect(overviewModule.canCloseCompleted(session, { snapshot: () => ({}) })).toBe(true);
  for (const snapshot of [null, { busy: true }, { error: "failed" }, { pendingPlan: {} }, { approvals: [{}] }, { questions: [{}] }])
    expect(overviewModule.canCloseCompleted(session, { snapshot: () => snapshot })).toBe(false);
  expect(overviewModule.canCloseCompleted(session, { snapshot: () => { throw new Error(); } })).toBe(false);
});
