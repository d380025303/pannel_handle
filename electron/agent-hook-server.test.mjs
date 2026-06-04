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
    broadcastAgentStatus: vi.fn()
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
});
