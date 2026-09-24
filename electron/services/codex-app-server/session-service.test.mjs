import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { buildInvocation, createCodexAppServerSessionService } = require("./session-service.cjs");
const { createQuestionAnswerStore } = require("./question-answer-store.cjs");

function fakeProcess(received, respond) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit("exit", 0); };
  let buffer = "";
  child.stdin.on("data", chunk => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const request = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      received.push(request);
      if (request.id == null) continue;
      const result = respond?.(request) ?? (request.method === "thread/start" ? { thread: { id: "thread-1", model: "test-model" } }
        : request.method === "model/list" ? { data: [{ id: "test-model", isDefault: true }] }
          : request.method === "turn/start" ? { turn: { id: "turn-1", status: "inProgress" } } : {});
      child.stdout.write(`${JSON.stringify(result?.__error ? { id: request.id, error: { message: result.__error } }
        : { id: request.id, result })}\n`);
    }
  });
  return child;
}

describe("Codex App Server session", () => {
  it("selects a catalog model and restarts the same thread for template Fast mode", async () => {
    const received = [];
    const children = [];
    const invocations = [];
    const template = { id: "template-1", codexBackend: "openai", codexAppServerFastMode: false };
    const sessionStore = {
      getTemplate: () => template,
      updateLibrary: vi.fn((_id, changes) => Object.assign(template, changes))
    };
    const respond = request => {
      if (request.method === "model/list") return { data: [
        { id: "model-a", displayName: "Model A", isDefault: true, serviceTiers: [{ id: "priority" }],
          defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] },
        { id: "model-b", displayName: "Model B", serviceTiers: [],
          defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }] }
      ] };
      if (request.method === "thread/start") return { thread: { id: "thread-1", model: "model-a" } };
      if (request.method === "thread/resume") return { thread: { id: "thread-1", model: "model-a", turns: [] } };
    };
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, sessionStore,
      spawnProcess: (_command, args) => {
        invocations.push(args);
        const child = fakeProcess(received, respond);
        children.push(child);
        return child;
      } });
    try {
      await service.start({ id: "run-1", templateId: template.id, codexBackend: "openai", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      expect(service.snapshot("run-1").models).toEqual([
        { id: "model-a", displayName: "Model A", fastAvailable: true, defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] },
        { id: "model-b", displayName: "Model B", fastAvailable: false, defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }] }
      ]);
      expect(service.snapshot("run-1").effort).toBe("medium");
      expect(service.setEffort("run-1", "high").effort).toBe("high");
      expect(template.codexAppServerEffort).toBe("high");
      expect(() => service.setEffort("run-1", "max")).toThrow("当前模型支持");
      await expect(service.setFastMode("run-1", true)).resolves.toMatchObject({ fastMode: true, threadId: "thread-1" });
      expect(template.codexAppServerFastMode).toBe(true);
      expect(invocations.at(-1).at(-1)).toContain("service_tier=\"priority\"");
      await service.setModel("run-1", "model-b");
      expect(template).toMatchObject({ codexAppServerModel: "model-b", codexAppServerEffort: "low", codexAppServerFastMode: false });
      expect(service.snapshot("run-1").effort).toBe("low");
      service.setEffort("run-1", "medium");
      expect(service.snapshot("run-1").effort).toBe("medium");
      expect(invocations.at(-1).at(-1)).toContain("service_tier=\"default\"");
      await expect(service.setFastMode("run-1", true)).rejects.toThrow("不支持快速模式");
      await service.submit("run-1", "hello");
      expect(received.filter(request => request.method === "turn/start").at(-1).params.model).toBe("model-b");
      expect(received.filter(request => request.method === "turn/start").at(-1).params.effort).toBe("medium");
    } finally { service.close("run-1"); }
  });
  it("runs local SSH bridge threads and attachments in the local workspace", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "thread/read"
      ? { thread: { id: "old-thread", cwd: "C:\\bridge" } }
      : request.method === "thread/resume"
        ? { thread: { id: "old-thread", model: "test-model", turns: [] } }
        : undefined);
    const spawnProcess = vi.fn(() => child);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {}, getSession: () => ({ id: "bridge", type: "ssh" }),
        setAppServerConnectionState: vi.fn(), listSessions: () => [{ id: "bridge" }] },
      broadcast: () => {}, spawnProcess });
    const session = { id: "bridge", type: "ssh", agentLocation: "local", cwd: "/srv/project", initialCommand: "remote command" };
    const runtime = { localBridge: true, workspaceCwd: "C:\\bridge", shell: "powershell.exe",
      codexCommand: "codex -c 'developer_instructions=\"remote only\"'", runtimeEnv: { PANNEL_HANDLE_REMOTE_AGENT_TOKEN: "secret" } };
    try {
      await service.start(session, runtime);
      expect(spawnProcess).toHaveBeenCalledWith("powershell.exe", expect.any(Array), expect.objectContaining({ cwd: "C:\\bridge" }));
      expect(spawnProcess.mock.calls[0][1].at(-1)).not.toContain("remote command");
      expect(received.find(request => request.method === "thread/start").params.cwd).toBe("C:\\bridge");
      expect(service.getWorkspaceCwd("bridge")).toBe("C:\\bridge");
      await service.listHistory("bridge");
      expect(received.find(request => request.method === "thread/list").params.cwd).toBe("C:\\bridge");
      await service.resume("bridge", "old-thread");
      await service.submit("bridge", "Inspect the remote workspace");
      expect(received.find(request => request.method === "turn/start").params.sandboxPolicy.writableRoots).toEqual(["C:\\bridge"]);
    } finally { service.close("bridge"); }
  });
  it("previews only attached files and restores preview links from user message content", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-preview-"));
    const textPath = path.join(directory, "notes.txt");
    const imagePath = path.join(directory, "picture.png");
    const secretPath = path.join(directory, "other.txt");
    const largePath = path.join(directory, "large.txt");
    const binaryPath = path.join(directory, "archive.zip");
    fs.writeFileSync(textPath, "hello preview");
    fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(secretPath, "not attached");
    fs.writeFileSync(largePath, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2]));
    const child = fakeProcess([], request => {
      if (request.method === "thread/read") return { thread: { id: "old-thread", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "old-thread", turns: [{ items: [{
        id: "history-user", type: "userMessage", content: [
          { type: "text", text: `检查\n\n请读取以下附件文件：${JSON.stringify(textPath)}` },
          { type: "localImage", path: imagePath }
        ] }] }] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.previewAttachment("run-1", textPath)).rejects.toThrow("当前会话");
      service.allowFiles("run-1", [textPath, imagePath, largePath, binaryPath]);
      expect(await service.previewAttachment("run-1", textPath)).toEqual({ kind: "text", text: "hello preview" });
      expect(await service.previewAttachment("run-1", imagePath)).toMatchObject({ kind: "image", dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
      expect(await service.previewAttachment("run-1", largePath)).toMatchObject({ kind: "too_large", limit: 2 * 1024 * 1024 });
      expect(await service.previewAttachment("run-1", binaryPath)).toEqual({ kind: "unsupported" });
      await service.resume("run-1", "old-thread");
      expect(service.snapshot("run-1").items[0]).toMatchObject({ text: "检查", attachments: [
        { path: textPath, name: "notes.txt" }, { path: imagePath, name: "picture.png" }
      ] });
      expect(await service.previewAttachment("run-1", textPath)).toEqual({ kind: "text", text: "hello preview" });
      await expect(service.previewAttachment("run-1", secretPath)).rejects.toThrow("当前会话");
      fs.rmSync(textPath);
      await expect(service.previewAttachment("run-1", textPath)).rejects.toThrow();
    } finally { service.close("run-1"); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("publishes live token totals and clears them when starting another thread", async () => {
    const child = fakeProcess([]);
    const changes = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: (channel, payload) => changes.push({ channel, payload }),
      spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    const usage = outputTokens => ({ total: { inputTokens: 100, cachedInputTokens: 20, outputTokens,
      reasoningOutputTokens: 3, totalTokens: 100 + outputTokens }, last: { inputTokens: 10, cachedInputTokens: 2,
      outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 }, modelContextWindow: 128000 });
    child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: "thread-1", turnId: "turn-1", tokenUsage: usage(10) } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").tokenUsage?.total.outputTokens).toBe(10));
    expect(service.snapshot("run-1").tokenUsage).toMatchObject({ total: { inputTokens: 100, cachedInputTokens: 20 }, modelContextWindow: 128000 });
    expect(changes.some(change => change.channel === "codex-app-server:changed" && change.payload.snapshot.tokenUsage?.total.outputTokens === 10)).toBe(true);
    child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: "other-thread", turnId: "turn-1", tokenUsage: usage(999) } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.snapshot("run-1").tokenUsage.total.outputTokens).toBe(10);
    await service.newThread("run-1");
    expect(service.snapshot("run-1").tokenUsage).toBeNull();
    service.close("run-1");
  });

  it("retains usage replayed before a history resume response", async () => {
    let child;
    const recorded = vi.fn();
    child = fakeProcess([], request => {
      if (request.method === "thread/read") return { thread: { id: "old-thread", cwd: "C:\\project" } };
      if (request.method === "thread/resume") {
        child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "old-thread",
          turnId: "old-turn", tokenUsage: { total: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 8,
            reasoningOutputTokens: 1, totalTokens: 58 }, last: { inputTokens: 50, cachedInputTokens: 10,
            outputTokens: 8, reasoningOutputTokens: 1, totalTokens: 58 } } } })}\n`);
        return { thread: { id: "old-thread", model: "test-model", turns: [] } };
      }
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      onTokenUsage: recorded });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    const restored = await service.resume("run-1", "old-thread");
    expect(restored.tokenUsage?.total.outputTokens).toBe(8);
    expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ threadId: "old-thread", baseline: true }));
    service.close("run-1");
  });

  it("forwards cumulative App Server usage with history and reset baselines", async () => {
    const recorded = vi.fn();
    let nextThread = 0;
    const child = fakeProcess([], request => {
      if (request.method === "thread/start") return { thread: { id: `thread-${++nextThread}`, model: "test-model" } };
      if (request.method === "thread/read") return { thread: { id: "history", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "history", model: "test-model", turns: [] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      onTokenUsage: recorded });
    const sendUsage = (threadId, totalTokens) => child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated",
      params: { threadId, tokenUsage: { total: { inputTokens: totalTokens - 10, outputTokens: 10, totalTokens },
        last: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } } } })}\n`);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project", title: "Work" });
      sendUsage("thread-1", 100);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "thread-1", baseline: false,
        tokens: expect.objectContaining({ totalTokens: 100 }) }));
      sendUsage("wrong-thread", 999);
      await new Promise(resolve => setImmediate(resolve));
      expect(recorded).toHaveBeenCalledTimes(1);
      await service.resume("run-1", "history");
      sendUsage("history", 500);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(2));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "history", baseline: true }));
      sendUsage("history", 530);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(3));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "history", baseline: false }));
      service.resetUsageBaselines();
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "history", baseline: true,
        tokens: expect.objectContaining({ totalTokens: 530 }) }));
      await service.newThread("run-1");
      sendUsage("thread-2", 20);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(5));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "thread-2", baseline: false }));
    } finally { service.close("run-1"); }
  });

  it.skipIf(process.platform !== "win32")("keeps command and configured variables in the launched process", () => {
    const invocation = buildInvocation({ type: "windows", shell: process.env.ComSpec || "cmd.exe", cwd: process.cwd(),
      initialCommand: "set CODEX_TEST_FROM_COMMAND=from-command" },
    { codexCommand: "node -p process.env.CODEX_TEST_FROM_COMMAND+process.env.CODEX_TEST_VALUE" },
    { CODEX_TEST_VALUE: "configured" });
    const result = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("from-commandconfigured");
  });
  it("runs startup commands in the same shell and passes configured environment", () => {
    const windows = buildInvocation({ type: "windows", shell: "powershell.exe", cwd: "C:\\project", initialCommand: "$env:FROM_START='yes'" },
      { codexCommand: "codex" }, { CUSTOM: "value" });
    expect(windows.args.at(-1)).toContain("$env:FROM_START='yes'");
    expect(windows.args.at(-1)).toContain("codex app-server");
    expect(windows.env.CUSTOM).toBe("value");
    const wsl = buildInvocation({ type: "wsl", wslDistro: "Ubuntu", cwd: "/repo", initialCommand: "export FROM_START=yes" },
      { codexCommand: "codex" }, { CUSTOM: "value" });
    expect(wsl.args).toContain("/repo");
    expect(wsl.args).toContain("-lic");
    expect(wsl.args.at(-1)).toContain("export FROM_START=yes");
    expect(wsl.args.at(-1)).toContain("exec codex app-server");
    expect(wsl.env.WSLENV).toContain("CUSTOM/u");
  });
  it("reports WSL App Server startup output without exposing configured secrets", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const service = createCodexAppServerSessionService({
      environmentService: { resolve: () => ({ CODEX_TEST_TOKEN: "private-token-value" }) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child
    });
    const started = service.start({ id: "wsl-failed", type: "wsl", wslDistro: "ubuntu", cwd: "/repo" });
    child.stderr.write("CLI failed with private-token-value\n");
    child.emit("exit", 127);
    await expect(started).rejects.toThrow("启动输出：CLI failed with [已隐藏]");
    expect(child.kill).toHaveBeenCalled();
  });

  it("initializes, starts a thread, sends a turn, and resolves approval once", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({
      environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} },
      broadcast: () => {},
      spawnProcess: () => child
    });
    const session = { id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" };
    await service.start(session);
    expect(service.snapshot("run-1").threadId).toBe("thread-1");
    await service.submit("run-1", "Hello");
    expect(received.find(item => item.method === "turn/start").params.input[0].text).toBe("Hello");
    expect(received.find(item => item.method === "turn/start").params).not.toHaveProperty("effort");
    expect(received.find(item => item.method === "turn/start").params.collaborationMode).toEqual({ mode: "default", settings: { model: "test-model", developer_instructions: null } });
    child.stdout.write(`${JSON.stringify({ id: 42, method: "item/commandExecution/requestApproval", params: { command: "pnpm test" } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.snapshot("run-1").approvals).toHaveLength(1);
    service.resolveApproval("run-1", 42, true);
    expect(received.at(-1)).toEqual({ id: 42, result: { decision: "accept" } });
    service.close("run-1");
  });

  it("steers consecutive messages and images into the active turn without losing either message", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "turn/steer" ? { turnId: "turn-1" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", shell: "bash", cwd: "/repo" });
    try {
      await service.submit("run-1", "开始");
      const image = "/repo/.pannel-handle-images/steer.png";
      service.allowPastedImage("run-1", image);
      await service.submit("run-1", "先检查测试", [image]);
      await service.submit("run-1", "再检查文档");
      expect(received.filter(item => item.method === "turn/start")).toHaveLength(1);
      const steers = received.filter(item => item.method === "turn/steer");
      expect(steers).toHaveLength(2);
      expect(steers[0].params).toEqual({ threadId: "thread-1", expectedTurnId: "turn-1", input: [
        { type: "text", text: "先检查测试" }, { type: "localImage", path: image }
      ] });
      expect(service.snapshot("run-1").items.filter(item => item.type === "userMessage")).toHaveLength(3);
      for (const [id, text] of [["user-1", "开始"], ["user-2", "先检查测试"], ["user-3", "再检查文档"]])
        child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
          item: { id, type: "userMessage", content: [{ type: "text", text }] } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "user-3")).toBeTruthy());
      expect(service.snapshot("run-1").items.filter(item => item.type === "userMessage")).toHaveLength(3);
      expect(service.snapshot("run-1").items.find(item => item.id === "user-2").attachments).toEqual([
        { path: image, name: "steer.png" }
      ]);
    } finally { service.close("run-1"); }
  });

  it("keeps the active turn running when a steer is rejected", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "turn/steer" ? { __error: "turn/steer rejected" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      await service.submit("run-1", "开始");
      await expect(service.submit("run-1", "补充")).rejects.toThrow("turn/steer rejected");
      expect(service.snapshot("run-1").busy).toBe(true);
      expect(service.snapshot("run-1").items.filter(item => item.type === "userMessage").map(item => item.text)).toEqual(["开始"]);
    } finally { service.close("run-1"); }
  });

  it("starts a new turn when the previous turn completes before the follow-up is sent", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      await service.submit("run-1", "开始");
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
      await service.submit("run-1", "继续");
      expect(received.filter(item => item.method === "turn/start")).toHaveLength(2);
      expect(received.some(item => item.method === "turn/steer")).toBe(false);
    } finally { service.close("run-1"); }
  });

  it("keeps Question pending until resolved and sends all structured answers once", async () => {
    const received = [];
    const child = fakeProcess(received);
    const statuses = [];
    const service = createCodexAppServerSessionService({
      environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) },
      broadcast: () => {}, spawnProcess: () => child
    });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    await service.submit("run-1", "Ask me");
    child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ id: 42, method: "item/tool/requestUserInput", params: {
      threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "framework", header: "框架", question: "选择框架", isOther: true,
          options: [{ label: "React", description: "使用 React" }] },
        { id: "details", header: "细节", question: "补充说明", options: null }
      ] } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
    expect(statuses.at(-1)).toMatchObject({ status: "e_prompt", eventName: "AppServerQuestion" });
    expect(received.some(item => item.id === 42 && item.result?.answers)).toBe(false);
    expect(() => service.answerQuestion("run-1", 42, { framework: { answers: ["React"] } })).toThrow("请回答所有问题");
    const answers = { framework: { answers: ["React", "user_note: 继续"] }, details: { answers: ["user_note: 保持简单"] } };
    service.answerQuestion("run-1", 42, answers);
    expect(received.at(-1)).toEqual({ id: 42, result: { answers } });
    expect(service.snapshot("run-1").questions[0].submitting).toBe(true);
    expect(service.snapshot("run-1").items.at(-1)).toMatchObject({ type: "questionAnswer", status: "submitted", questions: [
      { id: "framework", answers: ["React", "user_note: 继续"] },
      { id: "details", answers: ["user_note: 保持简单"] }
    ] });
    expect(() => service.answerQuestion("run-1", 42, answers)).toThrow("问题请求已失效");
    child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 42 } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(0));
    expect(service.snapshot("run-1").items.at(-1).status).toBe("completed");
    child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 42 } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.snapshot("run-1").items.filter(item => item.type === "questionAnswer")).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ status: "running", eventName: "AppServerTurn" });
    service.close("run-1");
  });

  it("persists answered questions in history without saving secret answers", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-questions-"));
    let store = createQuestionAnswerStore({ userData });
    const processFor = threadId => fakeProcess([], request => {
      if (request.method === "thread/start") return { thread: { id: threadId, model: "test-model" } };
      if (request.method === "thread/read") return { thread: { id: request.params.threadId, cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: request.params.threadId, model: "test-model", turns: [{ id: "turn-1", items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "先提问" }] },
        { id: "agent-1", type: "agentMessage", text: "回答后继续" }
      ] }] } };
    });
    const createService = child => createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child, questionAnswerStore: store });
    let child = processFor("thread-1");
    let service = createService(child);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.submit("run-1", "先提问");
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
        item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "先提问" }] } } })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 42, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "choice", header: "选项", question: "选哪个？" },
        { id: "secret", header: "密钥", question: "输入密钥", isSecret: true }
      ] } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
      service.answerQuestion("run-1", 42, { choice: { answers: ["React"] }, secret: { answers: ["top-secret"] } });
      expect(store.list("thread-1")[0].item.questions).toEqual([
        { id: "choice", header: "选项", question: "选哪个？", answers: ["React"] },
        { id: "secret", header: "密钥", question: "输入密钥", answers: ["••••••"] }
      ]);
      child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 42 } })}\n`);
      await vi.waitFor(() => expect(store.list("thread-1")[0].item.status).toBe("completed"));
      service.close("run-1");
      store.close();
      store = createQuestionAnswerStore({ userData });
      child = processFor("new-thread");
      service = createService(child);
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const restored = await service.resume("run-1", "thread-1");
      expect(restored.items.map(item => item.type)).toEqual(["userMessage", "questionAnswer", "agentMessage"]);
      expect(restored.items[1]).toMatchObject({ status: "completed", questions: [
        { answers: ["React"] }, { answers: ["••••••"] }
      ] });
      expect(JSON.stringify(restored.items)).not.toContain("top-secret");
    } finally {
      service.close("run-1");
      store.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it("keeps a question retryable when its local record cannot be saved", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      questionAnswerStore: { save: () => { throw new Error("磁盘不可写"); }, remove: vi.fn() } });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.submit("run-1", "Ask me");
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 42, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1",
        questions: [{ id: "q", header: "问题", question: "回答？" }] } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
      expect(() => service.answerQuestion("run-1", 42, { q: { answers: ["是"] } })).toThrow("磁盘不可写");
      expect(service.snapshot("run-1").questions[0].submitting).toBe(false);
      expect(service.snapshot("run-1").items.some(item => item.type === "questionAnswer")).toBe(false);
      expect(received.some(item => item.id === 42 && item.result?.answers)).toBe(false);
    } finally { service.close("run-1"); }
  });

  it("removes Question when the server resolves it or the turn ends", async () => {
    const child = fakeProcess([]);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    await service.submit("run-1", "Ask me");
    child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
    const question = requestId => child.stdout.write(`${JSON.stringify({ id: requestId, method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "q", header: "Q", question: "?" }] } })}\n`);
    question(41);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
    child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 41 } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(0));
    question(42);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(0));
    expect(() => service.answerQuestion("run-1", 42, { q: { answers: ["yes"] } })).toThrow("问题请求已失效");
    service.close("run-1");
  });

  it("lists current-project history and resumes its stored messages", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "thread/start") return { thread: { id: "new-thread", model: "test-model" } };
      if (request.method === "thread/list") return { data: [{ id: "old-thread", name: "旧对话", updatedAt: 123, source: "cli", status: { type: "notLoaded" } }], nextCursor: "next" };
      if (request.method === "thread/read") return { thread: { id: "old-thread", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "old-thread", model: "test-model", turns: [{ items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "之前的问题" }] },
        { id: "answer-1", type: "agentMessage", text: "之前的回答" },
        { id: "plan-1", type: "plan", text: "# 历史计划" }
      ] }] } };
      return {};
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    expect(await service.listHistory("run-1")).toEqual({ data: [{ id: "old-thread", title: "旧对话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: "next" });
    expect(received.find(item => item.method === "thread/list").params).toMatchObject({ cwd: "C:\\project", sourceKinds: ["cli", "vscode", "appServer"] });
    const restored = await service.resume("run-1", "old-thread");
    expect(restored.threadId).toBe("old-thread");
    expect(restored.items.map(item => item.text)).toEqual(["之前的问题", "之前的回答", "# 历史计划"]);
    await vi.waitFor(() => expect(received.some(item => item.method === "thread/unsubscribe" && item.params.threadId === "new-thread")).toBe(true));
    service.close("run-1");
  });

  it("streams plan text, updates plan steps, and keeps the completed plan", async () => {
    const child = fakeProcess([]);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", item: { id: "plan-1", type: "plan", text: "" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "item/plan/delta", params: { threadId: "thread-1", itemId: "plan-1", delta: "# 初稿" } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", explanation: null,
      plan: [{ step: "检查代码", status: "inProgress" }] } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "plan-1")?.text).toBe("# 初稿"));
    expect(service.snapshot("run-1").items.find(item => item.type === "turnPlan")?.plan).toEqual([{ step: "检查代码", status: "inProgress" }]);
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", item: { id: "plan-1", type: "plan", text: "# 正式计划" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "plan-1")?.text).toBe("# 正式计划"));
    service.close("run-1");
  });

  it("offers a completed plan once and executes it in the same thread with Exec mode", async () => {
    const received = [];
    const child = fakeProcess(received);
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    service.setMode("run-1", "plan");
    await service.submit("run-1", "制定计划");
    child.stdout.write(`${JSON.stringify({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1",
      plan: [{ step: "检查代码", status: "completed" }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-1", type: "agentMessage", text: "<proposed_plan>\n# 正式计划\n</proposed_plan>" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").items.some(item => item.id === "plan-1")).toBe(true));
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-1" }));
    expect(statuses.at(-1)).toMatchObject({ status: "completed", eventName: "AppServerPlanPending" });
    await service.executePlan("run-1", "plan-1");
    expect(statuses.at(-1)).toMatchObject({ status: "running", eventName: "AppServerTurn" });
    const turns = received.filter(item => item.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[1].params).toMatchObject({ threadId: "thread-1", collaborationMode: { mode: "default" },
      sandboxPolicy: { type: "workspaceWrite" } });
    expect(turns[1].params.input).toEqual([{ type: "text", text: "按上述计划执行。" }]);
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    await expect(service.executePlan("run-1", "plan-1")).rejects.toThrow();
    service.close("run-1");
  });

  it("does not offer failed or progress-only plans and can dismiss a completed plan", async () => {
    const child = fakeProcess([]);
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    service.setMode("run-1", "plan");
    await service.submit("run-1", "制定计划");
    child.stdout.write(`${JSON.stringify({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1",
      plan: [{ step: "检查代码", status: "pending" }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    await service.submit("run-1", "再试一次");
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-2", type: "plan", text: "# 正式计划" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "failed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    await service.submit("run-1", "继续");
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-3", type: "plan", text: "# 新计划" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-3" }));
    expect(statuses.at(-1).eventName).toBe("AppServerPlanPending");
    service.dismissPlan("run-1", "plan-3");
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ status: "completed", eventName: "AppServerTurn" });
    await expect(service.executePlan("run-1", "plan-3")).rejects.toThrow("失效");
    await service.submit("run-1", "更新计划");
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-4", type: "plan", text: "# 更新计划" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-4" }));
    service.setMode("run-1", "default");
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ status: "completed", eventName: "AppServerTurn" });
    service.close("run-1");
  });

  it("sends Plan mode and selected image plus file path, while rejecting unselected files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-attachments-"));
    const imagePath = path.join(directory, "image.png");
    const documentPath = path.join(directory, "notes.txt");
    fs.writeFileSync(imagePath, "image"); fs.writeFileSync(documentPath, "notes");
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      service.setMode("run-1", "plan");
      await expect(service.submit("run-1", "检查", [documentPath])).rejects.toThrow("文件选择器");
      service.allowFiles("run-1", [imagePath, documentPath]);
      await service.submit("run-1", "检查", [imagePath, documentPath]);
      const turn = received.find(item => item.method === "turn/start");
      expect(turn.params.collaborationMode.mode).toBe("plan");
      expect(turn.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
      expect(turn.params.input).toEqual([{ type: "text", text: `检查\n\n请读取以下附件文件：${JSON.stringify(documentPath)}` },
        { type: "localImage", path: imagePath }]);
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
      service.setMode("run-1", "default");
      await service.submit("run-1", "继续");
      expect(received.filter(item => item.method === "turn/start").at(-1).params.sandboxPolicy).toMatchObject({ type: "workspaceWrite" });
      service.close("run-1");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("applies execution permissions per turn and retains the choice within one session", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "thread/read") return { thread: { cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "history-1", turns: [] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    const finishTurn = async threadId => {
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId,
        turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
    };
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      expect(service.snapshot("run-1").executionPermission).toBe("askApproval");
      expect(() => service.setExecutionPermission("run-1", "invalid")).toThrow("无效");
      service.setExecutionPermission("run-1", "readOnly");
      await service.submit("run-1", "检查");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }
      });
      expect(() => service.setExecutionPermission("run-1", "fullAccess")).toThrow("正在运行");
      await finishTurn("thread-1");

      service.setExecutionPermission("run-1", "fullAccess");
      service.setMode("run-1", "plan");
      await service.submit("run-1", "制定计划");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }
      });
      child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
        item: { id: "plan-permission", type: "plan", text: "# 计划" } } })}\n`);
      await finishTurn("thread-1");
      expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-permission" });
      await service.executePlan("run-1", "plan-permission");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }
      });
      await finishTurn("thread-1");

      await service.newThread("run-1");
      expect(service.snapshot("run-1").executionPermission).toBe("fullAccess");
      await service.resume("run-1", "history-1");
      expect(service.snapshot("run-1").executionPermission).toBe("fullAccess");
      service.setExecutionPermission("run-1", "askApproval");
      await service.submit("run-1", "继续");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["C:\\project"], networkAccess: false }
      });
    } finally { service.close("run-1"); }
  });

  it("syncs a template permission to other instances for their next turn", async () => {
    const received = [];
    const children = [fakeProcess(received), fakeProcess(received), fakeProcess(received), fakeProcess(received), fakeProcess(received)];
    let nextChild = 0;
    const template = { id: "template-1", codexExecutionPermission: "readOnly" };
    const sessionStore = { getTemplate: vi.fn(id => id === template.id ? template : undefined),
      setCodexExecutionPermission: vi.fn((_id, permission) => { template.codexExecutionPermission = permission; }) };
    const changed = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: (event, value) => {
        if (event === "codex-app-server:changed") changed.push(value);
      }, sessionStore, spawnProcess: () => children[nextChild++] });
    const session = (id, templateId) => ({ id, templateId, type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      await service.start(session("run-1", template.id));
      await service.start(session("run-2", template.id));
      await service.start(session("other", "template-2"));
      await service.start(session("temporary"));
      expect(service.snapshot("run-1").executionPermission).toBe("readOnly");
      await service.submit("run-2", "正在执行");
      const runningTurn = received.filter(item => item.method === "turn/start").at(-1);
      expect(runningTurn.params.sandboxPolicy.type).toBe("readOnly");
      service.setExecutionPermission("run-1", "fullAccess");
      expect(sessionStore.setCodexExecutionPermission).toHaveBeenCalledWith(template.id, "fullAccess");
      expect(service.snapshot("run-2").executionPermission).toBe("fullAccess");
      expect(service.snapshot("other").executionPermission).toBe("askApproval");
      expect(changed.some(value => value.id === "run-2" && value.snapshot.executionPermission === "fullAccess")).toBe(true);
      await service.start(session("run-3", template.id));
      expect(service.snapshot("run-3").executionPermission).toBe("fullAccess");
      expect(service.snapshot("run-2").busy).toBe(true);
      children[1].stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
        threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-2").busy).toBe(false));
      await service.submit("run-2", "下一轮");
      expect(received.filter(item => item.method === "turn/start").at(-1).params.sandboxPolicy.type).toBe("dangerFullAccess");
      service.setExecutionPermission("temporary", "readOnly");
      expect(sessionStore.setCodexExecutionPermission).toHaveBeenCalledTimes(1);
      expect(service.snapshot("temporary").executionPermission).toBe("readOnly");
      sessionStore.setCodexExecutionPermission.mockImplementation(() => { throw new Error("disk full"); });
      expect(() => service.setExecutionPermission("run-1", "askApproval")).toThrow("disk full");
      expect(service.snapshot("run-1").executionPermission).toBe("fullAccess");
      expect(service.snapshot("run-2").executionPermission).toBe("fullAccess");
    } finally {
      for (const id of ["run-1", "run-2", "other", "temporary", "run-3"]) service.close(id);
    }
  });

  it("converts selected Windows paths for WSL and fails before starting a turn when inaccessible", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-wsl-"));
    const filePath = path.join(directory, "notes.txt");
    fs.writeFileSync(filePath, "notes");
    const received = [];
    const convert = vi.fn(() => ({ status: 1, stdout: "" }));
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => fakeProcess(received),
      spawnSyncProcess: convert });
    try {
      await service.start({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", shell: "bash", cwd: "/repo" });
      service.allowFiles("run-1", [filePath]);
      await expect(service.submit("run-1", "检查", [filePath])).rejects.toThrow("WSL 无法访问文件");
      expect(received.some(item => item.method === "turn/start")).toBe(false);
      expect(convert).toHaveBeenCalledWith("wsl.exe", ["-d", "Ubuntu", "--", "wslpath", "-a", "-u", filePath], expect.any(Object));
      convert.mockReturnValueOnce({ status: 0, stdout: "/mnt/c/files/notes.txt\n" }).mockReturnValueOnce({ status: 0 });
      await service.submit("run-1", "检查", [filePath]);
      expect(received.find(item => item.method === "turn/start").params.input[0].text).toContain('"/mnt/c/files/notes.txt"');
      service.allowFiles("run-1", [filePath]);
      convert.mockReturnValueOnce({ status: 0, stdout: "/mnt/c/files/notes.txt\n" }).mockReturnValueOnce({ status: 0 });
      await service.submit("run-1", "补充检查", [filePath]);
      expect(received.find(item => item.method === "turn/steer").params.input[0].text)
        .toContain('"/mnt/c/files/notes.txt"');
      service.close("run-1");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses trusted WSL clipboard images directly and retains them after sending", async () => {
    const received = [];
    const removed = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      removePastedImage: async (_entry, filePath) => { removed.push(filePath); } });
    await service.start({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", shell: "bash", cwd: "/repo" });
    const discarded = "/repo/.pannel-handle-images/discard.png";
    service.allowPastedImage("run-1", discarded);
    await service.discardPastedImage("run-1", discarded);
    expect(removed).toEqual([discarded]);
    const sent = "/repo/.pannel-handle-images/sent.png";
    service.allowPastedImage("run-1", sent);
    await service.submit("run-1", "检查图片", [sent]);
    expect(received.find(item => item.method === "turn/start").params.input).toEqual([
      { type: "text", text: "检查图片" }, { type: "localImage", path: sent }
    ]);
    service.close("run-1");
    expect(removed).toEqual([discarded]);
  });

  it("removes unsent pasted images on a new thread and session close", async () => {
    const removed = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
      spawnProcess: () => fakeProcess([]), removePastedImage: async (_entry, filePath) => { removed.push(filePath); } });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    const oldThreadImage = "C:\\project\\.pannel-handle-images\\old-thread.png";
    service.allowPastedImage("run-1", oldThreadImage);
    await service.newThread("run-1");
    expect(removed).toEqual([oldThreadImage]);
    const pending = "C:\\project\\.pannel-handle-images\\pending.png";
    service.allowPastedImage("run-1", pending);
    service.close("run-1");
    await vi.waitFor(() => expect(removed).toEqual([oldThreadImage, pending]));
  });

  it("broadcasts live activity summaries without command output and keeps the final answer", async () => {
    const child = fakeProcess([]);
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    await service.submit("run-1", "检查构建");
    expect(statuses.at(-1)).toMatchObject({ id: "run-1", status: "running", activitySummary: "检查构建" });
    const emit = (method, params) => child.stdout.write(`${JSON.stringify({ method, params: { threadId: "thread-1", ...params } })}\n`);
    emit("turn/plan/updated", { turnId: "turn-1", plan: [{ step: "检查依赖", status: "inProgress" }] });
    await vi.waitFor(() => expect(statuses.some(value => value.activitySummary === "检查依赖")).toBe(true));
    emit("item/started", { item: { id: "command-1", type: "commandExecution", command: "pnpm build" } });
    await vi.waitFor(() => expect(statuses.some(value => value.activitySummary === "执行命令：pnpm build")).toBe(true));
    child.stdout.write(`${JSON.stringify({ id: 42, method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", reason: "等待构建命令确认" } })}\n`);
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ status: "waiting_for_permission", activitySummary: "等待构建命令确认" }));
    service.resolveApproval("run-1", 42, true);
    expect(statuses.at(-1)).toMatchObject({ status: "running" });
    emit("item/commandExecution/outputDelta", { itemId: "command-1", delta: "private output" });
    emit("item/started", { item: { id: "answer-1", type: "agentMessage", text: "" } });
    emit("item/agentMessage/delta", { itemId: "answer-1", delta: "构建" });
    emit("item/agentMessage/delta", { itemId: "answer-1", delta: "通过" });
    await vi.waitFor(() => expect(statuses.some(value => value.activitySummary === "构建通过")).toBe(true));
    expect(statuses.some(value => value.activitySummary?.includes("private output"))).toBe(false);
    emit("turn/completed", { turn: { status: "completed" } });
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ status: "completed", activitySummary: "构建通过" }));
    service.close("run-1");
  });

  it("retains turn IDs for live items and restored history", async () => {
    const child = fakeProcess([], request => request.method === "thread/read" ? { thread: { cwd: "C:\\project" } }
      : request.method === "thread/resume" ? { thread: { id: "history-1", turns: [
        { id: "history-turn-1", items: [{ id: "history-command", type: "commandExecution", command: "pwd" }] },
        { id: "history-turn-2", items: [{ id: "history-answer", type: "agentMessage", text: "完成" }] }
      ] } } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.submit("run-1", "检查项目");
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1",
        item: { id: "live-command", type: "commandExecution", command: "pwd" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "live-command")?.turnId).toBe("turn-1"));
      child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
        item: { id: "live-command", type: "commandExecution", command: "pwd", status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "live-command")).toMatchObject({ turnId: "turn-1", status: "completed" }));
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
      await service.resume("run-1", "history-1");
      expect(service.snapshot("run-1").items.map(item => item.turnId)).toEqual(["history-turn-1", "history-turn-2"]);
    } finally { service.close("run-1"); }
  });

  it("restores and clears summaries for one instance without changing another", async () => {
    const children = [fakeProcess([], request => request.method === "thread/read" ? { thread: { cwd: "C:\\project" } }
      : request.method === "thread/resume" ? { thread: { id: "history-1", turns: [{ items: [
        { id: "answer-1", type: "agentMessage", text: "历史结论" }
      ] }] } } : undefined), fakeProcess([])];
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {},
      spawnProcess: () => children.shift() });
    const session = { type: "windows", shell: "cmd.exe", cwd: "C:\\project" };
    await service.start({ ...session, id: "run-1" });
    await service.start({ ...session, id: "run-2" });
    await service.submit("run-2", "另一个任务");
    await service.resume("run-1", "history-1");
    expect(statuses.at(-1)).toMatchObject({ id: "run-1", activitySummary: "历史结论" });
    await service.newThread("run-1");
    expect(statuses.at(-1)).toMatchObject({ id: "run-1", status: "cleared", activitySummary: undefined });
    expect(statuses.filter(value => value.id === "run-2").at(-1).activitySummary).toBe("另一个任务");
    service.close("run-1"); service.close("run-2");
  });
  it("runs remote App Server over SSH and keeps uploaded attachments available in history", async () => {
    const received = [];
    let remotePath;
    const child = fakeProcess(received, request => request.method === "thread/read"
      ? { thread: { cwd: "/srv/app" } }
      : request.method === "thread/resume" ? { thread: { id: "history-1", turns: [{ items: [{ id: "history-user", type: "userMessage",
        content: [{ type: "text", text: `检查\n\n请读取以下附件文件：${JSON.stringify(remotePath)}` }] }] }] } }
        : undefined);
    const transport = new EventEmitter();
    transport.write = data => child.stdin.write(data);
    transport.close = vi.fn(() => transport.emit("close", 0));
    child.stdout.on("data", data => transport.emit("stdout", data));
    const sshAgentTransport = { createStdioTransport: vi.fn(async () => transport) };
    const stored = new Map();
    const sshFileSystem = { cwd: vi.fn(async () => "/home/user"), mkdir: vi.fn(async () => {}), chmod: vi.fn(async () => {}),
      fastPut: vi.fn(async (_id, source, target) => { stored.set(target, fs.readFileSync(source)); }),
      stat: vi.fn(async (_id, target) => ({ size: stored.get(target).length, isFile: () => true })),
      get: vi.fn(async (_id, target) => stored.get(target)),
      remove: vi.fn(async (_id, target) => { stored.delete(target); }) };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-remote-app-server-"));
    const localPath = path.join(directory, "notes.txt");
    fs.writeFileSync(localPath, "remote notes");
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({ FLAG: "enabled" }) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, sshAgentTransport, sshFileSystem });
    try {
      await service.start({ id: "ssh-1", type: "ssh", cwd: "/srv/app", initialCommand: "echo ready" });
      expect(sshAgentTransport.createStdioTransport).toHaveBeenCalledWith("ssh-1", expect.objectContaining({
        command: expect.stringContaining("codex app-server --stdio") }));
      expect(sshAgentTransport.createStdioTransport.mock.calls[0][1].command).toContain("export FLAG");
      service.allowFiles("ssh-1", [localPath]);
      await service.submit("ssh-1", "检查", [localPath]);
      remotePath = service.snapshot("ssh-1").items[0].attachments[0].path;
      expect(remotePath).toMatch(/^\/home\/user\/\.cache\/pannel-handle\/app-server\//);
      expect(received.find(item => item.method === "turn/start").params.input[0].text).toContain(remotePath);
      expect(await service.previewAttachment("ssh-1", remotePath)).toEqual({ kind: "text", text: "remote notes" });
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("ssh-1").busy).toBe(false));
      await service.resume("ssh-1", "history-1");
      expect(service.snapshot("ssh-1").items[0].attachments[0].path).toBe(remotePath);
      expect(await service.previewAttachment("ssh-1", remotePath)).toEqual({ kind: "text", text: "remote notes" });
      const pastedPath = "/srv/app/.pannel-handle-images/pasted.png";
      stored.set(pastedPath, Buffer.from([137, 80, 78, 71]));
      service.allowPastedImage("ssh-1", pastedPath);
      expect((await service.previewAttachment("ssh-1", pastedPath)).kind).toBe("image");
      await service.discardPastedImage("ssh-1", pastedPath);
      expect(stored.has(pastedPath)).toBe(false);
      service.close("ssh-1");
      expect(stored.has(remotePath)).toBe(true);
    } finally { service.close("ssh-1"); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("removes partially uploaded remote files when an upload fails", async () => {
    const child = fakeProcess([]);
    const transport = new EventEmitter();
    transport.write = data => child.stdin.write(data);
    transport.close = () => transport.emit("close", 0);
    child.stdout.on("data", data => transport.emit("stdout", data));
    const uploaded = [];
    const sshFileSystem = { cwd: async () => "/home/user", mkdir: async () => {}, chmod: async () => {},
      fastPut: vi.fn(async (_id, _source, target) => { uploaded.push(target); throw new Error("disk full"); }),
      remove: vi.fn(async () => {}) };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-remote-failed-upload-"));
    const localPath = path.join(directory, "notes.txt");
    fs.writeFileSync(localPath, "notes");
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
      sshAgentTransport: { createStdioTransport: async () => transport }, sshFileSystem });
    try {
      await service.start({ id: "ssh-1", type: "ssh", cwd: "/srv/app" });
      service.allowFiles("ssh-1", [localPath]);
      await expect(service.submit("ssh-1", "检查", [localPath])).rejects.toThrow("disk full");
      expect(sshFileSystem.remove).toHaveBeenCalledWith("ssh-1", uploaded[0]);
      expect(service.snapshot("ssh-1").busy).toBe(false);
    } finally { service.close("ssh-1"); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("reconnects a remote App Server session and resumes its thread", async () => {
    const received = [];
    const transports = [0, 1].map(() => {
      const child = fakeProcess(received, request => request.method === "thread/resume"
        ? { thread: { id: "thread-1", model: "test-model", turns: [{ items: [
          { id: "previous", type: "agentMessage", text: "之前的回复" }
        ] }] } } : undefined);
      const transport = new EventEmitter();
      transport.write = data => child.stdin.write(data);
      transport.close = () => transport.emit("close", 0);
      child.stdout.on("data", data => transport.emit("stdout", data));
      return transport;
    });
    const session = { id: "ssh-1", type: "ssh", cwd: "/srv/app" };
    const terminalManager = { getSession: () => session, listSessions: () => [session],
      setAppServerConnectionState: vi.fn(), broadcastAgentStatus: () => {} };
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager, broadcast: () => {},
      sshAgentTransport: { createStdioTransport: vi.fn(async () => transports.shift()) } });
    try {
      await service.start(session);
      await expect(service.restart("ssh-1")).resolves.toEqual(session);
      expect(received.some(item => item.method === "thread/resume" && item.params.threadId === "thread-1")).toBe(true);
      expect(service.snapshot("ssh-1").items[0].text).toBe("之前的回复");
      expect(terminalManager.setAppServerConnectionState.mock.calls.map(call => call[1])).toEqual([
        "connected", "reconnecting", "connected"
      ]);
    } finally { service.close("ssh-1"); }
  });
});
