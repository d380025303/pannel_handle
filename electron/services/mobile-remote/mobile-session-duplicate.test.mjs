import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import socketModule from "./mobile-socket-handlers.cjs";
import protocolModule from "./mobile-protocol.cjs";

function fixture() {
  const source = { id: "source", runtimeMode: "app-server", agentProvider: "codex" };
  const launcher = { duplicateRunningSession: vi.fn(async () => ({ ...source, id: "copy" })) };
  const send = vi.fn(), sendError = vi.fn();
  const sizes = { getSizeState: vi.fn(), applySize: vi.fn() };
  const handlers = socketModule.createMobileSocketHandlers({
    terminalManager: { getSession: id => id === "source" ? source : undefined },
    sessionStore: {}, agentSessionLauncher: launcher, graphicalService: {}, stateHub: {},
    now: () => 1, auth: { handleSocketClosed: vi.fn() }, sizes, send, sendError
  });
  const socket = Object.assign(new EventEmitter(), { mobileDevice: { id: "phone" } });
  handlers.handleWebSocket(socket, { socket: { remoteAddress: "127.0.0.1" } });
  socket.authenticated = true;
  socket.graphicalSessionId = "source";
  socket.subscriptions.add("terminal-source");
  const request = (requestId = "duplicate-1", sessionId = "source") => socket.emit("message",
    JSON.stringify({ v: protocolModule.PROTOCOL_VERSION, type: "session.duplicate", sessionId, requestId }));
  return { socket, launcher, send, sendError, sizes, request };
}

it("starts a background copy without changing subscriptions or selecting it", async () => {
  const f = fixture(); f.request();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(f.socket, { type: "command.ok", requestId: "duplicate-1", sessionId: "copy" }));
  expect(f.launcher.duplicateRunningSession).toHaveBeenCalledWith("source");
  expect(f.socket.graphicalSessionId).toBe("source");
  expect([...f.socket.subscriptions]).toEqual(["terminal-source"]);
  expect(f.sizes.applySize).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalledWith(f.socket, expect.objectContaining({ type: "session.launched" }));
});

it("rejects closed sources and invalid requests before launching", async () => {
  const f = fixture(); f.request("closed", "missing"); f.request("");
  await vi.waitFor(() => expect(f.sendError).toHaveBeenCalledTimes(2));
  expect(f.sendError).toHaveBeenCalledWith(f.socket, "COMMAND_FAILED", "源会话已关闭，无法复制。", "closed");
  expect(f.launcher.duplicateRunningSession).not.toHaveBeenCalled();
});

it("blocks concurrent copies and allows retry after a launch error", async () => {
  const f = fixture();
  let reject;
  f.launcher.duplicateRunningSession.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  f.request(); f.request("duplicate-2");
  await vi.waitFor(() => expect(f.sendError).toHaveBeenCalledWith(f.socket, "COMMAND_FAILED", "该会话正在复制，请稍候。", "duplicate-2"));
  expect(f.launcher.duplicateRunningSession).toHaveBeenCalledTimes(1);
  reject(new Error("启动失败"));
  await vi.waitFor(() => expect(f.sendError).toHaveBeenCalledWith(f.socket, "COMMAND_FAILED", "启动失败", "duplicate-1"));
  f.request("retry");
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(f.socket, { type: "command.ok", requestId: "retry", sessionId: "copy" }));
  expect(f.socket.graphicalSessionId).toBe("source");
});
