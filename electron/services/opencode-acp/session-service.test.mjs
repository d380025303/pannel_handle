import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createOpenCodeAcpSessionService, buildInvocation } = require("./session-service.cjs");
const { stopAgentChild } = require("../codebuddy-acp/session-service.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");
const { createSessionStore } = require("../../stores/session-store.cjs");

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
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" },
      { openCodeQuestions: true }, {}).args.at(-1)).not.toContain("--port");
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

  it("registers a question MCP server and returns user answers to its pending tool", async () => {
    let onQuestion;
    const questionBridge = { url: "http://127.0.0.1:1234/mcp", token: "secret",
      answer: vi.fn(), cancel: vi.fn(), close: vi.fn() };
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") {
        expect(message.params.mcpServers).toEqual([{ name: "pannel_handle_question", type: "http",
          url: questionBridge.url, headers: [{ name: "Authorization", value: "Bearer secret" }] }]);
        emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread" } });
      }
    });
    const spawnProcess = vi.fn(() => child);
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess,
      openCodeQuestionBridgeFactory: async ({ onQuestion: callback }) => { onQuestion = callback; return questionBridge; } });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, { openCodeQuestions: true });
    expect(spawnProcess.mock.calls[0][2].env.OPENCODE_ENABLE_QUESTION_TOOL).toBe("0");
    onQuestion({ requestId: "question-1", questions: [{ id: "plan", header: "方案", question: "选择方案",
      options: [{ label: "方案甲" }], isOther: true }] });
    expect(service.snapshot("one").questions).toHaveLength(1);
    await service.answerQuestion("one", "question-1", { plan: { answers: ["方案甲"] } });
    expect(questionBridge.answer).toHaveBeenCalledWith("question-1", { plan: ["方案甲"] });
    expect(service.snapshot("one").questions).toHaveLength(0);
    onQuestion({ requestId: "question-2", questions: [{ id: "reason", question: "原因", isOther: true }] });
    await service.cancelQuestion("one", "question-2");
    expect(questionBridge.cancel).toHaveBeenCalledWith("question-2");
    service.shutdown();
    expect(questionBridge.close).toHaveBeenCalledOnce();
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

  it("reports graphical token checkpoints after turns and when loading history or resetting statistics", async () => {
    const onTokenUsageCheckpoint = vi.fn(async () => {});
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new" || message.method === "session/load")
        emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.method === "session/new" ? "fresh" : "history" } });
      else if (message.method === "session/list")
        emit({ jsonrpc: "2.0", id: message.id, result: { sessions: [{ sessionId: "history", cwd: "C:\\work" }] } });
      else if (message.method === "session/prompt")
        emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    });
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({ XDG_DATA_HOME: "/data" }) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(),
      spawnProcess: () => child, onTokenUsageCheckpoint });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await service.submit("one", "Hello");
    await vi.waitFor(() => expect(onTokenUsageCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "fresh", environment: { XDG_DATA_HOME: "/data" } })));
    await service.listHistory("one");
    await service.resume("one", "history");
    expect(onTokenUsageCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ threadId: "history", resumed: true }));
    service.resetUsageBaselines();
    await vi.waitFor(() => expect(onTokenUsageCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "history", baseline: true })));
    service.shutdown();
  });

  it("remembers successful model and mode choices across OpenCode sessions and new threads", async () => {
    const saved = new Map();
    const requests = [];
    let nextThread = 0;
    const sessionStore = {
      getTemplate: vi.fn(id => ({ openCodeGraphicalOptions: saved.get(id) })),
      updateLibrary: vi.fn((id, update) => saved.set(id, update.openCodeGraphicalOptions))
    };
    const makeChild = () => fakeChild((message, emit) => {
      requests.push(message);
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: `thread-${++nextThread}`, configOptions } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id,
        result: { configOptions: configOptions.map(option => option.id === message.params.configId
          ? { ...option, currentValue: message.params.value } : option) } });
    });
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, sessionStore, broadcast: vi.fn(), spawnProcess: makeChild });
    const session = { id: "one", templateId: "saved-1", type: "windows", cwd: "C:\\work", shell: "powershell.exe" };
    await service.start(session);
    await service.setModel("one", "openai/gpt-5.5");
    await service.setNativeMode("one", "plan");
    expect(saved.get("saved-1")).toEqual({ model: "openai/gpt-5.5", mode: "plan" });

    await service.newThread("one");
    expect(service.snapshot("one").nativeMode).toBe("plan");
    expect(service.snapshot("one").acpOptions.find(option => option.id === "model").currentValue).toBe("openai/gpt-5.5");
    service.close("one");

    await service.start({ ...session, id: "two" });
    expect(service.snapshot("two").nativeMode).toBe("plan");
    expect(service.snapshot("two").acpOptions.find(option => option.id === "model").currentValue).toBe("openai/gpt-5.5");
    await service.start({ id: "other", templateId: "saved-2", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    expect(service.snapshot("other").nativeMode).toBe("build");
    expect(service.snapshot("other").acpOptions.find(option => option.id === "model").currentValue).toBe("openai/gpt-5");
    expect(requests.filter(request => request.method === "session/set_config_option" && request.params.value === "openai/gpt-5.5")).toHaveLength(3);
    service.shutdown();
  });

  it("restores the selected model after closing and reopening the same saved template", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pannel-opencode-model-"));
    const sessionsFile = path.join(directory, "sessions.json");
    const makeStore = () => createSessionStore({ sessionsFile,
      getDefaultShell: () => "powershell.exe", getWslShell: () => "wsl.exe" });
    const makeChild = () => fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: `thread-${message.id}`, configOptions } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id,
        result: { configOptions: configOptions.map(option => option.id === message.params.configId
          ? { ...option, currentValue: message.params.value } : option) } });
    });
    const makeService = sessionStore => createOpenCodeAcpSessionService({
      environmentService: { resolve: () => ({}) }, terminalManager: { broadcastAgentStatus: vi.fn() },
      sessionStore, broadcast: vi.fn(), spawnProcess: makeChild
    });
    let service;
    try {
      const store = makeStore();
      store.loadLibrary();
      for (const id of ["saved-1", "saved-2"]) store.addToLibrary({ id, type: "windows", cwd: "C:\\work",
        agentProvider: "opencode", graphicalSessionEnabled: true });
      service = makeService(store);
      await service.start({ ...store.getTemplate("saved-1"), id: "run-1", templateId: "saved-1" });
      await service.setModel("run-1", "openai/gpt-5.5");
      service.close("run-1");
      service.shutdown();

      const reopenedStore = makeStore();
      reopenedStore.loadLibrary();
      expect(reopenedStore.getTemplate("saved-1").openCodeGraphicalOptions.model).toBe("openai/gpt-5.5");
      expect(reopenedStore.getTemplate("saved-2").openCodeGraphicalOptions).toBeUndefined();
      service = makeService(reopenedStore);
      await service.start({ ...reopenedStore.getTemplate("saved-1"), id: "run-2", templateId: "saved-1" });
      expect(service.snapshot("run-2").acpOptions.find(option => option.id === "model").currentValue).toBe("openai/gpt-5.5");
      await service.start({ ...reopenedStore.getTemplate("saved-2"), id: "run-3", templateId: "saved-2" });
      expect(service.snapshot("run-3").acpOptions.find(option => option.id === "model").currentValue).toBe("openai/gpt-5");
    } finally {
      service?.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores unavailable saved choices and does not save failed changes", async () => {
    const saved = { mode: "removed", model: "openai/removed" };
    const sessionStore = { getTemplate: vi.fn(() => ({ openCodeGraphicalOptions: saved })), updateLibrary: vi.fn() };
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread", configOptions } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id,
        error: { code: -32000, message: "rejected" } });
    });
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, sessionStore, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", templateId: "saved-1", type: "windows", cwd: "C:\\work" });
    expect(service.snapshot("one").nativeMode).toBe("build");
    expect(service.snapshot("one").acpOptions.find(option => option.id === "model").currentValue).toBe("openai/gpt-5");
    await expect(service.setModel("one", "openai/gpt-5.5")).rejects.toThrow("rejected");
    expect(sessionStore.updateLibrary).not.toHaveBeenCalled();
    service.shutdown();
  });

  it("selects a configured external model after ACP exposes it", async () => {
    const requests = [];
    const options = [{ id: "model", type: "select", currentValue: "opencode/free", options: [
      { value: "opencode/free", name: "Free" }, { value: "minimax/MiniMax-M2.7-highspeed", name: "MiniMax" }
    ] }];
    const child = fakeChild((message, emit) => {
      requests.push(message);
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread", configOptions: options } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id, result: {
        configOptions: [{ ...options[0], currentValue: message.params.value }]
      } });
    });
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" },
      { openCodeModel: "minimax/MiniMax-M2.7-highspeed" });
    expect(requests.find(request => request.method === "session/set_config_option")?.params).toMatchObject({
      configId: "model", value: "minimax/MiniMax-M2.7-highspeed"
    });
    expect(service.snapshot("one").acpOptions[0].currentValue).toBe("minimax/MiniMax-M2.7-highspeed");
    service.shutdown();
  });

  it("rejects an external model missing from OpenCode ACP options", async () => {
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread", configOptions } });
    });
    const service = createOpenCodeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await expect(service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" },
      { openCodeModel: "minimax/MiniMax-M2.7-highspeed" })).rejects.toThrow("未提供已配置的模型");
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
      terminalManager: { broadcastAgentStatus: vi.fn() },
      sessionStore: { getTemplate: () => ({ openCodeGraphicalOptions: { mode: "build" } }) },
      broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "bridge", templateId: "saved-bridge", type: "ssh", cwd: "/srv/app", shell: "powershell.exe" },
      { localBridge: true, workspaceCwd: "C:\\bridge", requiredMode: "pannel-handle-remote" });
    expect(requests.some(message => message.method === "session/set_config_option" && message.params.value === "pannel-handle-remote")).toBe(true);
    expect(service.snapshot("bridge").nativeModes.map(mode => mode.id)).toEqual(["pannel-handle-remote"]);
    await expect(service.setNativeMode("bridge", "build")).rejects.toThrow("受限 Agent");
    service.shutdown();
  });
});
