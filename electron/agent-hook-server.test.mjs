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
      resolution: "provide_input"
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
