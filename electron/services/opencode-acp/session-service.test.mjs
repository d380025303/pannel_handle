import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createOpenCodeAcpSessionService, buildInvocation } = require("./session-service.cjs");
const { stopAgentChild } = require("../codebuddy-acp/session-service.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.stdin.on("data", chunk => onMessage(JSON.parse(String(chunk)), value => child.stdout.write(`${JSON.stringify(value)}\n`)));
  return child;
}

const configOptions = [
  { id: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
  { id: "model", type: "select", currentValue: "openai/gpt-5", options: [{ value: "openai/gpt-5", name: "GPT-5" }, { value: "openai/gpt-5.5", name: "GPT-5.5" }] },
  { id: "effort", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] }
];

describe("OpenCode ACP sessions", () => {
  it("stops only the owned Windows OpenCode process tree", () => {
    const child = { pid: 12345, exitCode: null, kill: vi.fn() };
    const killer = new EventEmitter();
    const spawnKiller = vi.fn(() => killer);
    stopAgentChild(child, "opencode", { platform: "win32", spawnKiller });
    expect(spawnKiller).toHaveBeenCalledWith("taskkill.exe", ["/pid", "12345", "/t", "/f"],
      { windowsHide: true, stdio: "ignore" });
    killer.emit("exit", 0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the owned child when process-tree cleanup fails", () => {
    const child = { pid: 12345, exitCode: null, kill: vi.fn() };
    const killer = new EventEmitter();
    const onError = vi.fn();
    stopAgentChild(child, "opencode", { platform: "win32", spawnKiller: () => killer, onError });
    killer.emit("exit", 1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not target a PID after its ACP process has exited", () => {
    const child = { pid: 12345, exitCode: 0, kill: vi.fn() };
    const spawnKiller = vi.fn();
    stopAgentChild(child, "opencode", { platform: "win32", spawnKiller });
    expect(spawnKiller).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("closes remote transports without targeting unrelated Windows processes", () => {
    const child = { kill: vi.fn() };
    const spawnKiller = vi.fn();
    stopAgentChild(child, "opencode", { platform: "win32", spawnKiller });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(spawnKiller).not.toHaveBeenCalled();
  });

  it("routes the shared graphical API to OpenCode", () => {
    const codex = { snapshot: vi.fn(), close: vi.fn(), shutdown: vi.fn() };
    const buddy = { snapshot: vi.fn(), close: vi.fn(), shutdown: vi.fn() };
    const openCode = { snapshot: vi.fn(() => "open-code"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy,
      { getSession: () => ({ agentProvider: "opencode" }) }, openCode);
    expect(router.snapshot("run-1")).toBe("open-code");
    router.close("run-1");
    expect(openCode.close).toHaveBeenCalledWith("run-1");
  });
  it("launches the official ACP command on Windows and WSL", () => {
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1)).toContain("opencode acp");
    const wsl = buildInvocation({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, {}, {});
    expect(wsl.executable).toBe("wsl.exe");
    expect(wsl.args.at(-1)).toContain("exec opencode acp");
  });

  it("uses the SSH stdio transport for remote OpenCode", async () => {
    const transport = new EventEmitter();
    transport.write = vi.fn(chunk => {
      const message = JSON.parse(String(chunk));
      transport.emit("stdout", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: message.method === "initialize" ? { agentCapabilities: {} } : { sessionId: "remote" } })}\n`));
    });
    transport.close = vi.fn();
    const createStdioTransport = vi.fn(async () => transport);
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), setAppServerConnectionState: vi.fn() }, broadcast: vi.fn(),
      sshAgentTransport: { createStdioTransport } });
    await service.start({ id: "ssh", type: "ssh", cwd: "/srv/app" });
    expect(createStdioTransport.mock.calls[0][1].command).toContain("exec opencode acp");
    expect(service.snapshot("ssh").provider).toBe("opencode");
    service.close("ssh");
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("uses advertised model and effort options and handles a streamed turn", async () => {
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread", configOptions } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id,
        result: { configOptions: configOptions.map(option => option.id === message.params.configId ? { ...option, currentValue: message.params.value } : option) } });
      else if (message.method === "session/prompt") {
        expect(message.params._meta).toBeUndefined();
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
        emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    });
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    expect(service.snapshot("one").nativeModes.map(mode => mode.id)).toEqual(["build", "plan"]);
    expect((await service.setModel("one", "openai/gpt-5.5")).acpOptions.find(option => option.id === "model").currentValue).toBe("openai/gpt-5.5");
    expect((await service.setEffort("one", "high")).acpOptions.find(option => option.id === "effort").currentValue).toBe("high");
    await service.submit("one", "Hello");
    expect(service.snapshot("one").items.some(item => item.text === "Done")).toBe(true);
    service.shutdown();
  });

  it("enforces the restricted local SSH bridge mode before accepting prompts", async () => {
    const requests = [];
    const child = fakeChild((message, emit) => {
      requests.push(message);
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: "bridge", configOptions: [{ id: "mode", type: "select", currentValue: "build",
          options: [{ value: "build", name: "Build" }, { value: "pannel-handle-remote", name: "Remote" }] }] } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id, result: {} });
    });
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "bridge", type: "ssh", cwd: "/srv/app", shell: "powershell.exe" },
      { localBridge: true, workspaceCwd: "C:\\bridge", requiredMode: "pannel-handle-remote" });
    expect(requests.some(message => message.method === "session/set_config_option" && message.params.value === "pannel-handle-remote")).toBe(true);
    expect(service.snapshot("bridge").nativeModes.map(mode => mode.id)).toEqual(["pannel-handle-remote"]);
    await expect(service.setNativeMode("bridge", "build")).rejects.toThrow("受限 Agent");
    service.shutdown();
  });
});
