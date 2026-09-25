import { describe, expect, it, vi } from "vitest";
import graphicalModule from "./mobile-graphical.cjs";

const { createMobileGraphicalHandlers, toMobileGraphicalSnapshot } = graphicalModule;

function fixture() {
  const session = { id: "graph-1", runtimeMode: "app-server", agentProvider: "codex" };
  const snapshot = {
    threadId: "thread-1", provider: "codex", busy: false, mode: "default", items: [{ id: "m1", type: "agentMessage", text: "hello" }],
    approvals: [{ requestId: 3, method: "item/commandExecution/requestApproval", params: { command: "dir" } }],
    questions: [{ requestId: 4, params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "q1", question: "Go?" }] } }],
    account: { token: "secret" }
  };
  const graphicalService = {
    snapshot: vi.fn(() => snapshot), submit: vi.fn(), interrupt: vi.fn(),
    newThread: vi.fn(() => ({ ...snapshot, threadId: "thread-2" })),
    listHistory: vi.fn(() => ({ data: [{ id: "thread-2", title: "Old" }], nextCursor: null })),
    resume: vi.fn(() => ({ ...snapshot, threadId: "thread-2" })),
    resolveApproval: vi.fn(), answerQuestion: vi.fn(),
    executePlan: vi.fn(), dismissPlan: vi.fn()
  };
  const terminalManager = { getSession: vi.fn(id => id === session.id ? session : null) };
  const send = vi.fn();
  const handlers = createMobileGraphicalHandlers({ terminalManager, graphicalService, send });
  const socket = { graphicalSessionId: null, subscriptions: new Set(["terminal-1"]), authenticated: true };
  return { handlers, socket, send, snapshot, graphicalService, terminalManager };
}

describe("mobile graphical session route", () => {
  it("projects only mobile state and sends updates to the subscribed session", async () => {
    const f = fixture();
    expect(toMobileGraphicalSnapshot(f.snapshot)).not.toHaveProperty("account");
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    expect(f.socket.graphicalSessionId).toBe("graph-1");
    expect(f.socket.subscriptions.size).toBe(0);
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.snapshot", sessionId: "graph-1" }));
    f.send.mockClear();
    f.handlers.handleChanged(f.socket, { id: "other", snapshot: f.snapshot });
    f.handlers.handleChanged({ ...f.socket, authenticated: false }, { id: "graph-1", snapshot: f.snapshot });
    f.handlers.handleChanged(f.socket, { id: "graph-1", snapshot: { ...f.snapshot, threadId: "old-thread" } });
    expect(f.send).not.toHaveBeenCalled();
    f.handlers.handleChanged(f.socket, { id: "graph-1", snapshot: f.snapshot });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("requires a current graphical thread and routes core actions", async () => {
    const f = fixture();
    await expect(f.handlers.handle(f.socket, { type: "graphical.submit", sessionId: "graph-1", threadId: "thread-1", text: "hi" }))
      .rejects.toThrow("先打开");
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await expect(f.handlers.handle(f.socket, { type: "graphical.submit", sessionId: "graph-1", threadId: "old", text: "hi" }))
      .rejects.toThrow("已切换");
    await f.handlers.handle(f.socket, { type: "graphical.submit", sessionId: "graph-1", threadId: "thread-1", text: " hi ", requestId: "r1" });
    expect(f.graphicalService.submit).toHaveBeenCalledWith("graph-1", "hi");
    expect(f.send).toHaveBeenCalledWith(f.socket, { type: "command.ok", requestId: "r1" });
    await f.handlers.handle(f.socket, { type: "graphical.approval", sessionId: "graph-1", threadId: "thread-1", approvalId: 3, decision: false });
    expect(f.graphicalService.resolveApproval).toHaveBeenCalledWith("graph-1", 3, false);
    await expect(f.handlers.handle(f.socket, { type: "graphical.approval", sessionId: "graph-1", threadId: "thread-1", approvalId: 9, decision: true }))
      .rejects.toThrow("已失效");
    await f.handlers.handle(f.socket, { type: "graphical.answer", sessionId: "graph-1", threadId: "thread-1", questionId: 4,
      answers: { q1: { answers: ["yes"] } } });
    expect(f.graphicalService.answerQuestion).toHaveBeenCalledWith("graph-1", 4, { q1: { answers: ["yes"] } });
  });

  it("rejects terminal sessions and allows history only for the active graphical session", async () => {
    const f = fixture();
    f.terminalManager.getSession.mockImplementation(id => id === "terminal-1" ? { id, runtimeMode: "terminal" } : id === "graph-1" ? { id, runtimeMode: "app-server" } : null);
    await expect(f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "terminal-1" })).rejects.toThrow("图形会话不存在");
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await f.handlers.handle(f.socket, { type: "graphical.history", sessionId: "graph-1", threadId: "thread-1", requestId: "h1" });
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.history", requestId: "h1" }));
  });
});
