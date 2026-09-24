import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createCodeBuddyAcpSessionService, buildInvocation } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("./session-router.cjs");

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.stdin.on("data", chunk => onMessage(JSON.parse(String(chunk)), value => child.stdout.write(`${JSON.stringify(value)}\n`)));
  return child;
}

describe("CodeBuddy ACP sessions", () => {
  it("starts in Windows and WSL using the native ACP command", () => {
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1)).toContain("codebuddy --acp");
    const wsl = buildInvocation({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, {}, {});
    expect(wsl.executable).toBe("wsl.exe");
    expect(wsl.args.at(-1)).toContain("exec codebuddy --acp");
    const bridge = buildInvocation({ type: "ssh", cwd: "/srv/app", shell: "powershell.exe" },
      { localBridge: true, workspaceCwd: "C:\\bridge", acpArgs: "--acp --strict-mcp-config" }, {});
    expect(bridge.cwd).toBe("C:\\bridge");
    expect(bridge.args.at(-1)).toContain("--strict-mcp-config");
  });

  it("starts an SSH remote CLI over the existing stdio transport", async () => {
    const transport = new EventEmitter();
    transport.write = vi.fn(chunk => {
      const message = JSON.parse(String(chunk));
      const result = message.method === "initialize" ? { agentCapabilities: {} } : { sessionId: "remote-thread" };
      transport.emit("stdout", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
    });
    transport.close = vi.fn();
    const createStdioTransport = vi.fn(async () => transport);
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({ FLAG: "yes" }) },
      terminalManager: { broadcastAgentStatus: vi.fn(), setAppServerConnectionState: vi.fn() }, broadcast: vi.fn(),
      sshAgentTransport: { createStdioTransport } });
    await service.start({ id: "ssh-1", type: "ssh", cwd: "/srv/app", agentProvider: "codebuddy" });
    expect(service.snapshot("ssh-1").threadId).toBe("remote-thread");
    const command = createStdioTransport.mock.calls[0][1].command;
    expect(command).toContain("exec codebuddy --acp");
    expect(command).toContain("/srv/app");
    expect(command).toContain("export FLAG=");
    service.shutdown();
    expect(transport.close).toHaveBeenCalled();
  });

  it("streams messages, requests approval once, and completes a turn", async () => {
    const broadcast = vi.fn();
    let child;
    child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: "thread-1", modes: { currentModeId: "default", availableModes: [
          { id: "default" }, { id: "plan" }, { id: "bypassPermissions" }] } } });
      else if (message.method === "session/prompt") {
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } } });
        emit({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: {
          sessionId: "thread-1", toolCall: { toolCallId: "tool-1", title: "Run tests" }, options: [
            { optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
      } else if (message.id === 900) {
        expect(message.result.outcome).toEqual({ outcome: "selected", optionId: "yes" });
        emit({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
      }
    });
    const terminalManager = { broadcastAgentStatus: vi.fn(), getSession: vi.fn(() => ({ id: "one", agentProvider: "codebuddy" })) };
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) }, terminalManager,
      broadcast, spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    const turn = service.submit("one", "Hi");
    await vi.waitFor(() => expect(service.snapshot("one").approvals).toHaveLength(1));
    expect(service.snapshot("one").items.some(item => item.text === "Hello")).toBe(true);
    service.resolveApproval("one", 900, true);
    await turn;
    expect(service.snapshot("one").busy).toBe(false);
    expect(service.snapshot("one").capabilities.supportedPermissions).toEqual(["readOnly", "askApproval", "fullAccess"]);
    expect(broadcast).toHaveBeenCalledWith("codex-app-server:changed", expect.any(Object));
    service.shutdown();
  });

  it("routes graphical calls by session provider", () => {
    const codex = { snapshot: vi.fn(() => "codex"), close: vi.fn(), shutdown: vi.fn() };
    const buddy = { snapshot: vi.fn(() => "buddy"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy, { getSession: id => ({ agentProvider: id === "buddy" ? "codebuddy" : "codex" }) });
    expect(router.snapshot("buddy")).toBe("buddy");
    expect(router.snapshot("codex")).toBe("codex");
    router.close("buddy");
    expect(codex.close).toHaveBeenCalledWith("buddy");
    expect(buddy.close).toHaveBeenCalledWith("buddy");
  });

  it("loads only listed history for this workspace and restores replayed messages", async () => {
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: {
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new" } });
      else if (message.method === "session/list") emit({ jsonrpc: "2.0", id: message.id, result: { sessions: [
        { sessionId: "old", cwd: "C:\\work", title: "Previous", updatedAt: "2026-09-24T00:00:00Z" },
        { sessionId: "other", cwd: "C:\\other", title: "Other" } ] } });
      else if (message.method === "session/load") {
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "old", update: {
          sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "Old prompt" } } } });
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "old", update: {
          sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "Old answer" } } } });
        emit({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "session/set_mode") emit({ jsonrpc: "2.0", id: message.id, result: {} });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    const history = await service.listHistory("one");
    expect(history.data.map(value => value.id)).toEqual(["old"]);
    await expect(service.resume("one", "other")).rejects.toThrow("当前项目");
    const restored = await service.resume("one", "old");
    expect(restored.threadId).toBe("old");
    expect(restored.items.map(item => item.text)).toEqual(["Old prompt", "Old answer"]);
    service.shutdown();
  });
});
