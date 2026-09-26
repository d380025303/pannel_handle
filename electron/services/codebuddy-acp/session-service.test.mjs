import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createCodeBuddyAcpSessionService: createRawService, buildInvocation } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("./session-router.cjs");

function createCodeBuddyAcpSessionService(options) {
  return createRawService({
    resolveHttpEndpoint: async () => ({ endpoint: new URL("http://127.0.0.1:12345"), password: "test" }),
    httpTransportFactory: ({ child }) => {
      const events = new EventEmitter();
      readline.createInterface({ input: child.stdout }).on("line", line => events.emit("message", JSON.parse(line)));
      return { on: (name, listener) => events.on(name, listener), connect: async () => {},
        send: async message => { child.stdin.write(`${JSON.stringify(message)}\n`); }, close: () => {} };
    },
    ...options
  });
}

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.stdin.on("data", chunk => onMessage(JSON.parse(String(chunk)), value => child.stdout.write(`${JSON.stringify(value)}\n`)));
  return child;
}

describe("CodeBuddy ACP sessions", () => {
  it("shows AskUserQuestion permission requests as questions and submits answers through CodeBuddy", async () => {
    const messages = [];
    let emitMessage;
    const child = fakeChild((message, emit) => {
      messages.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread" } });
      else if (message.method === "_codebuddy.ai/resolveInterruption") emit({ id: message.id, result: { resolved: true, queued: false } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    emitMessage({ id: 91, method: "session/request_permission", params: { sessionId: "thread",
      toolCall: { toolCallId: "call-1", _meta: { "codebuddy.ai/toolName": "AskUserQuestion" }, rawInput: { questions: [
        { header: "方案", question: "选择方案", options: [{ label: "A" }, { label: "B" }] },
        { header: "范围", question: "选择范围", multiSelect: true, options: [{ label: "前端" }, { label: "后端" }] }
      ] } }, options: [{ kind: "allow_once", optionId: "allow", name: "允许" }] } });
    expect(service.snapshot("one").approvals).toEqual([]);
    expect(service.snapshot("one").questions).toMatchObject([{ requestId: 91, params: { questions: [
      { id: "q_0", question: "选择方案" }, { id: "q_1", question: "选择范围", multiSelect: true }
    ] } }]);
    emitMessage({ method: "session/update", params: { sessionId: "thread", update: { sessionUpdate: "session_end" } } });
    expect(service.snapshot("one").questions).toHaveLength(1);
    await expect(service.newThread("one")).rejects.toThrow("待确认请求");
    await service.answerQuestion("one", 91, { q_0: { answers: ["A"] }, q_1: { answers: ["前端", "后端"] } });
    expect(messages.find(message => message.method === "_codebuddy.ai/resolveInterruption").params).toEqual({
      sessionId: "thread", toolCallId: "call-1", decision: "allow", answers: { q_0: ["A"], q_1: ["前端", "后端"] }
    });
    expect(messages.find(message => message.id === 91).result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(service.snapshot("one").questions).toEqual([]);
    expect(service.snapshot("one").items.at(-1)).toMatchObject({ type: "questionAnswer", status: "submitted" });
    service.shutdown();
  });

  it("keeps permission-backed questions retryable and cancels them through CodeBuddy", async () => {
    const messages = [];
    let emitMessage;
    let fail = true;
    const child = fakeChild((message, emit) => {
      messages.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread" } });
      else if (message.method === "_codebuddy.ai/resolveInterruption") emit({ id: message.id,
        result: fail ? { resolved: false, queued: false } : { resolved: true, queued: false } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    emitMessage({ id: 92, method: "session/request_permission", params: { sessionId: "thread",
      toolCall: { toolCallId: "call-2", _meta: { "codebuddy.ai/toolName": "AskUserQuestion" },
        rawInput: { questions: [{ question: "继续吗？" }] } }, options: [{ kind: "allow_once", optionId: "allow" }] } });
    await expect(service.answerQuestion("one", 92, { q_0: { answers: ["继续"] } })).rejects.toThrow("已失效");
    expect(service.snapshot("one").questions).toMatchObject([{ requestId: 92, submitting: false }]);
    fail = false;
    await service.cancelQuestion("one", 92);
    expect(messages.find(message => message.method === "_codebuddy.ai/resolveInterruption" && message.params.decision === "deny")?.params)
      .toEqual({ sessionId: "thread", toolCallId: "call-2", decision: "deny" });
    expect(messages.find(message => message.id === 92)?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(service.snapshot("one").questions).toEqual([]);
    service.shutdown();
  });

  it("advertises and answers native questions, then cancels a later question", async () => {
    const messages = [];
    let emitMessage;
    const child = fakeChild((message, emit) => {
      messages.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(messages.find(message => message.method === "initialize").params.clientCapabilities._meta)
      .toEqual({ "codebuddy.ai": { question: true } });
    emitMessage({ jsonrpc: "2.0", id: 901, method: "_codebuddy.ai/question", params: { sessionId: "thread", toolCallId: "ask-1",
      schema: { questions: [
        { id: "q_0", header: "方案", question: "选择方案", options: [{ label: "A", description: "说明" }], multiSelect: false },
        { id: "q_1", header: "范围", question: "选择范围", options: [{ label: "前端" }, { label: "后端" }], multiSelect: true }
      ] } } });
    expect(service.snapshot("one").questions).toMatchObject([{ requestId: 901, params: { questions: [
      { id: "q_0", multiSelect: false }, { id: "q_1", multiSelect: true }
    ] } }]);
    await expect(service.answerQuestion("one", 901, { q_0: { answers: ["A", "B"] }, q_1: { answers: ["前端"] } }))
      .rejects.toThrow("问题答案无效");
    await service.answerQuestion("one", 901, { q_0: { answers: ["A"] }, q_1: { answers: ["前端", "后端"] } });
    expect(messages.find(message => message.id === 901).result).toEqual({ outcome: "submitted",
      answers: { q_0: ["A"], q_1: ["前端", "后端"] }
    });
    expect(service.snapshot("one").questions).toEqual([]);
    expect(service.snapshot("one").items.at(-1)).toMatchObject({ type: "questionAnswer", status: "submitted", questions: [
      { answers: ["A"] }, { answers: ["前端", "后端"] }
    ] });
    emitMessage({ jsonrpc: "2.0", id: 902, method: "_codebuddy.ai/question", params: { sessionId: "thread",
      schema: { questions: [{ id: "q_0", question: "继续吗？" }] } } });
    await service.cancelQuestion("one", 902);
    expect(messages.find(message => message.id === 902).result).toEqual({ outcome: "cancelled" });
    await expect(service.answerQuestion("one", 902, { q_0: { answers: ["是"] } })).rejects.toThrow("问题请求已失效");
    emitMessage({ jsonrpc: "2.0", id: 903, method: "_codebuddy.ai/question", params: { sessionId: "another-thread",
      schema: { questions: [{ id: "q_0", question: "无效会话" }] } } });
    expect(messages.find(message => message.id === 903).result).toEqual({ outcome: "cancelled" });
    service.shutdown();
  });

  it("keeps a CodeBuddy question available when its response cannot be sent", async () => {
    const events = new EventEmitter();
    let failAnswer = true;
    const sent = [];
    const service = createRawService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(),
      spawnProcess: () => fakeChild(() => {}),
      resolveHttpEndpoint: async () => ({ endpoint: new URL("http://127.0.0.1:12345"), password: "test" }),
      httpTransportFactory: () => ({ on: (name, listener) => events.on(name, listener), connect: async () => {}, close: () => {},
        send: async message => {
          if (message.id === 71 && failAnswer) { failAnswer = false; throw new Error("发送失败"); }
          sent.push(message);
          if (message.method === "initialize") events.emit("message", { id: message.id, result: { agentCapabilities: {} } });
          else if (message.method === "session/new") events.emit("message", { id: message.id, result: { sessionId: "thread" } });
        } }) });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    events.emit("message", { id: 71, method: "_codebuddy.ai/question", params: { sessionId: "thread",
      schema: { questions: [{ id: "q_0", question: "继续吗？" }] } } });
    const answers = { q_0: { answers: ["继续"] } };
    await expect(service.answerQuestion("one", 71, answers)).rejects.toThrow("发送失败");
    expect(service.snapshot("one").questions).toMatchObject([{ requestId: 71, submitting: false }]);
    await service.answerQuestion("one", 71, answers);
    expect(sent.find(message => message.id === 71).result).toEqual({ outcome: "submitted", answers: { q_0: ["继续"] } });
    expect(service.snapshot("one").questions).toEqual([]);
    service.shutdown();
  });

  it("switches CodeBuddy Plan through ACP without restricting tools or blocking approvals", async () => {
    const invocations = [];
    const messages = [];
    const children = [];
    const spawnProcess = vi.fn((executable, args) => {
      invocations.push({ executable, args });
      const child = fakeChild((message, emit) => {
        messages.push(message);
        if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
          result: { agentCapabilities: { loadSession: true } } });
        else if (message.method === "session/new" || message.method === "session/load") emit({ jsonrpc: "2.0", id: message.id,
          result: { sessionId: "thread-1", modes: { currentModeId: "acceptEdits", availableModes: [
            { id: "default" }, { id: "acceptEdits" }, { id: "plan" }] } } });
        else if (message.method === "session/set_mode") {
          emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1",
            update: { sessionUpdate: "current_mode_update", currentModeId: message.params.modeId } } });
          emit({ jsonrpc: "2.0", id: message.id, result: {} });
        } else if (message.method === "session/prompt") emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      });
      children.push(child);
      return child;
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), getSession: () => ({ id: "one", type: "windows", cwd: "C:\\work" }) },
      broadcast: vi.fn(), spawnProcess });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" }, { localBridge: true, acpArgs: "--acp --mcp-config '{}'" });
    expect(service.snapshot("one").nativeMode).toBe("acceptEdits");
    const planned = await service.setNativeMode("one", "plan");
    expect(planned).toMatchObject({ nativeMode: "plan", mode: "plan", executionPermission: "askApproval" });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].args.at(-1)).not.toContain("--tools Read,Glob,Grep");
    expect(messages.filter(message => message.method === "session/load")).toHaveLength(0);
    children[0].stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 900, method: "session/request_permission",
      params: { sessionId: "thread-1", toolCall: { title: "Edit source" }, options: [{ optionId: "yes", kind: "allow_once" }] } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("one").approvals).toHaveLength(1));
    service.resolveApproval("one", 900, true);
    expect(messages.find(message => message.id === 900).result).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    const normal = await service.setNativeMode("one", "default");
    expect(normal.nativeMode).toBe("default");
    expect(invocations).toHaveLength(1);
    await service.submit("one", "继续执行");
    service.shutdown();
  });

  it("keeps the previous mode when CodeBuddy rejects an ACP Plan switch", async () => {
    let started = 0;
    const spawnProcess = () => fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: "thread-1", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } } });
      else if (message.method === "session/set_mode") emit({ jsonrpc: "2.0", id: message.id,
        error: { code: -1, message: "mode rejected" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), getSession: () => ({ id: "one", type: "windows", cwd: "C:\\work" }) },
      broadcast: vi.fn(), spawnProcess: (...args) => { started++; return spawnProcess(...args); } });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await expect(service.setNativeMode("one", "plan")).rejects.toThrow("mode rejected");
    expect(started).toBe(1);
    expect(service.snapshot("one")).toMatchObject({ nativeMode: "default", threadId: "thread-1", busy: false });
    service.shutdown();
  });

  it("reflects native mode updates from CodeBuddy during a session", async () => {
    let child;
    child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new" || message.method === "session/load") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: "thread", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } } });
      else if (message.method === "session/set_mode") emit({ jsonrpc: "2.0", id: message.id, result: {} });
      else if (message.method === "session/prompt") emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    });
    const children = [];
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), getSession: () => ({ id: "one", type: "windows", cwd: "C:\\work" }) },
      broadcast: vi.fn(), spawnProcess: () => { const next = children.length ? fakeChild((message, emit) => {
        if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: { loadSession: true } } });
        else if (message.method === "session/load") emit({ jsonrpc: "2.0", id: message.id,
          result: { sessionId: "thread", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } } });
        else if (message.method === "session/set_mode") emit({ jsonrpc: "2.0", id: message.id, result: {} });
      }) : child; children.push(next); return next; } });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await service.setNativeMode("one", "plan");
    children[0].stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "thread", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("one").nativeMode).toBe("default"));
    await service.submit("one", "继续");
    service.shutdown();
  });
  it("receives slash commands before session/new completes and replaces them on updates and new threads", async () => {
    let emitUpdate;
    let threadNumber = 0;
    const child = fakeChild((message, emit) => {
      emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") {
        const sessionId = `thread-${++threadNumber}`;
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
          sessionUpdate: "available_commands_update", availableCommands: [
            { name: "review", description: "Review project" }, { name: "/deploy", description: "Deploy" }
          ] } } });
        emit({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
      }
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(service.snapshot("one").availableCommands).toEqual([
      { name: "review", description: "Review project" }, { name: "deploy", description: "Deploy" }
    ]);
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: {
      sessionUpdate: "available_commands_update", availableCommands: [{ name: "fix", description: "Fix issue" }]
    } } });
    expect(service.snapshot("one").availableCommands).toEqual([{ name: "fix", description: "Fix issue" }]);
    await service.newThread("one");
    expect(service.snapshot("one").threadId).toBe("thread-2");
    expect(service.snapshot("one").availableCommands).toEqual([
      { name: "review", description: "Review project" }, { name: "deploy", description: "Deploy" }
    ]);
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: {
      sessionUpdate: "available_commands_update", availableCommands: [{ name: "stale", description: "Old" }]
    } } });
    expect(service.snapshot("one").availableCommands.some(command => command.name === "stale")).toBe(false);
    service.shutdown();
  });

  it("starts in Windows and WSL using the native ACP command", () => {
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1)).toContain("codebuddy --acp");
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1)).toContain("--serve --acp-transport streamable-http --auth password");
    const wsl = buildInvocation({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, {}, {});
    expect(wsl.executable).toBe("wsl.exe");
    expect(wsl.args.at(-1)).toContain("exec codebuddy --acp");
    expect(wsl.args.at(-1)).toContain("--acp-transport streamable-http");
    const bridge = buildInvocation({ type: "ssh", cwd: "/srv/app", shell: "powershell.exe" },
      { localBridge: true, workspaceCwd: "C:\\bridge", acpArgs: "--acp --strict-mcp-config" }, {});
    expect(bridge.cwd).toBe("C:\\bridge");
    expect(bridge.args.at(-1)).toContain("--strict-mcp-config");
    expect(bridge.args.at(-1)).toContain("--acp-transport streamable-http");
    expect(wsl.args.at(-1)).not.toContain("--tools Read,Glob,Grep");
    const cmd = buildInvocation({ type: "windows", cwd: "C:\\work", shell: "cmd.exe" }, {}, {});
    expect(cmd.args.at(-1)).not.toContain("--tools Read,Glob,Grep");
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
    const readCatalog = vi.fn(async () => [{ id: "remote", creditMultiplier: "2x", promotions: [] }]);
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({ FLAG: "yes" }) },
      terminalManager: { broadcastAgentStatus: vi.fn(), setAppServerConnectionState: vi.fn() }, broadcast: vi.fn(),
      sshAgentTransport: { createStdioTransport, createHttpForwarder: vi.fn(async () => ({ agent: {}, close: vi.fn() })) },
      workBuddyModelCatalogService: { readCatalog } });
    await service.start({ id: "ssh-1", type: "ssh", cwd: "/srv/app", agentProvider: "codebuddy" });
    expect(service.snapshot("ssh-1").threadId).toBe("remote-thread");
    expect(await service.listModelMetadata("ssh-1")).toEqual([]);
    expect(readCatalog).not.toHaveBeenCalled();
    const command = createStdioTransport.mock.calls[0][1].command;
    expect(command).toContain("exec codebuddy --acp");
    expect(command).toContain("--serve --acp-transport streamable-http --auth password");
    expect(command).not.toContain("--tools Read,Glob,Grep");
    expect(command).toContain("/srv/app");
    expect(command).toContain("export FLAG=");
    service.shutdown();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
  });

  it("sends ACP image blocks between the surrounding text", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-acp-image-order-"));
    const first = path.join(directory, "first.png");
    const second = path.join(directory, "second.png");
    fs.writeFileSync(first, Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(second, Buffer.from([137, 80, 78, 71]));
    const received = [];
    const child = fakeChild((message, emit) => {
      received.push(message);
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: "thread-1", modes: { currentModeId: "default", availableModes: [{ id: "default" }] } } });
      else if (message.method === "session/prompt") emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), getSession: () => ({ id: "one", type: "windows", cwd: directory }) },
      broadcast: vi.fn(), spawnProcess: () => child });
    try {
      await service.start({ id: "one", type: "windows", cwd: directory, shell: "powershell.exe" });
      service.allowFiles("one", [first, second]);
      await service.submit("one", "甲乙丙", [first, second], [], [
        { type: "text", text: "甲" }, { type: "image", path: first }, { type: "text", text: "乙" },
        { type: "image", path: second }, { type: "text", text: "丙" }]);
      expect(received.find(message => message.method === "session/prompt").params.prompt.map(part => part.type)).toEqual([
        "text", "image", "text", "image", "text"]);
      expect(service.snapshot("one").items.find(item => item.type === "userMessage").parts.map(part => part.type)).toEqual([
        "text", "image", "text", "image", "text"]);
    } finally { service.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
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

  it("sends a unique client turn ID and groups semantic updates by the returned ID", async () => {
    const prompts = [];
    let emitUpdate;
    const child = fakeChild((message, emit) => {
      emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread" } });
      else if (message.method === "session/prompt") {
        prompts.push(message);
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread", update: {
          sessionUpdate: "agent_message_chunk", messageId: `reply-${prompts.length}`,
          content: { type: "text", text: `Reply ${prompts.length}` },
          _meta: { "codebuddy.ai/conversationRequestId": message.params._meta["codebuddy.ai/conversationRequestId"] }
        } } });
        emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child,
      workBuddyModelCatalogService: { readCatalog: async () => [{ id: "hy3", creditMultiplier: "0x", promotions: [{ id: "night", priority: 1, badge: { label: "夜间折扣" }, schedule: {} }] }] } });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(await service.listModelMetadata("one")).toEqual([{ id: "hy3", creditMultiplier: "0x", promotions: [{ id: "night", label: "夜间折扣" }] }]);
    await service.submit("one", "First");
    await service.submit("one", "Second");
    const [firstId, secondId] = prompts.map(message => message.params._meta["codebuddy.ai/conversationRequestId"]);
    expect(firstId).toMatch(/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    expect(secondId).toMatch(/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    expect(secondId).not.toBe(firstId);
    const items = service.snapshot("one").items;
    expect(items.filter(item => item.turnId === firstId).map(item => item.text)).toEqual(["First", "Reply 1"]);
    expect(items.filter(item => item.turnId === secondId).map(item => item.text)).toEqual(["Second", "Reply 2"]);
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread", update: {
      sessionUpdate: "agent_message_chunk", messageId: "late-first", content: { type: "text", text: "Late first" },
      _meta: { "codebuddy.ai/conversationRequestId": firstId }
    } } });
    expect(service.snapshot("one").items.at(-1)).toMatchObject({ turnId: firstId, text: "Late first" });
    service.shutdown();
  });

  it("preserves ACP tool kind, locations, status, and returned content", async () => {
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-1" } });
      else if (message.method === "session/prompt") {
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: {
          sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Search project", kind: "search", status: "in_progress" } } });
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: {
          sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [
            { type: "content", content: { type: "text", text: "Found 3 results" } }], locations: [{ path: "src/App.tsx" }] } } });
        emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    await service.submit("one", "Find App.tsx");
    expect(service.snapshot("one").items.find(item => item.id === "tool-1")).toMatchObject({
      type: "toolCall", toolKind: "search", toolName: "Search project", status: "completed",
      output: "Found 3 results", locations: [{ path: "src/App.tsx" }]
    });
    service.shutdown();
  });

  it("switches only advertised CodeBuddy ACP models and refreshes them for a new thread", async () => {
    const requests = [];
    const models = [{ value: "hy3", name: "HY3" }, { value: "glm-5.3", name: "GLM 5.3" }];
    let promptReply;
    let newCount = 0;
    const child = fakeChild((message, emit) => {
      requests.push(message);
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") {
        newCount += 1;
        emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: `thread-${newCount}`,
          ...(newCount < 3 ? { configOptions: [{
          id: "model", type: "select", currentValue: newCount === 1 ? "hy3" : "glm-5.3", options: models
        }] } : {}) } });
      } else if (message.method === "session/set_config_option") {
        emit({ jsonrpc: "2.0", id: message.id, result: { configOptions: [{
          id: "model", type: "select", currentValue: message.params.value, options: models
        }] } });
      } else if (message.method === "session/prompt") promptReply = () => emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    expect(service.snapshot("one").acpOptions.find(option => option.id === "model").currentValue).toBe("hy3");
    await expect(service.setModel("one", "unlisted")).rejects.toThrow("CodeBuddy");
    await expect(service.setEffort("one", "high")).rejects.toThrow("无法切换配置");
    expect(requests.filter(message => message.method === "session/set_config_option")).toHaveLength(0);
    const switched = await service.setModel("one", "glm-5.3");
    expect(switched.acpOptions.find(option => option.id === "model").currentValue).toBe("glm-5.3");
    expect(requests.find(message => message.method === "session/set_config_option").params)
      .toEqual({ sessionId: "thread-1", configId: "model", value: "glm-5.3" });
    const turn = service.submit("one", "Hello");
    await vi.waitFor(() => expect(promptReply).toBeTypeOf("function"));
    await expect(service.setModel("one", "hy3")).rejects.toThrow("无法切换配置");
    promptReply();
    await turn;
    const next = await service.newThread("one");
    expect(next.threadId).toBe("thread-2");
    expect(next.acpOptions.find(option => option.id === "model").currentValue).toBe("glm-5.3");
    expect((await service.newThread("one")).acpOptions).toEqual([]);
    service.shutdown();
  });

  it("keeps the selected CodeBuddy model when ACP rejects a switch", async () => {
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread",
        configOptions: [{ id: "model", type: "select", currentValue: "hy3", options: [{ value: "hy3" }, { value: "glm-5.3" }] }] } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id,
        error: { code: -32603, message: "Model unavailable" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    await expect(service.setModel("one", "glm-5.3")).rejects.toThrow("Model unavailable");
    expect(service.snapshot("one").acpOptions.find(option => option.id === "model").currentValue).toBe("hy3");
    service.shutdown();
  });

  it("restores a saved Plan choice through the native ACP mode", async () => {
    const invocations = [];
    const session = { id: "one", templateId: "saved", type: "windows", cwd: "C:\\work",
      codeBuddyGraphicalOptions: { mode: "plan" } };
    const spawnProcess = vi.fn((_executable, args) => {
      invocations.push(args.at(-1));
      return fakeChild((message, emit) => {
        if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
          result: { agentCapabilities: { loadSession: true } } });
        else if (message.method === "session/new" || message.method === "session/load") emit({ jsonrpc: "2.0", id: message.id,
          result: { sessionId: "thread", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } } });
        else if (message.method === "session/set_mode") emit({ jsonrpc: "2.0", id: message.id, result: {} });
      });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), getSession: () => session },
      sessionStore: { getTemplate: () => ({ codeBuddyGraphicalOptions: { mode: "plan" } }) },
      broadcast: vi.fn(), spawnProcess });

    await service.start(session);

    expect(service.snapshot("one")).toMatchObject({ nativeMode: "plan", mode: "plan" });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).not.toContain("--tools Read,Glob,Grep");
    service.shutdown();
  });

  it("keeps CodeBuddy prompt errors in their turns without duplicating them", async () => {
    const detail = "429 您的使用量已超出频率限制，将在 2026-09-26 02:50:40 UTC+8 重置。\n(01a0d92020e4737f80c66dbc27673af9)";
    let promptCount = 0;
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread" } });
      else if (message.method === "session/prompt") {
        promptCount++;
        if (promptCount === 1) {
          const response = { jsonrpc: "2.0", id: message.id, result: { stopReason: "refusal", errorMessage: detail } };
          emit(response); emit(response);
        } else if (promptCount === 2) emit({ jsonrpc: "2.0", id: message.id,
          error: { code: -32000, message: "Prompt failed", data: { details: "upstream 503" } } });
        else if (promptCount === 3) emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "error" } });
        else emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: promptCount === 4 ? "cancelled" : "end_turn" } });
      }
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await service.submit("one", "First");
    await expect(service.submit("one", "Second")).rejects.toThrow("upstream 503");
    await service.submit("one", "Third");
    await service.submit("one", "Cancel");
    await service.submit("one", "Continue");
    const items = service.snapshot("one").items;
    const users = items.filter(item => item.type === "userMessage");
    expect(items.filter(item => item.type === "turnError")).toMatchObject([
      { turnId: users[0].turnId, text: detail },
      { turnId: users[1].turnId, text: "upstream 503" },
      { turnId: users[2].turnId, text: "CodeBuddy 本轮未完成（error）。" }
    ]);
    expect(items.filter(item => item.type === "turnError")).toHaveLength(3);
    expect(service.snapshot("one").error).toBeNull();
    service.shutdown();
  });

  it("shows sanitized CodeBuddy stderr on startup failure and later process exit", async () => {
    const startupChild = fakeChild(() => {});
    const startup = createRawService({ environmentService: { resolve: () => ({ ACCESS_TOKEN: "env-secret" }) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => startupChild,
      resolveHttpEndpoint: async child => {
        child.stderr.write("Password  acp-password\n启动失败：env-secret\n");
        throw new Error("等待 CodeBuddy HTTP ACP 地址超时。");
      } });
    await expect(startup.start({ id: "one", type: "windows", cwd: "C:\\work" })).rejects
      .toThrow(/等待 CodeBuddy HTTP ACP 地址超时。.*启动失败：\[已隐藏\]/);
    expect(startup.snapshot.bind(startup, "one")).toThrow();

    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({ ACCESS_TOKEN: "env-secret" }) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    child.stderr.write("Password  acp-password\n上游失败：env-secret\nAuthorization: Bearer leaked-token\n");
    child.emit("exit", 1);
    const error = service.snapshot("one").error;
    expect(error).toContain("ACP 已退出（代码 1）");
    expect(error).toContain("上游失败：[已隐藏]");
    expect(error).not.toContain("acp-password");
    expect(error).not.toContain("env-secret");
    expect(error).not.toContain("leaked-token");
    service.shutdown();
  });

  it("saves graphical choices to the original template and restores them for new and restarted threads", async () => {
    const requests = [];
    const template = { id: "saved", agentProvider: "codex" };
    const session = { id: "one", templateId: "saved", type: "windows", cwd: "C:\\work", shell: "powershell.exe", agentProvider: "codebuddy" };
    const sessionStore = { getTemplate: () => template, updateLibrary: vi.fn((_id, updates) => Object.assign(template, updates)) };
    let nextThread = 0;
    let rejectMode = false;
    const options = () => [
      { id: "model", type: "select", currentValue: "hy3", options: [{ value: "hy3" }, { value: "glm-5.3" }] },
      { id: "context_window", type: "select", currentValue: "200000", options: [{ value: "200000" }, { value: "1000000" }] },
      { id: "multitask", type: "boolean", currentValue: false }
    ];
    let currentOptions = options();
    const spawnProcess = () => fakeChild((message, emit) => {
      requests.push(message);
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true, multitaskSupport: true } } });
      else if (message.method === "session/new" || message.method === "session/load") {
        currentOptions = options();
        emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId || `thread-${++nextThread}`,
          modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "bypassPermissions" }] },
          configOptions: currentOptions } });
      }
      else if (message.method === "session/set_mode") emit({ jsonrpc: "2.0", id: message.id,
        ...(rejectMode ? { error: { code: -1, message: "Mode unavailable" } } : { result: {} }) });
      else if (message.method === "session/set_config_option") {
        currentOptions = currentOptions.map(option => option.id === message.params.configId
          ? { ...option, currentValue: message.params.value } : option);
        emit({ jsonrpc: "2.0", id: message.id, result: { configOptions: currentOptions } });
      }
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn(), getSession: () => session, listSessions: () => [session] },
      sessionStore, broadcast: vi.fn(), spawnProcess });
    await service.start(session);
    await service.setNativeMode("one", "bypassPermissions");
    await service.setModel("one", "glm-5.3");
    await service.setContextWindow("one", "1000000");
    await service.setMultitask("one", true);
    const expected = { mode: "bypassPermissions", model: "glm-5.3", contextWindow: "1000000", multitask: true };
    expect(template).toMatchObject({ agentProvider: "codex", codeBuddyGraphicalOptions: expected });
    expect(session.codeBuddyGraphicalOptions).toEqual(expected);

    const next = await service.newThread("one");
    expect(next).toMatchObject({ nativeMode: "bypassPermissions" });
    expect(next.acpOptions.map(option => option.currentValue)).toEqual(["glm-5.3", "1000000", true]);
    await service.restart("one");
    expect(service.snapshot("one")).toMatchObject({ nativeMode: "bypassPermissions" });
    expect(service.snapshot("one").acpOptions.map(option => option.currentValue)).toEqual(["glm-5.3", "1000000", true]);
    expect(requests.filter(message => message.method === "session/set_mode")).toHaveLength(3);

    template.codeBuddyGraphicalOptions = { mode: "removed", model: "removed", contextWindow: "removed", multitask: true };
    await service.restart("one");
    expect(service.snapshot("one")).toMatchObject({ nativeMode: "default" });
    expect(service.snapshot("one").acpOptions.map(option => option.currentValue)).toEqual(["hy3", "200000", true]);

    template.codeBuddyGraphicalOptions = { mode: "bypassPermissions" };
    rejectMode = true;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await service.restart("one");
    expect(service.snapshot("one").nativeMode).toBe("default");
    expect(errorLog).toHaveBeenCalledWith("Failed to restore CodeBuddy mode:", expect.any(Error));
    errorLog.mockRestore();
    service.shutdown();
  });

  it("switches advertised context tiers and isolates ACP context usage by thread", async () => {
    const requests = [];
    let emitUpdate;
    let thread = 0;
    const tiers = [{ value: "200000", name: "200K" }, { value: "1000000", name: "1M" }];
    const child = fakeChild((message, emit) => {
      requests.push(message); emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: `thread-${++thread}`, configOptions: [{ id: "context_window", type: "select", currentValue: "200000", options: tiers }]
      } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id, result: { configOptions: [
        { id: "context_window", type: "select", currentValue: message.params.value, options: tiers }
      ] } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    const usage = (sessionId, used, size) => emitUpdate({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId, update: { sessionUpdate: "usage_update", used, size,
        _meta: { "codebuddy.ai/usageByCategory": { systemPrompt: 100, tools: 25, conversation: 200 } } }
    } });
    usage("other-thread", 999, 1000);
    expect(service.snapshot("one").contextUsage).toBeNull();
    usage("thread-1", 325, 200000);
    expect(service.snapshot("one").contextUsage).toMatchObject({ used: 325, size: 200000,
      categories: { systemPrompt: 100, tools: 25, conversation: 200 } });
    usage("thread-1", -1, 0);
    expect(service.snapshot("one").contextUsage.used).toBe(325);
    await expect(service.setContextWindow("one", "unlisted")).rejects.toThrow("不支持");
    expect(requests.filter(value => value.method === "session/set_config_option")).toHaveLength(0);
    const changed = await service.setContextWindow("one", "1000000");
    expect(requests.at(-1).params).toEqual({ sessionId: "thread-1", configId: "context_window", value: "1000000" });
    expect(changed.acpOptions[0].currentValue).toBe("1000000");
    expect(changed.contextUsage).toBeNull();
    usage("thread-1", 325, 1000000);
    expect(service.snapshot("one").contextUsage.size).toBe(1000000);
    expect((await service.newThread("one")).contextUsage).toBeNull();
    usage("thread-1", 500, 1000000);
    expect(service.snapshot("one").contextUsage).toBeNull();
    service.shutdown();
  });

  it("advertises boolean config support and writes only an advertised Multitask option", async () => {
    const requests = [];
    let emitUpdate;
    const child = fakeChild((message, emit) => {
      requests.push(message);
      emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { multitaskSupport: true } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
        result: { sessionId: "thread", configOptions: [{ id: "multitask", type: "boolean", currentValue: false }] } });
      else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id,
        result: { configOptions: [{ id: "multitask", type: "boolean", currentValue: message.params.value }] } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(requests[0].params.clientCapabilities.session.configOptions.boolean).toEqual({});
    expect(service.snapshot("one").capabilities.multitask).toBe(true);
    await expect(service.setMultitask("one", "true")).rejects.toThrow("不支持");
    expect((await service.setMultitask("one", true)).acpOptions[0].currentValue).toBe(true);
    expect(requests.at(-1).params).toEqual({ sessionId: "thread", configId: "multitask", type: "boolean", value: true });
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread",
      update: { sessionUpdate: "config_option_update", configOptions: [{ id: "multitask", type: "boolean", currentValue: false }] } } });
    expect(service.snapshot("one").acpOptions[0].currentValue).toBe(false);
    service.shutdown();
  });

  it("hides Multitask without capability or option and preserves state on a detailed rejection", async () => {
    for (const [support, options] of [[false, [{ id: "multitask", type: "boolean", currentValue: false }]], [true, []],
      [true, [{ id: "multitask", type: "boolean", currentValue: false }]]]) {
      const child = fakeChild((message, emit) => {
        if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
          result: { agentCapabilities: { multitaskSupport: support } } });
        else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id,
          result: { sessionId: "thread", configOptions: options } });
        else if (message.method === "session/set_config_option") emit({ jsonrpc: "2.0", id: message.id,
          error: { code: -32602, message: "Invalid params", data: { details: "后台任务已禁用" } } });
      });
      const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
        terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
      await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
      await expect(service.setMultitask("one", true)).rejects.toThrow(support && options.length ? "后台任务已禁用" : "不支持");
      expect(service.snapshot("one").acpOptions[0]?.currentValue).toBe(options[0]?.currentValue);
      service.shutdown();
    }
  });

  it("keeps worker questions after the parent turn and receives an unsolicited summary turn", async () => {
    let emitUpdate;
    const child = fakeChild((message, emit) => {
      emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread" } });
      else if (message.method === "session/prompt") emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await service.submit("one", "开始");
    emitUpdate({ jsonrpc: "2.0", id: 500, method: "session/request_permission", params: { sessionId: "thread",
      toolCall: { toolCallId: "question-1", title: "子任务提问" }, options: [{ optionId: "yes", kind: "allow_once" }] } });
    expect(service.snapshot("one").approvals).toHaveLength(1);
    expect(service.snapshot("one").busy).toBe(false);
    const meta = { "codebuddy.ai/requestId": "drain-1" };
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread", update: {
      sessionUpdate: "session_info_update", _meta: { ...meta, "codebuddy.ai/unsolicitedTurn": { requestId: "drain-1", reason: "background_drain" } } } } });
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "后台结果" }, _meta: meta } } });
    expect(service.snapshot("one").items.at(-1)).toMatchObject({ type: "agentMessage", turnId: "drain-1", text: "后台结果" });
    expect(service.snapshot("one").items.find(item => item.type === "backgroundTurn")).toBeTruthy();
    emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread", update: {
      sessionUpdate: "session_end", _meta: meta } } });
    expect(service.snapshot("one").busy).toBe(false);
    expect(service.snapshot("one").approvals).toHaveLength(1);
    service.resolveApproval("one", 500, true);
    expect(service.snapshot("one").approvals).toHaveLength(0);
    service.shutdown();
  });

  it("routes graphical calls by session provider", () => {
    const codex = { snapshot: vi.fn(() => "codex"), close: vi.fn(), shutdown: vi.fn() };
    const buddy = { snapshot: vi.fn(() => "buddy"), setMultitask: vi.fn(() => "enabled"),
      sendTeamMessage: vi.fn(() => "sent"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy, { getSession: id => ({ agentProvider: id === "buddy" ? "codebuddy" : "codex" }) });
    expect(router.snapshot("buddy")).toBe("buddy");
    expect(router.snapshot("codex")).toBe("codex");
    expect(router.setMultitask("buddy", true)).toBe("enabled");
    expect(buddy.setMultitask).toHaveBeenCalledWith("buddy", true);
    expect(() => router.setMultitask("codex", true)).toThrow("只有 CodeBuddy");
    expect(router.sendTeamMessage("buddy", "team", "member", "hello")).toBe("sent");
    expect(buddy.sendTeamMessage).toHaveBeenCalledWith("buddy", "team", "member", "hello");
    expect(() => router.sendTeamMessage("codex", "team", "member", "hello")).toThrow("只有 CodeBuddy");
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
          sessionUpdate: "available_commands_update", availableCommands: [{ name: "summarize", description: "Summarize history" }]
        } } });
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
    expect(restored.availableCommands).toEqual([{ name: "summarize", description: "Summarize history" }]);
    expect(restored.items.map(item => item.text)).toEqual(["Old prompt", "Old answer"]);
    service.shutdown();
  });

  it("keeps manual and automatic team members in separate timelines and restores the latest team state", async () => {
    let emitUpdate;
    const child = fakeChild((message, emit) => {
      emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "current" } });
      else if (message.method === "session/list") emit({ jsonrpc: "2.0", id: message.id, result: { sessions: [{ sessionId: "saved", cwd: "C:\\work" }] } });
      else if (message.method === "session/load") {
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "saved", update: {
          sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "成员历史" },
          _meta: { "codebuddy.ai/memberEvent": "architect" } } } });
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "saved", update: {
          sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/teamUpdate": {
            type: "member_status_change", teamName: "team-saved", isAutoTeam: true, hasLiveMembers: true,
            members: [{ name: "architect", status: "running", description: "架构设计", toolCallCount: 2 }] } } } } });
        emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "saved" } });
      }
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    const push = (sessionId, update) => emitUpdate({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    push("current", { sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/teamUpdate": {
      type: "member_status_change", teamName: "team-current", isAutoTeam: false,
      members: [{ name: "architect", status: "idle" }, { name: "reviewer", status: "completed" }] } } });
    push("current", { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "主消息" } });
    push("current", { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "成员消息" },
      _meta: { "codebuddy.ai/memberEvent": "architect" } });
    push("current", { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "读取文件", status: "in_progress",
      _meta: { "codebuddy.ai/memberEvent": "architect" } });
    push("current", { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed",
      _meta: { "codebuddy.ai/memberEvent": "architect" } });
    expect(service.snapshot("one").items.map(item => item.text)).toEqual(["主消息"]);
    expect(service.snapshot("one").team.members[0].items).toMatchObject([
      { text: "成员消息" }, { id: "tool-1", status: "completed" }
    ]);
    await service.listHistory("one");
    const restored = await service.resume("one", "saved");
    expect(restored.items).toEqual([]);
    expect(restored.team).toMatchObject({ name: "team-saved", isAutoTeam: true, hasLiveMembers: true,
      members: [{ name: "architect", status: "running", description: "架构设计", items: [{ text: "成员历史" }] }] });
    push("current", { sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/teamUpdate": { type: "team_deleted", teamName: "team-saved" } } });
    expect(service.snapshot("one").team?.name).toBe("team-saved");
    push("saved", { sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/teamUpdate": { type: "team_deleted", teamName: "team-saved" } } });
    expect(service.snapshot("one").team).toBeNull();
    service.shutdown();
  });

  it("validates a team recipient and sends through the authenticated HTTP transport", async () => {
    const sent = vi.fn().mockResolvedValue(undefined);
    let child;
    child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child,
      httpTransportFactory: () => {
        const events = new EventEmitter();
        readline.createInterface({ input: child.stdout }).on("line", line => events.emit("message", JSON.parse(line)));
        return { on: (name, listener) => events.on(name, listener), connect: async () => {},
          send: async message => child.stdin.write(`${JSON.stringify(message)}\n`), sendTeamMessage: sent, close: () => {} };
      } });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread", update: {
      sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/teamUpdate": { type: "member_status_change",
        teamName: "my-team", members: [{ name: "architect", status: "completed" }] } } } } })}\n`);
    await expect(service.sendTeamMessage("one", "wrong", "architect", "hello")).rejects.toThrow("失效");
    await service.sendTeamMessage("one", "my-team", "architect", "  继续工作  ");
    expect(sent).toHaveBeenCalledWith({ teamName: "my-team", recipient: "architect",
      message: expect.objectContaining({ from: "user", text: "继续工作", summary: "继续工作" }) });
    service.shutdown();
  });
});
