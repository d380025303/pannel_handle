import { describe, it, expect, vi } from "vitest";
import module from "./mobile-codebuddy.cjs";
import graphical from "./mobile-graphical.cjs";
const { createMobileCodeBuddyHandlers } = module;
function fixture() {
  const current = { provider: "codebuddy", threadId: "thread", busy: false, archived: false, items: [], approvals: [], questions: [], capabilities: { sideQuestion: true, rewind: true }, acpOptions: [{ id: "model", options: [{ value: "native-model" }] }, { id: "context_window", options: [{ value: "200k" }] }] };
  const session = { id: "run", type: "windows", runtimeMode: "app-server", agentProvider: "codebuddy" };
  const service = { snapshot: () => current, getWorkspaceCwd: () => "C:\\project", setContextWindow: vi.fn(), askSideQuestion: vi.fn(), rewind: vi.fn(), mcpAppResolve: vi.fn(), mcpAppLoad: vi.fn(), createScheduledTask: vi.fn(), renameThread: vi.fn() };
  const launcher = { switchModelSource: vi.fn(async () => ({ id: "replacement" })) };
  const mcp = { save: vi.fn(), list: vi.fn(() => ({ servers: [] })) };
  const options = { graphicalService: service, agentSessionLauncher: launcher, mcpConfigService: mcp, getCodeBuddyVerifiedModels: () => [{ source: "minimax", id: "verified" }] };
  const handlers = createMobileCodeBuddyHandlers(options);
  const call = (command, input = {}) => handlers.handle({ type: `graphical.codebuddy.${command}`, input }, session, current);
  return { current, session, service, launcher, mcp, options, call };
}
describe("mobile CodeBuddy public commands", () => {
  it("rejects unknown commands and other providers", async () => {
    const f = fixture(); await expect(f.call("shutdown")).rejects.toThrow("不被允许");
    f.session.agentProvider = "codex"; await expect(f.call("models")).rejects.toThrow("仅 CodeBuddy");
  });
  it("switches only verified models and returns the replacement session", async () => {
    const f = fixture(); await expect(f.call("model-source", { source: "minimax", modelId: "unverified" })).rejects.toThrow("验证");
    expect(await f.call("model-source", { source: "minimax", modelId: "verified" })).toEqual({ id: "replacement" });
    expect(f.launcher.switchModelSource).toHaveBeenCalledWith("run", "minimax", true, "verified");
    f.current.questions = [{ requestId: 1 }]; await expect(f.call("model-source", { source: "native" })).rejects.toThrow("不可执行");
  });
  it("keeps platform restrictions and checks current advertised options", async () => {
    const f = fixture(); await expect(f.call("context-window", { value: "1m" })).rejects.toThrow("档位");
    await f.call("context-window", { value: "200k" }); expect(f.service.setContextWindow).toHaveBeenCalledWith("run", "200k");
    f.session.type = "ssh"; await expect(f.call("tasks")).rejects.toThrow("Windows"); expect(await f.call("models")).toEqual([]);
  });
  it("allows side questions while busy but respects capability and cancellation identity", async () => {
    const f = fixture(); f.current.busy = true; await f.call("side-question", { question: "why?" }); expect(f.service.askSideQuestion).toHaveBeenCalledWith("run", "why?");
    await expect(f.call("side-cancel", { requestId: "old" })).rejects.toThrow("失效");
    f.current.capabilities.sideQuestion = false; await expect(f.call("side-question", { question: "why?" })).rejects.toThrow("不支持");
  });
  it("binds rewind to a current user message and uses the desktop scope values", async () => {
    const f = fixture(); f.current.items = [{ id: "user", type: "userMessage", rewindMessageId: "msg" }];
    await expect(f.call("rewind", { messageId: "foreign", scope: "Code" })).rejects.toThrow("无效");
    await f.call("rewind", { messageId: "msg", scope: "CodeAndConversation" }); expect(f.service.rewind).toHaveBeenCalledWith("run", "msg", "CodeAndConversation");
  });
  it("forces MCP configuration to the owning workspace and validates explicit authorization", async () => {
    const f = fixture(); await f.call("mcp-config", { scope: "project", projectPath: "C:\\foreign", sessionId: "other", provider: "codex" });
    expect(f.mcp.list).toHaveBeenCalledWith({ provider: "codebuddy", scope: "project", sessionId: "run", projectPath: "C:\\project" });
    await expect(f.call("app-resolve", { token: "grant", approved: "true" })).rejects.toThrow("参数");
    await f.call("app-resolve", { token: "grant", approved: false }); expect(f.service.mcpAppResolve).toHaveBeenCalledWith("run", "grant", false);
  });
  it("routes only subscribed current threads and correlates results", async () => {
    const f = fixture(), send = vi.fn();
    const terminalManager = { getSession: id => id === "run" ? f.session : null };
    const handlers = graphical.createMobileGraphicalHandlers({ ...f.options, terminalManager, send });
    const socket = { graphicalSessionId: null, subscriptions: new Set() };
    const message = { type: "graphical.codebuddy.models", sessionId: "run", threadId: "thread", requestId: "rpc", input: {} };
    await expect(handlers.handle(socket, message)).rejects.toThrow("先打开");
    await handlers.handle(socket, { type: "graphical.subscribe", sessionId: "run" });
    await expect(handlers.handle(socket, { ...message, threadId: "old" })).rejects.toThrow("已切换");
    await handlers.handle(socket, message);
    expect(send).toHaveBeenCalledWith(socket, expect.objectContaining({ type: "graphical.result", requestId: "rpc", threadId: "thread", result: [{ source: "minimax", id: "verified" }] }));
  });
  it("projects App markers and team messages without resource HTML or credentials", () => {
    const value = graphical.toMobileGraphicalSnapshot({ provider: "codebuddy", mainAgent: { agents: [], token: "secret" },
      team: { name: "team", secret: "secret", members: [{ name: "worker", status: "busy", token: "secret", items: [{ id: "x", text: "hello" }] }] },
      items: [{ id: "tool", mcpApp: { revision: 2, html: "secret" }, rewindMessageId: "msg" }] });
    expect(value.codeBuddyMobile).toBe(true); expect(value.team.members[0].items[0].text).toBe("hello"); expect(value.items[0].mcpApp).toEqual({ revision: 2 });
    expect(JSON.stringify(value)).not.toContain("secret");
  });
});
