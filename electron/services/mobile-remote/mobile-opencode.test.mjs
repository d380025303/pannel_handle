import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createMobileOpenCodeHandlers } = require("./mobile-opencode.cjs");
const { createMobileGraphicalHandlers, toMobileGraphicalSnapshot } = require("./mobile-graphical.cjs");
function fixture() {
  const session = { id: "run", runtimeMode: "app-server", type: "windows", agentProvider: "opencode", modelSource: "minimax" };
  const current = { provider: "opencode", threadId: "thread", busy: false, approvals: [], questions: [], items: [{ id: "user", type: "userMessage", rewindMessageId: "msg" }],
    capabilities: { history: true, renameHistory: true, revertHistory: true }, acpAuth: { status: "idle", methods: [{ id: "login" }] } };
  const service = { snapshot: () => current, listCapabilities: vi.fn(async () => ({ skills: [] })), renameThread: vi.fn(), revertThread: vi.fn(), restoreThread: vi.fn(), cancelQuestion: vi.fn(),
    startAcpLogin: vi.fn(async () => ({ generation: 7, seq: 0, history: "" })), cancelAcpLogin: vi.fn(), writeAcpLogin: vi.fn(), resizeAcpLogin: vi.fn() };
  const version = { check: vi.fn(async () => ({ status: "current" })), update: vi.fn() };
  const launcher = { switchModelSource: vi.fn(async () => ({ id: "replacement" })) };
  const options = { graphicalService: service, openCodeVersionService: version, agentSessionLauncher: launcher };
  const handlers = createMobileOpenCodeHandlers(options), socket = { authenticated: true, graphicalSessionId: "run" };
  const call = (command, input = {}, owner = socket) => handlers.handle({ type: `graphical.opencode.${command}`, input }, session, current, owner);
  return { session, current, service, version, launcher, handlers, options, socket, call };
}
describe("mobile OpenCode", () => {
  it("restricts provider and explicit commands", async () => {
    const f = fixture(); await expect(f.call("shutdown")).rejects.toThrow("不被允许"); f.session.agentProvider = "codex"; await expect(f.call("version")).rejects.toThrow("仅 OpenCode");
  });
  it("loads live capabilities and uses the desktop version service", async () => {
    const f = fixture(); await f.call("capabilities", { refresh: true }); expect(f.service.listCapabilities).toHaveBeenCalledWith("run", true);
    await f.call("version", { force: true }); expect(f.version.check).toHaveBeenCalledWith("run", true);
    f.current.threadId = null; await f.call("version-update"); expect(f.version.update).toHaveBeenCalledWith("run");
  });
  it("validates advertised history capabilities and current revert targets", async () => {
    const f = fixture(); await expect(f.call("revert", { messageId: "foreign" })).rejects.toThrow("目标");
    await f.call("revert", { messageId: "msg" }); expect(f.service.revertThread).toHaveBeenCalledWith("run", "msg");
    await expect(f.call("restore")).rejects.toThrow("没有"); f.current.openCodeRevert = { messageID: "msg" }; await f.call("restore"); expect(f.service.restoreThread).toHaveBeenCalledWith("run");
    await f.call("history.rename", { targetThreadId: "listed", name: "name" }); expect(f.service.renameThread).toHaveBeenCalledWith("run", "listed", "name");
    f.current.questions = [{}]; await expect(f.call("revert", { messageId: "msg" })).rejects.toThrow("不可执行");
  });
  it("preserves model source on reconnect and excludes SSH", async () => {
    const f = fixture(); expect(await f.call("reconnect")).toEqual({ id: "replacement", previousSessionId: "run" }); expect(f.launcher.switchModelSource).toHaveBeenCalledWith("run", "minimax", true);
    f.session.type = "ssh"; await expect(f.call("reconnect")).rejects.toThrow("SSH");
  });
  it("allows authentication without a thread and binds input to the owner and generation", async () => {
    const f = fixture(); f.current.threadId = null;
    await expect(f.call("auth-start", { methodId: "foreign" })).rejects.toThrow("方式");
    await f.call("auth-start", { methodId: "login" });
    await expect(f.call("auth-write", { generation: 7, data: "secret" }, { authenticated: true })).rejects.toThrow("失效");
    await expect(f.call("auth-write", { generation: 6, data: "old" })).rejects.toThrow("失效");
    await f.call("auth-write", { generation: 7, data: "\r" }); expect(f.service.writeAcpLogin).toHaveBeenCalledWith("run", 7, "\r");
    await expect(f.call("auth-resize", { generation: 7, cols: 1000, rows: 24 })).rejects.toThrow("尺寸");
    await f.call("auth-resize", { generation: 7, cols: 80, rows: 20 }); expect(f.service.resizeAcpLogin).toHaveBeenCalledWith("run", 7, 80, 20);
    f.handlers.release(f.socket); expect(f.service.cancelAcpLogin).toHaveBeenCalledWith("run", 7);
  });
  it("sends terminal events only to the authenticated owner with the current generation", async () => {
    const f = fixture(), send = vi.fn(); await f.call("auth-start", { methodId: "login" });
    const event = { id: "run", generation: 7, seq: 1, data: "output", token: "secret" };
    f.handlers.event({ authenticated: true, graphicalSessionId: "run" }, "opencode-auth:data", event, send);
    f.handlers.event(f.socket, "opencode-auth:data", { ...event, generation: 8 }, send); expect(send).not.toHaveBeenCalled();
    f.handlers.event(f.socket, "opencode-auth:data", event, send); expect(send).toHaveBeenCalledOnce(); expect(JSON.stringify(send.mock.calls)).not.toContain("secret");
    f.socket.authenticated = false; f.handlers.event(f.socket, "opencode-auth:data", event, send); expect(send).toHaveBeenCalledOnce();
  });
  it("cancels a login that finishes starting after disconnect and serializes mutations", async () => {
    const f = fixture(); let resolve;
    f.service.startAcpLogin.mockImplementation(() => new Promise(done => { resolve = done; }));
    const starting = f.call("auth-start", { methodId: "login" }); await expect(f.call("reconnect")).rejects.toThrow("正在处理");
    f.handlers.release(f.socket); resolve({ generation: 9, history: "", seq: 0 }); await starting; expect(f.service.cancelAcpLogin).toHaveBeenCalledWith("run", 9);
  });
  it("requires subscription and current thread and accepts OpenCode Question cancellation", async () => {
    const f = fixture(), send = vi.fn(), handlers = createMobileGraphicalHandlers({ ...f.options, terminalManager: { getSession: () => f.session }, send });
    const message = { type: "graphical.opencode.capabilities", sessionId: "run", threadId: "thread", requestId: "rpc", input: {} };
    await expect(handlers.handle({ graphicalSessionId: null }, message)).rejects.toThrow("先打开");
    await expect(handlers.handle(f.socket, { ...message, threadId: "old" })).rejects.toThrow("已切换");
    await handlers.handle(f.socket, message); expect(send).toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "graphical.result", requestId: "rpc" }));
    f.current.questions = [{ requestId: 1 }]; await handlers.handle(f.socket, { type: "graphical.cancelQuestion", sessionId: "run", threadId: "thread", questionId: 1 }); expect(f.service.cancelQuestion).toHaveBeenCalledWith("run", 1);
  });
  it("projects only public login fields, commands and revert markers", () => {
    const projected = toMobileGraphicalSnapshot({ provider: "opencode", acpAuth: { status: "idle", generation: 1, token: "secret", methods: [{ id: "login", name: "Login", env: { KEY: "secret" } }] }, openCodeRevert: { messageID: "msg", files: ["secret"] }, availableCommands: [{ name: "compact", description: "Compact", secret: "secret" }] });
    expect(projected.openCodeMobile).toBe(true); expect(projected.openCodeRevert).toEqual({ messageID: "msg" }); expect(projected.availableCommands[0].name).toBe("compact"); expect(JSON.stringify(projected)).not.toContain("secret");
  });
});
