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
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  return child;
}

describe("Codex App Server session", () => {
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
    expect(wsl.args.at(-1)).toContain("export FROM_START=yes");
    expect(wsl.args.at(-1)).toContain("exec codex app-server");
    expect(wsl.env.WSLENV).toContain("CUSTOM/u");
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
    expect(received.find(item => item.method === "turn/start").params.collaborationMode).toEqual({ mode: "default", settings: { model: "test-model", developer_instructions: null } });
    child.stdout.write(`${JSON.stringify({ id: 42, method: "item/commandExecution/requestApproval", params: { command: "pnpm test" } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.snapshot("run-1").approvals).toHaveLength(1);
    service.resolveApproval("run-1", 42, true);
    expect(received.at(-1)).toEqual({ id: 42, result: { decision: "accept" } });
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
        { id: "answer-1", type: "agentMessage", text: "之前的回答" }
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
    expect(restored.items.map(item => item.text)).toEqual(["之前的问题", "之前的回答"]);
    await vi.waitFor(() => expect(received.some(item => item.method === "thread/unsubscribe" && item.params.threadId === "new-thread")).toBe(true));
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
      service.close("run-1");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
