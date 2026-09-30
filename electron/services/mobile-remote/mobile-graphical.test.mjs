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
    resolveApproval: vi.fn(), answerQuestion: vi.fn(), cancelQuestion: vi.fn(), setMode: vi.fn(), setNativeMode: vi.fn(), setExecutionPermission: vi.fn(), setModel: vi.fn(), allowFiles: vi.fn(),
    executePlan: vi.fn(), dismissPlan: vi.fn()
  };
  const terminalManager = { getSession: vi.fn(id => id === session.id ? session : null) };
  const send = vi.fn();
  const handlers = createMobileGraphicalHandlers({ terminalManager, graphicalService, send });
  const socket = { graphicalSessionId: null, subscriptions: new Set(["terminal-1"]), authenticated: true };
  return { handlers, socket, send, session, snapshot, graphicalService, terminalManager };
}

it("routes OpenCode fork/delete with capability, pending request, and stale thread checks", async () => {
  const f = fixture();
  Object.assign(f.snapshot, { provider: "opencode", capabilities: { history: true, forkHistory: true, deleteHistory: true }, approvals: [], questions: [] });
  f.session.agentProvider = "opencode";
  f.graphicalService.forkThread = vi.fn(async () => { f.snapshot.threadId = "branch"; return { ...f.snapshot }; });
  f.graphicalService.deleteThread = vi.fn(async () => {});
  await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
  await f.handlers.handle(f.socket, { type: "graphical.fork", sessionId: "graph-1", threadId: "thread-1", targetThreadId: "old", requestId: "fork" });
  expect(f.graphicalService.forkThread).toHaveBeenCalledWith("graph-1", "old");
  expect(f.send).toHaveBeenCalledWith(f.socket, { type: "command.ok", requestId: "fork", sessionId: "graph-1", threadId: "branch" });
  await expect(f.handlers.handle(f.socket, { type: "graphical.delete", sessionId: "graph-1", threadId: "thread-1", targetThreadId: "old" })).rejects.toThrow("已切换");
  await f.handlers.handle(f.socket, { type: "graphical.delete", sessionId: "graph-1", threadId: "branch", targetThreadId: "old", requestId: "delete" });
  expect(f.graphicalService.deleteThread).toHaveBeenCalledWith("graph-1", "old");
  f.snapshot.capabilities.deleteHistory = false;
  await expect(f.handlers.handle(f.socket, { type: "graphical.delete", sessionId: "graph-1", threadId: "branch", targetThreadId: "old" })).rejects.toThrow("不支持");
  f.snapshot.questions = [{ requestId: 1 }];
  await expect(f.handlers.handle(f.socket, { type: "graphical.fork", sessionId: "graph-1", threadId: "branch", targetThreadId: "old" })).rejects.toThrow("待处理");
});

