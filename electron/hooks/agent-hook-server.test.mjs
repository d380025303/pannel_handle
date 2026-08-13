import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAgentHookServer } = require("./agent-hook-server.cjs");

function createServer() {
  const session = {
    id: "run-1",
    cwd: "C:\\work"
  };
  const terminalManager = {
    getSession: vi.fn((id) => id === session.id ? session : undefined),
    getSessions: vi.fn(() => [session]),
    broadcastAgentStatus: vi.fn(),
    broadcastAgentHookDebug: vi.fn()
  };
  const server = createAgentHookServer({ terminalManager });

  return { server, session, terminalManager };
}

describe("agent-hook-server", () => {
  it("maps Codex PermissionRequest to waiting_for_permission", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("codex", {
      hook_event_name: "PermissionRequest",
      session_id: "codex-1",
      pannel_handle_session_id: "run-1",
      tool_name: "Bash"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "codex",
      status: "waiting_for_permission",
      eventName: "PermissionRequest",
      toolName: "Bash"
    }));
  });

  it("maps Codex PreToolUse request_user_input to waiting_for_permission", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("codex", {
      hook_event_name: "PreToolUse",
      session_id: "codex-1",
      pannel_handle_session_id: "run-1",
      tool_name: "request_user_input"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "codex",
      status: "waiting_for_permission",
      eventName: "PreToolUse",
      toolName: "request_user_input"
    }));
  });

  it("maps Codex ordinary PreToolUse to running", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("codex", {
      hook_event_name: "PreToolUse",
      session_id: "codex-1",
      pannel_handle_session_id: "run-1",
      tool_name: "shell_command"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "codex",
      status: "running",
      eventName: "PreToolUse",
      toolName: "shell_command"
    }));
  });

  it("maps Codex Stop to completed", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("codex", {
      hook_event_name: "Stop",
      session_id: "codex-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "codex",
      status: "completed",
      eventName: "Stop"
    }));
  });

  it("maps Codex clear SessionStart to cleared without an activity summary", () => {
    const { server, session, terminalManager } = createServer();

    const handled = server.handleAgentHook("codex", {
      hook_event_name: "SessionStart",
      source: "clear",
      model: "gpt-5.6",
      session_id: "codex-2",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(session.agentStatus).toBe("cleared");
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith({
      id: "run-1",
      provider: "codex",
      status: "cleared",
      eventName: "SessionStart",
      message: undefined,
      toolName: undefined,
      toolInput: undefined,
      activitySummary: undefined
    });
  });

  it.each([
    ["UserPromptSubmit", { prompt: "分析登录失败原因" }, "分析登录失败原因"],
    ["PreToolUse", { tool_name: "shell_command", tool_input: { command: "pnpm test" } }, "shell_command: {\"command\":\"pnpm test\"}"],
    ["PermissionRequest", { tool_name: "shell_command", tool_input: { command: "git push" } }, "shell_command: {\"command\":\"git push\"}"],
    ["PostToolUse", { tool_name: "shell_command", tool_response: { exitCode: 0 } }, "shell_command: {\"exitCode\":0}"],
    ["Stop", { last_assistant_message: "已完成登录页修复" }, "已完成登录页修复"],
    ["SessionStart", { model: "gpt-5.6", source: "startup" }, "gpt-5.6 · startup"]
  ])("extracts Codex activity summary from %s", (eventName, extra, expectedSummary) => {
    const { server, terminalManager } = createServer();

    server.handleAgentHook("codex", {
      hook_event_name: eventName,
      session_id: "codex-1",
      pannel_handle_session_id: "run-1",
      ...extra
    });

    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      activitySummary: expectedSummary
    }));
  });

  it("truncates oversized activity summaries", () => {
    const { server, terminalManager } = createServer();

    server.handleAgentHook("codex", {
      hook_event_name: "UserPromptSubmit",
      prompt: "x".repeat(600),
      session_id: "codex-1",
      pannel_handle_session_id: "run-1"
    });

    const payload = terminalManager.broadcastAgentStatus.mock.calls[0][0];
    expect(payload.activitySummary).toHaveLength(500);
    expect(payload.activitySummary.endsWith("…")).toBe(true);
  });

  it("recovers malformed Codex Stop hook payloads from raw_input", () => {
    const { server, terminalManager } = createServer();
    const rawInput = "{\"session_id\":\"codex-1\",\"turn_id\":\"turn-1\",\"cwd\":\"C:\\\\work\",\"hook_event_name\":\"Stop\",\"last_assistant_message\":\"unterminated";

    const handled = server.handleAgentHookDebug("codex", {
      parse_error: "Unterminated string passed in",
      raw_input: rawInput,
      cwd: "C:\\work",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "codex",
      status: "completed",
      eventName: "Stop"
    }));
    expect(terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      eventName: "Stop",
      matchedSessionId: "run-1",
      handled: true,
      payload: expect.objectContaining({
        parse_error: "Unterminated string passed in",
        raw_input: rawInput,
        hook_event_name: "Stop",
        session_id: "codex-1",
        recovered_from_raw_input: true
      })
    }));
  });

  it("recovers malformed Codex PreToolUse request_user_input payloads from raw_input", () => {
    const { server, terminalManager } = createServer();
    const rawInput = "{\"session_id\":\"codex-1\",\"turn_id\":\"turn-1\",\"cwd\":\"C:\\\\work\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"request_user_input\",\"tool_input\":{\"questions\":[{\"header\":\"broken\",\"description\":\"unterminated";

    const handled = server.handleAgentHookDebug("codex", {
      parse_error: "Invalid object passed in",
      raw_input: rawInput,
      cwd: "C:\\work",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "codex",
      status: "waiting_for_permission",
      eventName: "PreToolUse",
      toolName: "request_user_input"
    }));
    expect(terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      eventName: "PreToolUse",
      matchedSessionId: "run-1",
      handled: true,
      payload: expect.objectContaining({
        parse_error: "Invalid object passed in",
        raw_input: rawInput,
        hook_event_name: "PreToolUse",
        session_id: "codex-1",
        tool_name: "request_user_input",
        recovered_from_raw_input: true
      })
    }));
  });

  it("recovers a prompt summary from malformed Codex raw_input", () => {
    const { server, terminalManager } = createServer();
    const rawInput = "{\"session_id\":\"codex-1\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"检查构建失败\",\"broken\":";

    server.handleAgentHookDebug("codex", {
      parse_error: "Invalid object passed in",
      raw_input: rawInput,
      cwd: "C:\\work",
      pannel_handle_session_id: "run-1"
    });

    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "UserPromptSubmit",
      activitySummary: "检查构建失败"
    }));
  });

  it("keeps malformed Codex payloads unhandled when no event can be recovered", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHookDebug("codex", {
      parse_error: "Unterminated string passed in",
      raw_input: "{\"session_id\":\"codex-1\",\"last_assistant_message\":\"unterminated",
      cwd: "C:\\work",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(false);
    expect(terminalManager.broadcastAgentStatus).not.toHaveBeenCalled();
    expect(terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      eventName: "Unknown",
      matchedSessionId: "run-1",
      handled: false
    }));
  });

  it("ignores unknown Codex events", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("codex", {
      hook_event_name: "UnknownEvent",
      session_id: "codex-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(false);
    expect(terminalManager.broadcastAgentStatus).not.toHaveBeenCalled();
  });

  it("broadcasts raw hook debug events even when the status event is unknown", () => {
    const { server, terminalManager } = createServer();
    const payload = {
      hook_event_name: "UnknownEvent",
      session_id: "codex-1",
      pannel_handle_session_id: "run-1",
      custom_value: "visible in debug"
    };

    const handled = server.handleAgentHookDebug("codex", payload);

    expect(handled).toBe(false);
    expect(terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith({
      provider: "codex",
      eventName: "UnknownEvent",
      matchedSessionId: "run-1",
      handled: false,
      payload
    });
    expect(terminalManager.broadcastAgentStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["session.status", { status: { type: "busy" } }, "running"],
    ["tool.execute.before", { tool_name: "bash" }, "running"],
    ["permission.asked", { tool_name: "bash" }, "waiting_for_permission"],
    ["permission.updated", {}, "waiting_for_permission"],
    ["session.idle", {}, "completed"],
    ["session.error", { error: "failed" }, "failed"],
    ["session.deleted", {}, "ended"]
  ])("maps OpenCode %s to %s", (eventName, extra, expectedStatus) => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("opencode", {
      event_name: eventName,
      session_id: "opencode-1",
      pannel_handle_session_id: "run-1",
      ...extra
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "opencode",
      status: expectedStatus,
      eventName
    }));
  });

  it.each([
    ["tool.execute.before", { tool_name: "bash", tool_input: { command: "pnpm build" } }, "bash: {\"command\":\"pnpm build\"}"],
    ["tool.execute.after", { tool_name: "bash", success: false, error: { message: "exit code 1" } }, "bash: exit code 1"],
    ["permission.asked", { permission: "external_directory" }, "external_directory"],
    ["session.error", { error: "connection lost" }, "connection lost"]
  ])("extracts OpenCode activity summary from %s", (eventName, extra, expectedSummary) => {
    const { server, terminalManager } = createServer();

    server.handleAgentHook("opencode", {
      event_name: eventName,
      session_id: "opencode-1",
      pannel_handle_session_id: "run-1",
      ...extra
    });

    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      activitySummary: expectedSummary
    }));
  });

  it("broadcasts unknown OpenCode events only to debug", () => {
    const { server, terminalManager } = createServer();
    const payload = {
      event_name: "message.updated",
      session_id: "opencode-1",
      pannel_handle_session_id: "run-1"
    };

    const handled = server.handleAgentHookDebug("opencode", payload);

    expect(handled).toBe(false);
    expect(terminalManager.broadcastAgentStatus).not.toHaveBeenCalled();
    expect(terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith({
      provider: "opencode",
      eventName: "message.updated",
      matchedSessionId: "run-1",
      handled: false,
      payload
    });
  });

  it.each([
    ["SessionStart", {}, "running"],
    ["UserPromptSubmit", {}, "running"],
    ["PreToolUse", { tool_name: "Bash" }, "running"],
    ["PermissionRequest", { tool_name: "Bash" }, "waiting_for_permission"],
    ["Notification", { notification_type: "permission_prompt" }, "waiting_for_permission"],
    ["Notification", { notification_type: "idle_prompt" }, "e_prompt"],
    ["PostToolUse", {}, "running"],
    ["PostToolUse", { is_error: true }, "failed"],
    ["PostToolUseFailure", {}, "failed"],
    ["Stop", {}, "completed"],
    ["SessionEnd", {}, "ended"]
  ])("maps Qoder %s to %s", (eventName, extra, expectedStatus) => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("qoder", {
      hook_event_name: eventName,
      session_id: "qoder-1",
      pannel_handle_session_id: "run-1",
      ...extra
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "qoder",
      status: expectedStatus,
      eventName
    }));
  });

  it("extracts Qoder prompt activity summary", () => {
    const { server, terminalManager } = createServer();

    server.handleAgentHook("qoder", {
      hook_event_name: "UserPromptSubmit",
      prompt: "重构会话侧栏",
      session_id: "qoder-1",
      pannel_handle_session_id: "run-1"
    });

    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      activitySummary: "重构会话侧栏"
    }));
  });

  it("broadcasts unknown Qoder events only to debug", () => {
    const { server, terminalManager } = createServer();
    const payload = {
      hook_event_name: "UnknownEvent",
      session_id: "qoder-1",
      pannel_handle_session_id: "run-1"
    };

    const handled = server.handleAgentHookDebug("qoder", payload);

    expect(handled).toBe(false);
    expect(terminalManager.broadcastAgentStatus).not.toHaveBeenCalled();
    expect(terminalManager.broadcastAgentHookDebug).toHaveBeenCalledWith({
      provider: "qoder",
      eventName: "UnknownEvent",
      matchedSessionId: "run-1",
      handled: false,
      payload
    });
  });

  it("maps Claude Notification+idle_prompt to e_prompt", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("claude", {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "claude",
      status: "e_prompt",
      eventName: "Notification"
    }));
  });

  it("maps Claude Stop to completed with resolution none", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("claude", {
      hook_event_name: "Stop",
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "claude",
      status: "completed",
      eventName: "Stop",
      resolution: "none"
    }));
  });

  it("maps Claude StopFailure to failed with resolution none", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("claude", {
      hook_event_name: "StopFailure",
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "claude",
      status: "failed",
      eventName: "StopFailure",
      resolution: "none"
    }));
  });

  it("maps Claude SessionEnd to ended with resolution none", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("claude", {
      hook_event_name: "SessionEnd",
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "claude",
      status: "ended",
      eventName: "SessionEnd",
      resolution: "none"
    }));
  });

  it("maps Claude PostToolUse (failure) to failed with resolution provide_input", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("claude", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      is_error: true,
      error: { message: "Command failed with exit code 1" },
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "claude",
      status: "failed",
      eventName: "PostToolUse",
      toolName: "Bash",
      activitySummary: "Bash: Command failed with exit code 1",
      resolution: "provide_input"
    }));
  });

  it("extracts Claude notification activity summary", () => {
    const { server, terminalManager } = createServer();

    server.handleAgentHook("claude", {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "需要访问工作区外目录",
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      activitySummary: "需要访问工作区外目录"
    }));
  });

  it("maps Claude PostToolUse (success) to running", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("claude", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: "echo hello",
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(true);
    expect(terminalManager.broadcastAgentStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      provider: "claude",
      status: "running",
      eventName: "PostToolUse",
      toolName: "Bash"
    }));
  });

  it("ignores unknown Claude events", () => {
    const { server, terminalManager } = createServer();

    const handled = server.handleAgentHook("claude", {
      hook_event_name: "UnknownEvent",
      session_id: "claude-1",
      pannel_handle_session_id: "run-1"
    });

    expect(handled).toBe(false);
    expect(terminalManager.broadcastAgentStatus).not.toHaveBeenCalled();
  });
});
