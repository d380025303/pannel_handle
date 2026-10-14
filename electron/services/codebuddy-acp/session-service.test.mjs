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
  it.each(["windows", "ssh"])("checks %s image size before reading and retains the post-read limit", async type => {
    const limit = 10 * 1024 * 1024;
    const file = type === "ssh" ? "/srv/app/image.png" : "C:\\work\\image.png";
    const prompts = [];
    const respond = (message, emit) => {
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread" } });
      else if (message.method === "session/prompt") {
        prompts.push(message.params.prompt);
        emit({ id: message.id, result: { stopReason: "end_turn" } });
      }
    };
    const child = fakeChild(respond);
    const transport = new EventEmitter();
    transport.write = chunk => respond(JSON.parse(String(chunk)), value =>
      transport.emit("stdout", Buffer.from(`${JSON.stringify(value)}\n`)));
    transport.close = vi.fn();
    const stat = vi.fn();
    const read = vi.fn();
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child,
      sshAgentTransport: { createStdioTransport: async () => transport,
        createHttpForwarder: async () => ({ host: "127.0.0.1", port: 12345, close: vi.fn() }) }, sshFileSystem: { stat, get: read } });
    let statSpy; let readSpy;
    try {
      await service.start({ id: "one", type, cwd: type === "ssh" ? "/srv/app" : "C:\\work" });
      if (type === "windows") {
        statSpy = vi.spyOn(fs.promises, "stat").mockImplementation(stat);
        readSpy = vi.spyOn(fs.promises, "readFile").mockImplementation(read);
      }
      service.allowFiles("one", [file]);
      stat.mockResolvedValue({ size: 64 * 1024 * 1024 });
      await expect(service.submit("one", "image", [file])).rejects.toThrow("图片超过 10 MB。");
      expect(stat).toHaveBeenCalledWith(...(type === "ssh" ? ["one", file] : [file]));
      expect(read).not.toHaveBeenCalled();
      expect(prompts).toEqual([]);
      expect(service.snapshot("one").busy).toBe(false);

      for (const size of [4, limit]) {
        const data = Buffer.alloc(size, 1);
        stat.mockResolvedValue({ size });
        read.mockResolvedValue(data);
        service.allowFiles("one", [file]);
        await service.submit("one", "image", [file]);
        expect(prompts.at(-1)).toContainEqual({ type: "image", mimeType: "image/png", data: data.toString("base64") });
      }
      expect(read).toHaveBeenCalledTimes(2);
      stat.mockResolvedValue({ size: limit });
      read.mockResolvedValue(Buffer.alloc(limit + 1));
      service.allowFiles("one", [file]);
      await expect(service.submit("one", "image", [file])).rejects.toThrow("图片超过 10 MB。");
      expect(prompts).toHaveLength(2);
    } finally {
      statSpy?.mockRestore(); readSpy?.mockRestore();
      await service.close("one");
    }
  });

  it("confirms prompt submission before completion and retains later execution failures", async () => {
    let finishPrompt;
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread" } });
      else if (message.method === "session/prompt") finishPrompt = () => emit({ id: message.id, error: { message: "later failure" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    try {
      await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
      await expect(service.submitStarted("one", " ")).rejects.toThrow("请输入");
      await service.submitStarted("one", "long task");
      expect(service.snapshot("one").busy).toBe(true);
      expect(service.snapshot("one").items.some(item => item.type === "userMessage" && item.text === "long task")).toBe(true);
      finishPrompt();
      await vi.waitFor(() => expect(service.snapshot("one").busy).toBe(false));
      expect(service.snapshot("one").items.some(item => item.type === "turnError" && item.text.includes("later failure"))).toBe(true);
    } finally { await service.close("one"); }
  });
  it("previews unsent pasted images and revokes access when they are discarded", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-acp-image-preview-"));
    const imagePath = path.join(directory, "capture.png");
    const buffer = Buffer.from([137, 80, 78, 71]);
    fs.writeFileSync(imagePath, buffer);
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread-1" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    try {
      await service.start({ id: "one", type: "windows", cwd: directory });
      await expect(service.previewAttachment("one", imagePath)).rejects.toThrow("只能预览当前会话的附件");
      service.allowPastedImage("one", imagePath);
      expect(await service.previewAttachment("one", imagePath)).toEqual({
        kind: "image", dataUrl: `data:image/png;base64,${buffer.toString("base64")}` });
      expect(service.snapshot("one").items).toEqual([]);
      await service.discardPastedImage("one", imagePath);
      await expect(service.previewAttachment("one", imagePath)).rejects.toThrow("只能预览当前会话的附件");
    } finally { service.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps an ACP turn running while its independent side question completes and cancels the worker on close", async () => {
    let prompt; let emitResponse;
    const sent = [];
    const mainChild = fakeChild((message, emit) => {
      sent.push(message); emitResponse = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "main-thread", configOptions: [
        { id: "model", type: "select", currentValue: "selected-model", options: [{ value: "selected-model", name: "Model" }] }] } });
      else if (message.method === "session/prompt") prompt = message;
    });
    const workers = [];
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => {
        if (!workers.length) { workers.push(mainChild); return mainChild; }
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
        workers.push(child); return child;
      } });
    await service.start({ id: "one", type: "windows", cwd: process.cwd() });
    const turn = service.submit("one", "Continue the main task");
    await vi.waitFor(() => expect(prompt).toBeTruthy());
    service.askSideQuestion("one", "How is it going?");
    workers[1].stdout.end(JSON.stringify([{ type: "result", result: "Still running" }]));
    workers[1].emit("close", 0);
    expect(service.snapshot("one")).toMatchObject({ busy: true, sideQuestion: { status: "completed", answer: "Still running" } });
    expect(service.snapshot("one").items.filter(item => item.type === "userMessage").map(item => item.text)).toEqual(["Continue the main task"]);
    expect(sent.filter(message => message.method === "session/prompt")).toHaveLength(1);
    expect(sent.some(message => message.method === "session/cancel")).toBe(false);
    emitResponse({ id: prompt.id, result: { stopReason: "end_turn" } });
    await turn;
    expect(service.snapshot("one").busy).toBe(false);
    service.askSideQuestion("one", "Another question");
    await service.close("one");
    expect(workers[2].kill).toHaveBeenCalled();
    workers[2].emit("close", 0);
    service.shutdown();
  });

  it("uses public goal prompts and keeps goal events within the current session", async () => {
    const sent = [];
    let emitMessage;
    const child = fakeChild((message, emit) => {
      sent.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "goal-thread" } });
      else if (message.method === "session/prompt") emit({ id: message.id, result: { stopReason: "end_turn" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(sent.find(message => message.method === "initialize").params.clientCapabilities._meta["codebuddy.ai"].goalSnapshotReplay).toBe(true);
    service.setGoal("one", { objective: "  测试通过  ", status: "active" });
    await vi.waitFor(() => expect(sent.some(message => message.method === "session/prompt"
      && message.params.prompt[0].text === "/goal 测试通过")).toBe(true));
    emitMessage({ method: "session/update", params: { sessionId: "other-thread", update: {
      sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/goalRecap": { active: { condition: "别的目标" } } } } } });
    expect(service.snapshot("one").codeBuddyGoal.active).toBeNull();
    emitMessage({ method: "session/update", params: { sessionId: "goal-thread", update: {
      sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/goalRecap": { active: {
        condition: "测试通过", durationMs: 5000, turnCount: 2, tokenDelta: 125 } } } } } });
    await vi.waitFor(() => expect(service.snapshot("one").codeBuddyGoal.active).toMatchObject({
      condition: "测试通过", turnCount: 2, tokenDelta: 125 }));
    service.refreshGoal("one");
    await vi.waitFor(() => expect(sent.some(message => message.method === "session/prompt"
      && message.params.prompt[0].text === "/goal")).toBe(true));
    await service.clearGoal("one");
    await vi.waitFor(() => expect(sent.some(message => message.method === "session/prompt"
      && message.params.prompt[0].text === "/goal clear")).toBe(true));
    await expect(() => service.setGoal("one", { objective: "", status: "active" })).toThrow("目标内容");
    service.shutdown();
  });

  it("cancels an active goal turn before sending the public clear command", async () => {
    const sent = [];
    let emitMessage;
    let runningPrompt;
    const child = fakeChild((message, emit) => {
      sent.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "goal-thread" } });
      else if (message.method === "session/prompt" && message.params.prompt[0].text === "/goal work") runningPrompt = message;
      else if (message.method === "session/prompt") emit({ id: message.id, result: { stopReason: "end_turn" } });
      else if (message.method === "session/cancel" && runningPrompt)
        emit({ id: runningPrompt.id, result: { stopReason: "cancelled" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    service.setGoal("one", { objective: "work", status: "active" });
    await vi.waitFor(() => expect(service.snapshot("one").busy).toBe(true));
    emitMessage({ method: "session/update", params: { sessionId: "goal-thread", update: {
      sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/goalRecap": { active: { condition: "work" } } } } } });
    await service.clearGoal("one");
    expect(sent.findIndex(message => message.method === "session/cancel")).toBeLessThan(
      sent.findIndex(message => message.method === "session/prompt" && message.params.prompt[0].text === "/goal clear"));
    service.shutdown();
  });

  it("cancels an active goal turn before replacing its condition", async () => {
    const sent = [];
    let emitMessage;
    let runningPrompt;
    const child = fakeChild((message, emit) => {
      sent.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "goal-thread" } });
      else if (message.method === "session/prompt" && message.params.prompt[0].text === "/goal work") runningPrompt = message;
      else if (message.method === "session/prompt") emit({ id: message.id, result: { stopReason: "end_turn" } });
      else if (message.method === "session/cancel" && runningPrompt)
        emit({ id: runningPrompt.id, result: { stopReason: "cancelled" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    service.setGoal("one", { objective: "work", status: "active" });
    await vi.waitFor(() => expect(service.snapshot("one").busy).toBe(true));
    emitMessage({ method: "session/update", params: { sessionId: "goal-thread", update: {
      sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/goalRecap": { active: { condition: "work" } } } } } });
    await service.setGoal("one", { objective: "new work", status: "active" });
    expect(sent.findIndex(message => message.method === "session/cancel")).toBeLessThan(
      sent.findIndex(message => message.method === "session/prompt" && message.params.prompt[0].text === "/goal new work"));
    service.shutdown();
  });

  it("clears only the new conversation's completed status after a successful switch", async () => {
    const statuses = [];
    let childCount = 0;
    const spawnProcess = () => {
      const id = ++childCount === 1 ? "one" : "two";
      let threadCount = 0;
      return fakeChild((message, emit) => {
        if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
        else if (message.method === "session/new") {
          threadCount += 1;
          emit({ id: message.id, ...(id === "one" && threadCount === 3
            ? { error: { code: -1, message: "Could not create thread" } }
            : { result: { sessionId: `${id}-thread-${threadCount}` } }) });
        } else if (message.method === "session/prompt") emit({ id: message.id, result: { stopReason: "end_turn" } });
      });
    };
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: vi.fn(), spawnProcess });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await service.start({ id: "two", type: "windows", cwd: "C:\\work" });
    await service.submit("one", "First task");
    await service.submit("two", "Other task");
    expect(statuses.filter(value => value.id === "one").at(-1).status).toBe("completed");
    const otherStatus = statuses.filter(value => value.id === "two").at(-1);

    const next = await service.newThread("one");
    expect(next).toMatchObject({ threadId: "one-thread-2", items: [] });
    expect(statuses.at(-1)).toMatchObject({ id: "one", provider: "codebuddy", status: "cleared",
      activitySummary: undefined });
    expect(statuses.filter(value => value.id === "two").at(-1)).toBe(otherStatus);

    await service.submit("one", "Second task");
    await expect(service.newThread("one")).rejects.toThrow("Could not create thread");
    expect(service.snapshot("one").threadId).toBe("one-thread-2");
    expect(statuses.filter(value => value.id === "one").at(-1).status).toBe("completed");
    expect(statuses.filter(value => value.id === "one" && value.status === "cleared")).toHaveLength(1);
    service.shutdown();
  });

  it("reviews the ExitPlanMode payload and answers its ACP request before switching to Full Access", async () => {
    const messages = [];
    let emitMessage;
    const child = fakeChild((message, emit) => {
      messages.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread",
        modes: { currentModeId: "plan", availableModes: [{ id: "plan" }, { id: "default" }, { id: "bypassPermissions" }] } } });
      else if (message.method === "session/set_mode") emit({ id: message.id, result: {} });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    const turn = service.submit("one", "先制定计划", []);
    await vi.waitFor(() => expect(messages.some(message => message.method === "session/prompt")).toBe(true));
    emitMessage({ id: 91, method: "session/request_permission", params: { sessionId: "thread",
      toolCall: { toolCallId: "exit-1", _meta: { "codebuddy.ai/toolName": "ExitPlanMode",
        "codebuddy.ai/plan": "# 改造计划\n先检查，再修改。" } },
      options: [{ kind: "allow_once", optionId: "execute" }, { kind: "reject_once", optionId: "revise" }] } });
    const pending = service.snapshot("one").pendingPlan;
    expect(service.snapshot("one").busy).toBe(true);
    expect(service.snapshot("one").approvals).toEqual([]);
    expect(service.snapshot("one").items.at(-1)).toMatchObject({ id: pending.itemId, type: "plan", text: "# 改造计划\n先检查，再修改。" });
    await service.executePlan("one", pending.itemId);
    expect(messages.find(message => message.id === 91).result).toEqual({ outcome: { outcome: "selected", optionId: "execute" } });
    emitMessage({ method: "session/update", params: { sessionId: "thread", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } } });
    await vi.waitFor(() => expect(messages.some(message => message.method === "session/set_mode" && message.params.modeId === "bypassPermissions")).toBe(true));
    expect(service.snapshot("one")).toMatchObject({ nativeMode: "bypassPermissions", executionPermission: "fullAccess", pendingPlan: null });
    emitMessage({ id: messages.find(message => message.method === "session/prompt").id, result: { stopReason: "end_turn" } });
    await turn;
    await expect(service.executePlan("one", pending.itemId)).rejects.toThrow("已失效");
    emitMessage({ method: "session/update", params: { sessionId: "thread", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } });
    emitMessage({ id: 92, method: "session/request_permission", params: { sessionId: "thread",
      toolCall: { toolCallId: "exit-2", _meta: { "codebuddy.ai/toolName": "ExitPlanMode", "codebuddy.ai/plan": "# 新计划" } },
      options: [{ kind: "allow_once", optionId: "execute" }, { kind: "reject_once", optionId: "revise" }] } });
    await service.dismissPlan("one", service.snapshot("one").pendingPlan.itemId);
    expect(messages.find(message => message.id === 92).result).toEqual({ outcome: { outcome: "selected", optionId: "revise" } });
    service.shutdown();
  });
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
      .toMatchObject({ "codebuddy.ai": { question: true, mainAgentSupport: true } });
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
    expect(wsl.args.at(-1)).not.toContain("--plugin-dir");
    expect(wsl.args.at(-1)).not.toContain("--mcp-config");
    const bridge = buildInvocation({ type: "ssh", cwd: "/srv/app", shell: "powershell.exe" },
      { localBridge: true, workspaceCwd: "C:\\bridge", acpArgs: "--acp --strict-mcp-config" }, {});
    expect(bridge.cwd).toBe("C:\\bridge");
    expect(bridge.args.at(-1)).toContain("--strict-mcp-config");
    expect(bridge.args.at(-1)).toContain("--acp-transport streamable-http");
    expect(bridge.args.at(-1)).not.toContain("--plugin-dir");
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
    const codex = { snapshot: vi.fn(() => "codex"), renameThread: vi.fn(() => "codex renamed"), close: vi.fn(), shutdown: vi.fn() };
    const buddy = { snapshot: vi.fn(() => "buddy"), setMultitask: vi.fn(() => "enabled"),
      sendTeamMessage: vi.fn(() => "sent"), renameThread: vi.fn(() => "buddy renamed"),
      rewind: vi.fn(() => "rewound"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy, { getSession: id => ({ agentProvider: id === "buddy" ? "codebuddy" : "codex" }) });
    expect(router.snapshot("buddy")).toBe("buddy");
    expect(router.snapshot("codex")).toBe("codex");
    expect(router.setMultitask("buddy", true)).toBe("enabled");
    expect(buddy.setMultitask).toHaveBeenCalledWith("buddy", true);
    expect(() => router.setMultitask("codex", true)).toThrow("只有 CodeBuddy");
    expect(router.sendTeamMessage("buddy", "team", "member", "hello")).toBe("sent");
    expect(buddy.sendTeamMessage).toHaveBeenCalledWith("buddy", "team", "member", "hello");
    expect(() => router.sendTeamMessage("codex", "team", "member", "hello")).toThrow("只有 CodeBuddy");
    expect(router.renameThread("buddy", "thread", "New title")).toBe("buddy renamed");
    expect(router.renameThread("codex", "thread", "New title")).toBe("codex renamed");
    expect(router.rewind("buddy", "message", "Code")).toBe("rewound");
    expect(() => router.rewind("codex", "message", "Code")).toThrow("只有 CodeBuddy");
    router.close("buddy");
    expect(codex.close).toHaveBeenCalledWith("buddy");
    expect(buddy.close).toHaveBeenCalledWith("buddy");
  });

  it("rewinds a stable Windows user message and reloads the same ACP session", async () => {
    const threadId = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const messageId = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
    const spawnProcess = vi.fn(() => {
      const child = fakeChild((message, emit) => {
        if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
        else if (message.method === "session/new" || message.method === "session/load") {
          emit({ method: "session/update", params: { sessionId: threadId, update: {
            sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: "Original prompt" } } } });
          emit({ id: message.id, result: { sessionId: threadId } });
        }
      });
      child.kill = vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); });
      return child;
    });
    const rewindControl = vi.fn(async () => ({ canRewind: true, historyRewound: true, filesChanged: ["src/a.ts"] }));
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess, rewindControl });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" }, { resumeThreadId: threadId });
    expect(service.snapshot("one").items[0].rewindMessageId).toBe(messageId);
    await expect(service.rewind("one", "invalid", "Code")).rejects.toThrow("回退标识");
    const result = await service.rewind("one", messageId, "CodeAndConversation");
    expect(result).toMatchObject({ snapshot: { threadId }, historyRewound: true, filesChanged: ["src/a.ts"] });
    expect(rewindControl).toHaveBeenCalledWith(expect.objectContaining({ sessionId: threadId, messageId, scope: "CodeAndConversation" }));
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    rewindControl.mockRejectedValueOnce(new Error("checkpoint unavailable"));
    await expect(service.rewind("one", messageId, "Code")).rejects.toThrow("checkpoint unavailable");
    expect(service.snapshot("one").threadId).toBe(threadId);
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    rewindControl.mockResolvedValueOnce({ canRewind: true, historyRewound: true, fileRewindError: "locked file" });
    const partial = await service.rewind("one", messageId, "CodeAndConversation");
    expect(partial.fileRewindError).toBe("locked file");
    expect(partial.snapshot.items.at(-1)).toMatchObject({ type: "turnError", text: expect.stringContaining("locked file") });
    service.shutdown();
  });

  it("renames only listed CodeBuddy history through the public HTTP endpoint", async () => {
    const renameSession = vi.fn(async () => ({ data: { name: "New title" } }));
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "current" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child,
      historyService: { listHistoryForSession: async () => ({ items: [
        { ref: "codebuddy:old", provider: "codebuddy", cwd: "C:\\work", title: "Old" }], errors: [] }) },
      httpTransportFactory: () => {
        const events = new EventEmitter();
        readline.createInterface({ input: child.stdout }).on("line", line => events.emit("message", JSON.parse(line)));
        return { on: (name, listener) => events.on(name, listener), connect: async () => {},
          send: async message => { child.stdin.write(`${JSON.stringify(message)}\n`); }, renameSession, close: () => {} };
      } });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await service.listHistory("one");
    await expect(service.renameThread("one", "other", "New title")).rejects.toThrow("当前项目");
    await service.renameThread("one", "old", " New title ");
    expect(renameSession).toHaveBeenCalledWith("old", "New title");
    service.shutdown();
  });

  it("loads only listed history for this workspace and restores replayed messages", async () => {
    const historyService = { listHistoryForSession: vi.fn().mockResolvedValue({ items: [
      { ref: "codebuddy:old", provider: "codebuddy", cwd: "C:\\work", title: "Previous", updatedAt: Date.parse("2026-09-24T00:00:00Z") },
      { ref: "codebuddy:other", provider: "codebuddy", cwd: "C:\\other", title: "Other" } ], nextCursor: null, errors: [] }) };
    const methods = [];
    const child = fakeChild((message, emit) => {
      methods.push(message.method);
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id, result: {
        agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new" } });
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
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child, historyService });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work", shell: "powershell.exe" });
    const history = await service.listHistory("one");
    expect(history.data.map(value => value.id)).toEqual(["old"]);
    expect(history.data[0].updatedAt).toBe(Date.parse("2026-09-24T00:00:00Z") / 1000);
    expect(historyService.listHistoryForSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "C:\\work", type: "windows" }),
      { providers: ["codebuddy"], scope: "cwd", cursor: null });
    expect(methods).not.toContain("session/list");
    await expect(service.resume("one", "other")).rejects.toThrow("当前项目");
    const restored = await service.resume("one", "old");
    expect(restored.threadId).toBe("old");
    expect(restored.availableCommands).toEqual([{ name: "summarize", description: "Summarize history" }]);
    expect(restored.items.map(item => item.text)).toEqual(["Old prompt", "Old answer"]);
    service.shutdown();
  });

  it("passes history cursors through and reports read failures instead of showing an empty list", async () => {
    const historyService = { listHistoryForSession: vi.fn()
      .mockResolvedValueOnce({ items: [{ ref: "codebuddy:first", provider: "codebuddy", cwd: "C:\\work", title: "First", updatedAt: 1700000000000 }], nextCursor: "1", errors: [] })
      .mockResolvedValueOnce({ items: [], nextCursor: null, errors: [] })
      .mockResolvedValueOnce({ items: [], nextCursor: null, errors: [{ provider: "codebuddy", message: "读取失败" }] }) };
    const child = fakeChild((message, emit) => {
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "current" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child, historyService });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(await service.listHistory("one")).toMatchObject({ data: [{ id: "first" }], nextCursor: "1" });
    expect(await service.listHistory("one", "1")).toEqual({ data: [], nextCursor: null });
    expect(historyService.listHistoryForSession).toHaveBeenNthCalledWith(2, expect.any(Object),
      { providers: ["codebuddy"], scope: "cwd", cursor: "1" });
    await expect(service.listHistory("one")).rejects.toThrow("读取失败");
    service.shutdown();
  });

  it("uses the ACP workspace for WSL and the Windows workspace for a local SSH bridge", async () => {
    for (const [session, runtime, expected] of [
      [{ id: "wsl", type: "wsl", cwd: "/home/user/project", wslDistro: "Ubuntu" }, {}, { type: "wsl", cwd: "/home/user/project" }],
      [{ id: "bridge", type: "ssh", cwd: "/srv/project" }, { localBridge: true, workspaceCwd: "C:\\bridge" }, { type: "windows", cwd: "C:\\bridge" }]
    ]) {
      const historyService = { listHistoryForSession: vi.fn().mockResolvedValue({ items: [], nextCursor: null, errors: [] }) };
      const child = fakeChild((message, emit) => {
        if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
        else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "current" } });
      });
      const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
        terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child, historyService });
      await service.start(session, runtime);
      expect(await service.listHistory(session.id)).toEqual({ data: [], nextCursor: null });
      expect(historyService.listHistoryForSession).toHaveBeenCalledWith(expect.objectContaining(expected),
        { providers: ["codebuddy"], scope: "cwd", cursor: null });
      service.shutdown();
    }
  });

  it("streams member text without history and isolates equal message IDs across snapshot boundaries", async () => {
    let emitUpdate;
    const child = fakeChild((message, emit) => {
      emitUpdate = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "current" } });
    });
    const broadcasts = [];
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: (channel, payload) => broadcasts.push([channel, structuredClone(payload)]), spawnProcess: () => child });
    const push = (text, memberName, kind = "agent_message_chunk") => emitUpdate({ method: "session/update", params: {
      sessionId: "current", update: { sessionUpdate: kind, messageId: "same", content: { type: "text", text },
        ...(memberName ? { _meta: { "codebuddy.ai/memberEvent": memberName } } : {}) } } });
    const flush = () => new Promise(resolve => setTimeout(resolve, 100));
    try {
      await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
      const history = "h".repeat(1024 * 1024);
      push(history); push(history, "architect");
      await flush(); broadcasts.length = 0;
      for (let i = 0; i < 20; i++) { push("x".repeat(1024), "architect"); await flush(); }
      expect(broadcasts).toHaveLength(20);
      expect(broadcasts.every(([channel]) => channel === "codex-app-server:delta")).toBe(true);
      const bytes = broadcasts.reduce((total, [, payload]) => total + Buffer.byteLength(JSON.stringify(payload)), 0);
      process.stdout.write(`Member streaming: ${broadcasts.length} deltas, ${(bytes / 1024).toFixed(2)} KiB\n`);
      expect(bytes).toBeLessThan(30 * 1024);
      for (const [, payload] of broadcasts) {
        expect(payload.textDeltas).toEqual([{ itemId: "same", memberName: "architect", delta: "x".repeat(1024) }]);
        expect(payload.revision).toBe(payload.baseRevision + 1);
      }
      push("review", "reviewer"); await flush();
      expect(broadcasts.at(-1)[0]).toBe("codex-app-server:changed");
      broadcasts.length = 0;
      push("a", "architect"); push("b", "reviewer"); push("c"); push("d", "architect"); await flush();
      expect(broadcasts[0][1].textDeltas).toEqual([
        { itemId: "same", memberName: "architect", delta: "ad" },
        { itemId: "same", memberName: "reviewer", delta: "b" }, { itemId: "same", delta: "c" }]);
      push("e", "architect"); push("", "reviewer", "session_end"); push("f", "reviewer"); await flush();
      expect(broadcasts.at(-1)[0]).toBe("codex-app-server:changed");
      const full = broadcasts.at(-1)[1].snapshot;
      expect(full.items[0].text).toBe(history + "c");
      expect(full.team.members.map(member => member.items[0].text)).toEqual([history + "x".repeat(20 * 1024) + "ade", "reviewbf"]);
      push("g", "architect"); await flush();
      expect(broadcasts.at(-1)[1]).toMatchObject({ baseRevision: full.revision, revision: full.revision + 1,
        textDeltas: [{ memberName: "architect", itemId: "same", delta: "g" }] });
    } finally { service.shutdown(); }
  });

  it("keeps manual and automatic team members in separate timelines and restores the latest team state", async () => {
    const historyService = { listHistoryForSession: vi.fn().mockResolvedValue({ items: [
      { ref: "codebuddy:saved", provider: "codebuddy", cwd: "C:\\work", title: "Saved" } ], nextCursor: null, errors: [] }) };
    let emitUpdate;
    const child = fakeChild((message, emit) => {
      emitUpdate = emit;
      if (message.method === "initialize") emit({ jsonrpc: "2.0", id: message.id,
        result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "current" } });
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
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child, historyService });
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


describe("detached worker plan review", () => {
  async function fixture() {
    const messages = [];
    let push;
    const child = fakeChild((message, emit) => {
      messages.push(message); push = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread",
        modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }, { id: "bypassPermissions" }] } } });
      else if (message.method === "session/prompt") emit({ id: message.id, result: { stopReason: "end_turn" } });
    });
    const service = createCodeBuddyAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    await service.submit("one", "dispatch workers");
    const plan = (id, changes = {}) => push({ id, method: "session/request_permission", params: {
      sessionId: "thread", toolCall: { toolCallId: `worker-${id}`, _meta: {
        "codebuddy.ai/toolName": "ExitPlanMode", "codebuddy.ai/plan": `Plan ${id}` } },
      options: [{ kind: "allow_once", optionId: "execute" }, { kind: "reject_once", optionId: "revise" }], ...changes } });
    const update = update => push({ method: "session/update", params: { sessionId: "thread", update } });
    return { service, messages, child, plan, update };
  }

  it.each([true, false])("reviews idle worker plans and responds once: execute=%s", async execute => {
    const f = await fixture();
    try {
      f.plan(501);
      expect(f.service.snapshot("one")).toMatchObject({ busy: false, mode: "default", error: null,
        pendingPlan: { itemId: "codebuddy-plan:501" } });
      expect(f.service.snapshot("one").items.at(-1)).toMatchObject({ type: "plan", text: "Plan 501" });
      if (execute) await f.service.executePlan("one", "codebuddy-plan:501");
      else f.service.dismissPlan("one", "codebuddy-plan:501");
      expect(f.messages.find(message => message.id === 501).result).toEqual({ outcome: {
        outcome: "selected", optionId: execute ? "execute" : "revise" } });
      await expect(f.service.executePlan("one", "codebuddy-plan:501")).rejects.toThrow("已失效");
      expect(() => f.service.dismissPlan("one", "codebuddy-plan:501")).toThrow("已失效");
      await f.service.submit("one", "next parent turn");
      f.update({ sessionUpdate: "current_mode_update", currentModeId: "default" });
      await Promise.resolve();
      expect(f.messages.some(message => message.method === "session/set_mode")).toBe(false);
      expect(f.messages.filter(message => message.id === 501)).toHaveLength(1);
      expect(f.service.snapshot("one")).toMatchObject({ nativeMode: "default", executionPermission: "askApproval" });
    } finally { f.service.shutdown(); }
  });

  it("preserves and queues plans across background summaries without replacing duplicate requests", async () => {
    const f = await fixture();
    try {
      f.plan(501); f.plan(502); f.plan(501);
      const meta = { "codebuddy.ai/requestId": "drain" };
      f.update({ sessionUpdate: "session_info_update", _meta: { ...meta,
        "codebuddy.ai/unsolicitedTurn": { requestId: "drain", reason: "background_drain" } } });
      f.update({ sessionUpdate: "session_end", _meta: meta });
      expect(f.service.snapshot("one")).toMatchObject({ busy: false, pendingPlan: { itemId: "codebuddy-plan:501" } });
      expect(f.service.snapshot("one").items.filter(item => item.type === "plan")).toHaveLength(2);
      await f.service.executePlan("one", "codebuddy-plan:501");
      expect(f.service.snapshot("one").pendingPlan).toEqual({ itemId: "codebuddy-plan:502" });
      expect(f.messages.some(message => message.id === 502)).toBe(false);
      await expect(f.service.executePlan("one", "codebuddy-plan:501")).rejects.toThrow("已失效");
      f.service.dismissPlan("one", "codebuddy-plan:502");
      expect(f.service.snapshot("one").pendingPlan).toBeNull();
      expect(f.messages.find(message => message.id === 502).result.outcome.optionId).toBe("revise");
    } finally { f.service.shutdown(); }
  });

  it.each([
    { sessionId: "other" },
    { toolCall: { _meta: { "codebuddy.ai/toolName": "ExitPlanMode", "codebuddy.ai/plan": "  " } } },
    { options: [{ kind: "reject_once", optionId: "revise" }] }
  ])("rejects invalid worker plan requests: %j", async changes => {
    const f = await fixture();
    try {
      f.plan(501, changes);
      expect(f.service.snapshot("one").pendingPlan).toBeNull();
      expect(f.messages.find(message => message.id === 501).result).toEqual({ outcome: { outcome: "cancelled" } });
    } finally { f.service.shutdown(); }
  });

  it("blocks conversation switching while plans wait and invalidates them on close", async () => {
    const f = await fixture();
    try {
      f.plan(501); f.plan(502);
      await expect(f.service.newThread("one")).rejects.toThrow("尚未结束");
      expect(f.service.snapshot("one").pendingPlan).toEqual({ itemId: "codebuddy-plan:501" });
      f.service.close("one");
      await expect(f.service.executePlan("one", "codebuddy-plan:501")).rejects.toThrow("不存在");
      expect(() => f.service.dismissPlan("one", "codebuddy-plan:502")).toThrow("不存在");
      expect(f.messages.some(message => message.id === 501 || message.id === 502)).toBe(false);
    } finally { f.service.shutdown(); }
  });

  it("invalidates the full plan queue on a disconnected transport", async () => {
    const f = await fixture();
    try {
      f.plan(501); f.plan(502);
      f.child.emit("exit", 1);
      expect(f.service.snapshot("one").pendingPlan).toBeNull();
      await expect(f.service.executePlan("one", "codebuddy-plan:501")).rejects.toThrow("已失效");
      expect(() => f.service.dismissPlan("one", "codebuddy-plan:502")).toThrow("已失效");
    } finally { f.service.shutdown(); }
  });
});
