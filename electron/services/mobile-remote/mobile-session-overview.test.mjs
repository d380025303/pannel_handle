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
    sessionId: "graph-1", status: "待确认", summary: "Please review this"
  });
  expect(graphicalOverview(session, { ...snapshot, approvals: [], error: "failed" }).status).toBe("错误");
  expect(graphicalOverview(session, { ...snapshot, approvals: [], busy: false, error: null }).status).toBe("空闲");
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
