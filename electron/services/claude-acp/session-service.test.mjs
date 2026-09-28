import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const { createClaudeAcpSessionService, buildInvocation } = require("./session-service.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.stdin.on("data", chunk => onMessage(JSON.parse(String(chunk)), value => child.stdout.write(`${JSON.stringify(value)}\n`)));
  return child;
}

describe("Claude ACP sessions", () => {
  it("launches the adapter on Windows and WSL and routes graphical calls", () => {
    expect(buildInvocation({ type: "windows", cwd: "C:\\work", shell: "powershell.exe" }, {}, {}).args.at(-1)).toContain("claude-agent-acp");
    expect(buildInvocation({ type: "wsl", cwd: "/work", wslDistro: "Ubuntu" }, {}, {}).args.at(-1)).toContain("exec claude-agent-acp");
    const codex = { close: vi.fn(), shutdown: vi.fn() };
    const buddy = { close: vi.fn(), shutdown: vi.fn() };
    const claude = { snapshot: vi.fn(() => "claude"), close: vi.fn(), shutdown: vi.fn() };
    const router = createGraphicalSessionRouter(codex, buddy, { getSession: () => ({ agentProvider: "claude" }) }, null, claude);
    expect(router.snapshot("one")).toBe("claude");
    router.close("one");
    expect(claude.close).toHaveBeenCalledWith("one");
  });

  it("uses existing credentials, supports model and form questions, and preserves ACP permission ids", async () => {
    const messages = [];
    let emitMessage;
    const child = fakeChild((message, emit) => {
      messages.push(message); emitMessage = emit;
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread",
        configOptions: [{ id: "model", type: "select", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] }],
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Manual" }, { id: "plan", name: "Plan" }] } } });
      else if (message.method === "session/set_config_option") emit({ id: message.id, result: { configOptions: [
        { id: "model", type: "select", currentValue: message.params.value, options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] }
      ] } });
    });
    const service = createClaudeAcpSessionService({ environmentService: { resolve: () => ({ ANTHROPIC_API_KEY: "secret" }) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await service.start({ id: "one", type: "windows", cwd: "C:\\work" });
    expect(messages[0].params.clientCapabilities.elicitation).toEqual({ form: {} });
    expect(service.snapshot("one").provider).toBe("claude");
    expect((await service.setModel("one", "opus")).acpOptions[0].currentValue).toBe("opus");
    emitMessage({ id: 42, method: "elicitation/create", params: { sessionId: "thread", mode: "form", message: "选择方案",
      requestedSchema: { type: "object", required: ["strategy"], properties: { strategy: { type: "string", title: "方案",
        oneOf: [{ const: "safe", title: "稳妥" }, { const: "fast", title: "快速" }] } } } } });
    expect(service.snapshot("one").questions[0].params.questions[0].options[0].label).toBe("稳妥");
    await service.answerQuestion("one", 42, { strategy: { answers: ["稳妥"] } });
    expect(messages.find(value => value.id === 42).result).toEqual({ action: "accept", content: { strategy: "safe" } });
    emitMessage({ id: 44, method: "elicitation/create", params: { sessionId: "thread", mode: "form", message: "选择方案",
      requestedSchema: { type: "object", properties: {
        question_0: { type: "string", title: "方案", oneOf: [{ const: "稳妥", title: "稳妥" }] },
        question_0_custom: { type: "string", title: "Other", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } } }
      } } } });
    expect(service.snapshot("one").questions[0].params.questions).toHaveLength(1);
    await service.answerQuestion("one", 44, { question_0: { answers: ["自行设计"] } });
    expect(messages.find(value => value.id === 44).result).toEqual({ action: "accept", content: { question_0_custom: "自行设计" } });
    emitMessage({ id: 43, method: "session/request_permission", params: { sessionId: "thread", toolCall: { toolCallId: "tool", title: "修改文件" },
      options: [{ optionId: "allow-once", kind: "allow_once", name: "仅一次" }, { optionId: "reject", kind: "reject_once", name: "拒绝" }] } });
    await service.resolveApproval("one", 43, "reject");
    expect(messages.find(value => value.id === 43).result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    service.shutdown();
  });

  it("keeps local SSH bridge operations remote-only in the adapter session", async () => {
    const messages = [];
    const child = fakeChild((message, emit) => {
      messages.push(message);
      if (message.method === "initialize") emit({ id: message.id, result: { agentCapabilities: {} } });
      else if (message.method === "session/new") emit({ id: message.id, result: { sessionId: "thread" } });
    });
    const service = createClaudeAcpSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: vi.fn() }, broadcast: vi.fn(), spawnProcess: () => child });
    await expect(service.start({ id: "missing", type: "ssh", cwd: "/srv/app" }, { localBridge: true })).rejects.toThrow("缺少受限远端工具配置");
    await service.start({ id: "ssh", type: "ssh", cwd: "/srv/app" }, { localBridge: true, workspaceCwd: "C:\\bridge",
      remoteBridge: { url: "http://127.0.0.1:1234/mcp", token: "secret", instructions: "Use remote tools" } });
    const params = messages.find(value => value.method === "session/new").params;
    expect(params.mcpServers[0]).toMatchObject({ name: "pannel_handle_remote", type: "http" });
    expect(params._meta.claudeCode.options.disallowedTools).toContain("Bash");
    expect(params._meta.claudeCode.options.allowDangerouslySkipPermissions).toBe(false);
    service.shutdown();
  });
});
