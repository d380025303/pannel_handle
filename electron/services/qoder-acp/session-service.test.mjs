import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createQoderAcpSessionService, buildInvocation } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.stdin.on("data", chunk => onMessage(JSON.parse(String(chunk)), value => child.stdout.write(`${JSON.stringify(value)}\n`)));
  return child;
}

describe("Qoder ACP sessions", () => {
  it("routes Qoder without exposing Codex-only operations", () => {
    const codex = { close: vi.fn(), shutdown: vi.fn() };
    const buddy = { close: vi.fn(), shutdown: vi.fn() };
    const qoder = { snapshot: vi.fn(() => "qoder"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy,
      { getSession: () => ({ agentProvider: "qoder" }) }, null, null, qoder);
    expect(router.snapshot("one")).toBe("qoder");
    expect(() => router.readAccount("one")).toThrow("仅 Codex");
    router.close("one");
    expect(qoder.close).toHaveBeenCalledWith("one");
  });

  it("uses qoder --acp locally and restricts the local SSH bridge", () => {
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1)).toContain("qoder --acp");
    const wsl = buildInvocation({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, {}, {});
    expect(wsl.args.at(-1)).toContain("exec qoder --acp");
    const bridge = buildInvocation({ type: "ssh", cwd: "/srv/app", shell: "powershell.exe" },
      { localBridge: true, workspaceCwd: "C:\\bridge", remoteBridge: { instructions: "Use remote tools" } }, {});
    expect(bridge.args.at(-1)).toContain("--tools '' --strict-mcp-config --allowed-mcp-server-names pannel_handle_remote");
  });

  it("uses the SSH stdio transport for a remote Qoder", async () => {
    const transport = new EventEmitter();
    transport.write = vi.fn(chunk => {
      const message = JSON.parse(String(chunk));
      transport.emit("stdout", Buffer.from(`${JSON.stringify({ id: message.id,
        result: message.method === "initialize" ? { agentCapabilities: {} } : { sessionId: "remote" } })}\n`));
    });
    transport.close = vi.fn();
    const createStdioTransport = vi.fn(async () => transport);
    const service = createQoderAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), setAppServerConnectionState: vi.fn() }, broadcast: vi.fn(),
      sshAgentTransport: { createStdioTransport } });
    await service.start({ id: "ssh", type: "ssh", cwd: "/srv/app" });
    expect(createStdioTransport.mock.calls[0][1].command).toContain("exec qoder --acp");
    expect(service.snapshot("ssh").provider).toBe("qoder");
    service.shutdown();
  });

  it("uses advertised modes and handles a streamed turn and permission", async () => {
    const messages = [];
    let emitMessage;
    const child = fakeChild((message, emit) => {
      messages.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread",
        modes: { currentModeId: "default", availableModes: [
          { id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept Edits" },
          { id: "auto", name: "Auto" }, { id: "dontAsk", name: "Don't Ask" },
          { id: "yolo", name: "Bypass Permissions" }] },
        configOptions: [{ id: "mode", type: "select", currentValue: "default",
          options: [{ value: "default", name: "Default" }, { value: "yolo", name: "Bypass Permissions" }] },
        { id: "reasoning_effort", type: "select", currentValue: "medium",
          options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] }] } });
      else if (message.method === "session/set_config_option") emit({ id: message.id, result: {} });
      else if (message.method === "session/prompt") {
        emit({ method: "session/update", params: { sessionId: "thread", update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
        emit({ id: message.id, result: { stopReason: "end_turn" } });
      }
    });
    const service = createQoderAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(service.snapshot("one")).toMatchObject({ provider: "qoder", mode: "default",
      capabilities: { plan: false }, nativeModes: [{ id: "default" }, { id: "yolo" }] });
    expect((await service.setNativeMode("one", "yolo")).executionPermission).toBe("fullAccess");
    expect((await service.setEffort("one", "high")).acpOptions.find(option => option.id === "reasoning_effort").currentValue).toBe("high");
    emitMessage({ id: 42, method: "session/request_permission", params: { sessionId: "thread",
      toolCall: { toolCallId: "tool", title: "修改文件" }, options: [
        { optionId: "allow-once", kind: "allow_once", name: "仅一次" },
        { optionId: "reject", kind: "reject_once", name: "拒绝" }] } });
    expect(service.snapshot("one").approvals).toHaveLength(1);
    service.resolveApproval("one", 42, "reject");
    await service.submit("one", "Hello");
    expect(service.snapshot("one").items.some(item => item.text === "Done")).toBe(true);
    service.shutdown();
  });

  it("fails closed when the local bridge configuration is missing", async () => {
    const spawnProcess = vi.fn();
    const service = createQoderAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: {}, broadcast: vi.fn(), spawnProcess });
    await expect(service.start({ id: "one", type: "ssh", cwd: "/srv/app" }, { localBridge: true }))
      .rejects.toThrow("缺少受限远端工具配置");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("passes only the scoped HTTP MCP server to a local bridge session", async () => {
    const requests = [];
    const child = fakeChild((message, emit) => {
      requests.push(message);
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { mcpCapabilities: { http: true } } } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "bridge",
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "Bypass Permissions" }] } } });
    });
    const service = createQoderAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "ssh", cwd: "/srv/app", shell: "powershell.exe" }, {
      localBridge: true, workspaceCwd: "C:\\bridge", remoteBridge: {
        url: "http://127.0.0.1:4568/mcp", token: "secret", instructions: "Use remote tools."
      }
    });
    expect(requests.find(message => message.method === "session/new").params).toEqual({
      cwd: "C:\\bridge", mcpServers: [{ name: "pannel_handle_remote", type: "http",
        url: "http://127.0.0.1:4568/mcp", headers: [{ name: "Authorization", value: "Bearer secret" }] }]
    });
    expect(service.snapshot("one").nativeModes.map(mode => mode.id)).toEqual(["default", "yolo"]);
    service.shutdown();
  });

  it("rejects a Qoder bridge when the CLI does not advertise HTTP MCP", async () => {
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
    });
    const service = createQoderAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await expect(service.start({ id: "one", type: "ssh", cwd: "/srv/app" }, {
      localBridge: true, remoteBridge: { url: "http://127.0.0.1/mcp", token: "secret", instructions: "Use remote tools." }
    })).rejects.toThrow("HTTP MCP");
  });
});
