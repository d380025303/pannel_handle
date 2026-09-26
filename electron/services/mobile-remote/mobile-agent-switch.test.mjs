import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import socketModule from "./mobile-socket-handlers.cjs";
import protocolModule from "./mobile-protocol.cjs";

const { createMobileSocketHandlers } = socketModule;
const { PROTOCOL_VERSION } = protocolModule;

function fixture() {
  const savedTemplate = { id: "template-1", agentProvider: "codex" };
  const sessions = new Map([["old", { id: "old", templateId: savedTemplate.id, runtimeMode: "app-server", agentProvider: "codex" }]]);
  const graphicalService = { snapshot: vi.fn(id => ({ threadId: id === "old" ? "thread-1" : "thread-2",
    provider: id === "old" ? "codex" : "codebuddy", busy: false, approvals: [], questions: [], items: [] })) };
  const agentSessionLauncher = { switchAgent: vi.fn(async (id, provider) => {
    sessions.delete(id);
    const replacement = { id: "new", templateId: savedTemplate.id, runtimeMode: "app-server", agentProvider: provider };
    sessions.set(replacement.id, replacement);
    return replacement;
  }) };
  const send = vi.fn();
  const sendError = vi.fn();
  const handlers = createMobileSocketHandlers({
    terminalManager: { getSession: id => sessions.get(id), listSessions: () => [...sessions.values()] },
    sessionStore: { getLibrary: () => [savedTemplate] }, agentSessionLauncher, graphicalService,
    stateHub: {}, now: () => 1, auth: { handleSocketClosed: vi.fn() },
    sizes: { getSizeState: vi.fn(), applySize: vi.fn() }, send, sendError
  });
  const socket = Object.assign(new EventEmitter(), { mobileDevice: { id: "phone-1" } });
  handlers.handleWebSocket(socket, { socket: { remoteAddress: "192.168.1.2" } });
  socket.authenticated = true;
  socket.graphicalSessionId = "old";
  return { socket, send, sendError, agentSessionLauncher, savedTemplate };
}

describe("mobile graphical Agent switch", () => {
  it("selects and subscribes to the replacement without changing the template", async () => {
    const f = fixture();
    f.socket.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, type: "session.switch-agent", sessionId: "old",
      threadId: "thread-1", provider: "codebuddy", requestId: "switch-1" }));
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(f.socket,
      expect.objectContaining({ type: "graphical.snapshot", sessionId: "new" })));
    expect(f.agentSessionLauncher.switchAgent).toHaveBeenCalledWith("old", "codebuddy");
    expect(f.send).toHaveBeenCalledWith(f.socket, { type: "session.launched", sessionId: "new" });
    expect(f.socket.graphicalSessionId).toBe("new");
    expect(f.savedTemplate.agentProvider).toBe("codex");
  });

  it("reports launch errors and keeps the old subscription when launch fails", async () => {
    const f = fixture();
    f.agentSessionLauncher.switchAgent.mockRejectedValue(new Error("目标 Agent 不可用"));
    f.socket.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, type: "session.switch-agent", sessionId: "old",
      threadId: "thread-1", provider: "opencode", requestId: "switch-2" }));
    await vi.waitFor(() => expect(f.sendError).toHaveBeenCalledWith(f.socket, "COMMAND_FAILED",
      "目标 Agent 不可用", "switch-2"));
    expect(f.socket.graphicalSessionId).toBe("old");
    expect(f.send).not.toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "session.launched" }));
  });
});