describe("mobile graphical session route", () => {
  it("sends streaming deltas to capable clients and full snapshots to legacy clients", async () => {
    const f = fixture();
    f.snapshot.streamId = "stream-1";
    f.snapshot.revision = 3;
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1", delta: true });
    f.send.mockClear();
    const delta = { id: "graph-1", streamId: "stream-1", threadId: "thread-1", baseRevision: 3,
      revision: 4, items: [], textDeltas: [{ itemId: "m1", delta: " world" }], turnDiffs: [] };
    f.handlers.handleDelta(f.socket, delta);
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.delta",
      baseRevision: 3, revision: 4, items: [], textDeltas: [{ itemId: "m1", delta: " world" }] }));
    f.send.mockClear();
    f.handlers.handleDelta(f.socket, { ...delta, baseRevision: 8, revision: 9 });
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.snapshot" }));
    f.send.mockClear();
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    f.send.mockClear();
    f.handlers.handleDelta(f.socket, delta);
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.snapshot" }));
  });

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
    expect(f.graphicalService.submit).toHaveBeenCalledWith("graph-1", "hi", []);
    expect(f.send).toHaveBeenCalledWith(f.socket, { type: "command.ok", requestId: "r1" });
    await f.handlers.handle(f.socket, { type: "graphical.approval", sessionId: "graph-1", threadId: "thread-1", approvalId: 3, decision: false });
    expect(f.graphicalService.resolveApproval).toHaveBeenCalledWith("graph-1", 3, false);
    await expect(f.handlers.handle(f.socket, { type: "graphical.approval", sessionId: "graph-1", threadId: "thread-1", approvalId: 9, decision: true }))
      .rejects.toThrow("已失效");
    await f.handlers.handle(f.socket, { type: "graphical.answer", sessionId: "graph-1", threadId: "thread-1", questionId: 4,
      answers: { q1: { answers: ["yes"] } } });
    expect(f.graphicalService.answerQuestion).toHaveBeenCalledWith("graph-1", 4, { q1: { answers: ["yes"] } });
    await expect(f.handlers.handle(f.socket, { type: "graphical.cancelQuestion", sessionId: "graph-1", threadId: "thread-1", questionId: 4 }))
      .rejects.toThrow("已失效");
    f.snapshot.provider = "codebuddy";
    await f.handlers.handle(f.socket, { type: "graphical.cancelQuestion", sessionId: "graph-1", threadId: "thread-1", questionId: 4 });
    expect(f.graphicalService.cancelQuestion).toHaveBeenCalledWith("graph-1", 4);
  });

  it("reads only the subscribed graphical session's quota and projects display fields", async () => {
    const f = fixture();
    const getAgentUsage = vi.fn(async () => ({ provider: "codex", fetchedAt: 100, primaryLimitId: "main",
      limits: [{ id: "main", name: "Codex", usedPercent: 25, remainingPercent: 75, resetsAt: 200,
        credential: "secret" }], resetCredits: { credits: [{ id: "private-credit" }] } }));
    const handlers = createMobileGraphicalHandlers({ terminalManager: f.terminalManager,
      graphicalService: f.graphicalService, getAgentUsage, send: f.send });
    await expect(handlers.handle(f.socket, { type: "graphical.usage", sessionId: "graph-1",
      threadId: "thread-1", requestId: "u1" })).rejects.toThrow("先打开");
    await handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await expect(handlers.handle(f.socket, { type: "graphical.usage", sessionId: "graph-1",
      threadId: "old", requestId: "u2" })).rejects.toThrow("已切换");
    await handlers.handle(f.socket, { type: "graphical.usage", sessionId: "graph-1",
      threadId: "thread-1", requestId: "u3", force: true });
    expect(getAgentUsage).toHaveBeenCalledWith("graph-1", { force: true });
    const response = f.send.mock.calls.at(-1)[1];
    expect(response).toMatchObject({ type: "graphical.usage", sessionId: "graph-1", requestId: "u3",
      usage: { provider: "codex", limits: [{ remainingPercent: 75 }] } });
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(JSON.stringify(response)).not.toContain("private-credit");
    f.session.agentProvider = "opencode";
    await expect(handlers.handle(f.socket, { type: "graphical.usage", sessionId: "graph-1",
      threadId: "thread-1", requestId: "u4" })).rejects.toThrow("不提供额度");
  });

  it("allows Qoder quota on Windows and WSL but rejects SSH quota", async () => {
    const f = fixture();
    const getAgentUsage = vi.fn(async () => ({ provider: "qoder", fetchedAt: 100,
      primaryLimitId: "credits", summary: { kind: "credits", total: 100, used: 25, remaining: 75, unit: "Credits" }, limits: [] }));
    const handlers = createMobileGraphicalHandlers({ terminalManager: f.terminalManager,
      graphicalService: f.graphicalService, getAgentUsage, send: f.send });
    f.session.agentProvider = "qoder";
    f.session.type = "windows";
    f.snapshot.provider = "qoder";
    await handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await handlers.handle(f.socket, { type: "graphical.usage", sessionId: "graph-1",
      threadId: "thread-1", requestId: "q1" });
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.usage",
      usage: expect.objectContaining({ provider: "qoder", summary: expect.objectContaining({ remaining: 75 }) }) }));
    f.session.type = "ssh";
    await expect(handlers.handle(f.socket, { type: "graphical.usage", sessionId: "graph-1",
      threadId: "thread-1", requestId: "q2" })).rejects.toThrow("不提供额度查询");
  });

  it("allows Gemini quota in a graphical Windows session", async () => {
    const f = fixture();
    f.session.agentProvider = "gemini";
    f.session.type = "windows";
    f.snapshot.provider = "gemini";
    const getAgentUsage = vi.fn(async () => ({ provider: "gemini", fetchedAt: 100, primaryLimitId: "daily", limits: [] }));
    const handlers = createMobileGraphicalHandlers({ terminalManager: f.terminalManager,
      graphicalService: f.graphicalService, getAgentUsage, send: f.send });
    await handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await handlers.handle(f.socket, { type: "graphical.usage", sessionId: "graph-1",
      threadId: "thread-1", requestId: "gemini-usage" });
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.usage",
      usage: expect.objectContaining({ provider: "gemini" }) }));
  });

  it("rejects terminal sessions and allows history only for the active graphical session", async () => {
    const f = fixture();
    f.terminalManager.getSession.mockImplementation(id => id === "terminal-1" ? { id, runtimeMode: "terminal" } : id === "graph-1" ? { id, runtimeMode: "app-server" } : null);
    await expect(f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "terminal-1" })).rejects.toThrow("图形会话不存在");
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await f.handlers.handle(f.socket, { type: "graphical.history", sessionId: "graph-1", threadId: "thread-1", requestId: "h1" });
    expect(f.send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.history", requestId: "h1" }));
  });

  it("projects current configuration without leaking unrelated state", () => {
    const projected = toMobileGraphicalSnapshot({
      ...fixture().snapshot, model: "gpt-6", effectiveModel: "gpt-6", effort: "high", fastMode: true,
      models: [{ id: "gpt-6", displayName: "GPT-6", private: "secret" }],
      acpOptions: [{ id: "model", currentValue: "gpt-6", options: [{ value: "gpt-6", name: "GPT-6", private: "secret" }] },
        { id: "apiKey", currentValue: "secret" }],
      nativeModes: [{ id: "default", name: "Default", private: "secret" }]
    });
    expect(projected).toMatchObject({ model: "gpt-6", effort: "high", fastMode: true,
      models: [{ id: "gpt-6", displayName: "GPT-6" }], acpOptions: [{ id: "model", currentValue: "gpt-6" }] });
    expect(projected.acpOptions).toHaveLength(1);
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("projects only OpenCode context counts", () => {
    const projected = toMobileGraphicalSnapshot({ ...fixture().snapshot, provider: "opencode",
      contextUsage: { used: 250, size: 1000, categories: { tools: 50 }, private: "secret" } });
    expect(projected.contextUsage).toEqual({ used: 250, size: 1000 });
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("switches only advertised models for each provider", async () => {
    const f = fixture();
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    f.snapshot.backend = "openai";
    f.snapshot.models = [{ id: "gpt-6" }];
    await f.handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1", modelId: "gpt-6" });
    expect(f.graphicalService.setModel).toHaveBeenCalledWith("graph-1", "gpt-6");
    f.snapshot.backend = "other";
    await expect(f.handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1", modelId: "gpt-6" })).rejects.toThrow("可用的模型");
    for (const provider of ["codebuddy", "opencode"]) {
      f.snapshot.provider = provider;
      f.snapshot.acpOptions = [{ id: "model", options: [{ value: "model-a" }] }];
      await f.handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1", modelId: "model-a" });
      await expect(f.handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1", modelId: "other" })).rejects.toThrow("可用的模型");
    }
    f.snapshot.busy = true;
    await expect(f.handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1", modelId: "model-a" })).rejects.toThrow("不可切换");
  });

  it("filters local OpenCode MiniMax variants and rejects hidden models on mobile", async () => {
    const f = fixture();
    f.session.type = "windows";
    f.session.agentProvider = "opencode";
    f.snapshot.provider = "opencode";
    f.snapshot.acpOptions = [{ id: "model", currentValue: "minimax-cn/MiniMax-M2.7-highspeed", options: [
      { value: "minimax-cn/MiniMax-M2.7-highspeed", name: "Current CN" },
      { value: "minimax-cn-coding-plan/MiniMax-M2.7", name: "Coding Plan" },
      { value: "minimax/MiniMax-M3", name: "Verified" },
      { value: "minimax/MiniMax-M2", name: "Unverified" },
      { value: "opencode/free", name: "Free" }
    ] }];
    const getOpenCodeVerifiedModels = vi.fn(() => ({ minimax: new Set(["minimax/MiniMax-M3"]) }));
    const handlers = createMobileGraphicalHandlers({ terminalManager: f.terminalManager,
      graphicalService: f.graphicalService, getOpenCodeVerifiedModels, send: f.send });
    await handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    const modelOption = f.send.mock.calls.at(-1)[1].snapshot.acpOptions[0];
    expect(modelOption.currentValue).toBe("minimax-cn/MiniMax-M2.7-highspeed");
    expect(modelOption.options.map(option => option.value)).toEqual(["minimax/MiniMax-M3", "opencode/free"]);
    await expect(handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1",
      modelId: "minimax-cn/MiniMax-M2.7-highspeed" })).rejects.toThrow("可用的模型");
    await handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1",
      modelId: "minimax/MiniMax-M3" });
    expect(f.graphicalService.setModel).toHaveBeenCalledWith("graph-1", "minimax/MiniMax-M3");
    f.session.type = "ssh";
    f.send.mockClear();
    await handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    expect(f.send.mock.calls.at(-1)[1].snapshot.acpOptions[0].options).toHaveLength(5);
    await handlers.handle(f.socket, { type: "graphical.model", sessionId: "graph-1", threadId: "thread-1",
      modelId: "minimax-cn/MiniMax-M2.7-highspeed" });
    expect(f.graphicalService.setModel).toHaveBeenCalledWith("graph-1", "minimax-cn/MiniMax-M2.7-highspeed");
  });

  it("sends only uploaded files belonging to this socket and thread", async () => {
    const f = fixture();
    const uploads = { prepare: vi.fn(() => ({ fileId: "file-1", url: "/upload" })),
      paths: vi.fn(() => ["C:\\temp\\photo.png"]), consume: vi.fn(), discard: vi.fn() };
    const handlers = createMobileGraphicalHandlers({ terminalManager: f.terminalManager, graphicalService: f.graphicalService, uploads, send: f.send });
    await handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await handlers.handle(f.socket, { type: "graphical.upload.prepare", sessionId: "graph-1", threadId: "thread-1", name: "photo.png", size: 3, requestId: "u1" });
    expect(uploads.prepare).toHaveBeenCalledWith(f.socket, "graph-1", "thread-1", "photo.png", 3);
    await handlers.handle(f.socket, { type: "graphical.submit", sessionId: "graph-1", threadId: "thread-1", text: "", fileIds: ["file-1"] });
    expect(uploads.paths).toHaveBeenCalledWith(f.socket, "graph-1", "thread-1", ["file-1"]);
    expect(f.graphicalService.allowFiles).toHaveBeenCalledWith("graph-1", ["C:\\temp\\photo.png"]);
    expect(f.graphicalService.submit).toHaveBeenCalledWith("graph-1", "", ["C:\\temp\\photo.png"]);
    expect(uploads.consume).toHaveBeenCalledWith(["file-1"]);
  });

  it("projects tool details needed by the mobile timeline", () => {
    const projected = toMobileGraphicalSnapshot({ ...fixture().snapshot, items: [
      { id: "file-1", type: "fileChange", changes: [{ path: "src/App.tsx" }], private: "secret" },
      { id: "search-1", type: "mcpToolCall", server: "docs", tool: "find", arguments: { topic: "ACP" }, result: { count: 2 } }
    ] });
    expect(projected.items).toMatchObject([
      { id: "file-1", changes: [{ path: "src/App.tsx" }] },
      { id: "search-1", server: "docs", tool: "find", arguments: { topic: "ACP" }, result: { count: 2 } }
    ]);
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("projects Codex error diagnostics without exposing unrelated diagnostic data", () => {
    const projected = toMobileGraphicalSnapshot({ ...fixture().snapshot, provider: "codex", diagnostics: [
      { id: "error-1", turnId: "turn-1", kind: "error", at: 1000,
        payload: { message: "额度不足", kind: "UsageLimitExceeded", httpStatusCode: 429, additionalDetails: "稍后重试", private: "secret" } },
      { id: "warning-1", turnId: "turn-1", kind: "warning", at: 1001, payload: { message: "其他诊断" } }
    ] });
    expect(projected.diagnostics).toEqual([{ id: "error-1", turnId: "turn-1", at: 1000,
      message: "额度不足", kind: "UsageLimitExceeded", httpStatusCode: 429, additionalDetails: "稍后重试" }]);
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("routes Codex mode changes and allows only advertised safe ACP modes", async () => {
    const f = fixture();
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    await f.handlers.handle(f.socket, { type: "graphical.mode", sessionId: "graph-1", threadId: "thread-1", mode: "plan", requestId: "m1" });
    expect(f.graphicalService.setMode).toHaveBeenCalledWith("graph-1", "plan");
    f.snapshot.provider = "codebuddy";
    f.snapshot.nativeModes = [{ id: "acceptEdits" }, { id: "plan" }, { id: "bypassPermissions" }];
    await f.handlers.handle(f.socket, { type: "graphical.mode", sessionId: "graph-1", threadId: "thread-1", mode: "default", requestId: "m2" });
    expect(f.graphicalService.setNativeMode).toHaveBeenCalledWith("graph-1", "bypassPermissions");
    await f.handlers.handle(f.socket, { type: "graphical.mode", sessionId: "graph-1", threadId: "thread-1", mode: "plan", requestId: "m3" });
    expect(f.graphicalService.setNativeMode).toHaveBeenCalledWith("graph-1", "plan");
    f.snapshot.provider = "opencode";
    f.snapshot.nativeModes = [{ id: "build" }, { id: "plan" }];
    await f.handlers.handle(f.socket, { type: "graphical.mode", sessionId: "graph-1", threadId: "thread-1", mode: "default", requestId: "m4" });
    expect(f.graphicalService.setNativeMode).toHaveBeenCalledWith("graph-1", "build");
    f.snapshot.nativeModes = [{ id: "bypassPermissions" }];
    await expect(f.handlers.handle(f.socket, { type: "graphical.mode", sessionId: "graph-1", threadId: "thread-1", mode: "default" }))
      .rejects.toThrow("不支持 Exec");
    f.snapshot.busy = true;
    await expect(f.handlers.handle(f.socket, { type: "graphical.mode", sessionId: "graph-1", threadId: "thread-1", mode: "plan" }))
      .rejects.toThrow("不可切换");
  });

  it("routes Codex permissions and advertised ACP native modes", async () => {
    const f = fixture();
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    f.snapshot.capabilities = { permissions: true, supportedPermissions: ["askApproval", "fullAccess"] };
    await f.handlers.handle(f.socket, { type: "graphical.permission", sessionId: "graph-1", threadId: "thread-1", permission: "fullAccess", requestId: "p1" });
    expect(f.graphicalService.setExecutionPermission).toHaveBeenCalledWith("graph-1", "fullAccess");
    await expect(f.handlers.handle(f.socket, { type: "graphical.permission", sessionId: "graph-1", threadId: "thread-1", permission: "readOnly" }))
      .rejects.toThrow("不支持此执行权限");
    f.snapshot.provider = "opencode";
    f.snapshot.nativeModes = [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }];
    await f.handlers.handle(f.socket, { type: "graphical.native-mode", sessionId: "graph-1", threadId: "thread-1", modeId: "bypassPermissions", requestId: "n1" });
    expect(f.graphicalService.setNativeMode).toHaveBeenCalledWith("graph-1", "bypassPermissions");
    await expect(f.handlers.handle(f.socket, { type: "graphical.native-mode", sessionId: "graph-1", threadId: "thread-1", modeId: "unknown" }))
      .rejects.toThrow("可用的模式");
    f.snapshot.busy = true;
    await expect(f.handlers.handle(f.socket, { type: "graphical.native-mode", sessionId: "graph-1", threadId: "thread-1", modeId: "plan" }))
      .rejects.toThrow("不可切换");
  });

  it("routes OpenCode plan execution through the service and keeps CodeBuddy confirmation gated", async () => {
    const f = fixture();
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    f.snapshot.provider = "opencode";
    f.snapshot.pendingPlan = null;
    await f.handlers.handle(f.socket, { type: "graphical.plan", sessionId: "graph-1", threadId: "thread-1",
      itemId: "plan-1", execute: true, requestId: "p1" });
    expect(f.graphicalService.executePlan).toHaveBeenCalledWith("graph-1", "plan-1");
    expect(f.send).toHaveBeenCalledWith(f.socket, { type: "command.ok", requestId: "p1" });
    await expect(f.handlers.handle(f.socket, { type: "graphical.plan", sessionId: "graph-1", threadId: "thread-1",
      itemId: "plan-1", execute: false })).rejects.toThrow("失效");
    f.snapshot.provider = "codebuddy";
    await expect(f.handlers.handle(f.socket, { type: "graphical.plan", sessionId: "graph-1", threadId: "thread-1",
      itemId: "plan-1", execute: true })).rejects.toThrow("失效");
  });

  it("allows only idle graphical Agent switches with the current thread", async () => {
    const f = fixture();
    f.snapshot.approvals = [];
    f.snapshot.questions = [];
    await f.handlers.handle(f.socket, { type: "graphical.subscribe", sessionId: "graph-1" });
    for (const current of ["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"]) {
      f.session.agentProvider = current;
      f.snapshot.provider = current;
      for (const provider of ["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"].filter(value => value !== current)) {
        expect(f.handlers.assertSwitchAllowed(f.socket, { sessionId: "graph-1", threadId: "thread-1", provider }))
          .toBe("graph-1");
      }
    }
    f.session.agentProvider = "codex";
    f.snapshot.provider = "codex";
    f.session.type = "ssh";
    expect(() => f.handlers.assertSwitchAllowed(f.socket, { sessionId: "graph-1", threadId: "thread-1", provider: "grok" }))
      .toThrow("无效的目标");
    f.session.type = "windows";
    expect(() => f.handlers.assertSwitchAllowed(f.socket, { sessionId: "graph-1", threadId: "old", provider: "codebuddy" }))
      .toThrow("已切换");
    for (const provider of ["codex", "invalid"]) {
      expect(() => f.handlers.assertSwitchAllowed(f.socket, { sessionId: "graph-1", threadId: "thread-1", provider }))
        .toThrow("无效的目标");
    }
    for (const pending of [{ busy: true }, { approvals: [{ requestId: 1 }] },
      { questions: [{ requestId: 2 }] }, { pendingPlan: { itemId: "plan-1" } }]) {
      Object.assign(f.snapshot, pending);
      expect(() => f.handlers.assertSwitchAllowed(f.socket, { sessionId: "graph-1", threadId: "thread-1", provider: "opencode" }))
        .toThrow("待处理操作");
      Object.assign(f.snapshot, { busy: false, approvals: [], questions: [], pendingPlan: null });
    }
  });
});
