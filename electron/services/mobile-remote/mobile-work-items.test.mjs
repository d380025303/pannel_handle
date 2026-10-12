import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import socketModule from "./mobile-socket-handlers.cjs";

function fixture() {
  const service = Object.fromEntries(["list", "get", "preview", "execute", "setFollowUp", "listAttempts", "getAttempt", "void", "restore", "resolveUncertain"].map(name => [name, vi.fn(async input => ({ name, input }))]));
  const send = vi.fn(), sendError = vi.fn();
  const handlers = socketModule.createMobileSocketHandlers({ getWorkItems: () => service, sizes: {}, now: Date.now, send, sendError, auth: {}, terminalManager: {} });
  const socket = new EventEmitter();
  handlers.handleWebSocket(socket, { socket: {} });
  const request = (operation, input = { id: "task", version: 3 }) => socket.emit("message", JSON.stringify({ v: 8, type: "work-items.request", requestId: "req", operation, input }));
  return { service, send, sendError, socket, request };
}

it("requires authentication before accessing task data", () => {
  const f = fixture(); f.request("list");
  expect(f.service.list).not.toHaveBeenCalled();
  expect(f.sendError).toHaveBeenCalledWith(f.socket, "AUTH_REQUIRED", expect.any(String));
});
it("routes every allowed task operation with correlated responses", async () => {
  const f = fixture(); f.socket.authenticated = true;
  for (const operation of Object.keys(f.service)) {
    f.request(operation);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(f.socket, { type: "work-items.result", requestId: "req", result: { name: operation, input: { id: "task", version: 3 } } }));
  }
});
it("rejects arbitrary methods and returns service validation conflicts", async () => {
  const f = fixture(); f.socket.authenticated = true;
  f.request("constructor");
  expect(f.sendError).toHaveBeenCalledWith(f.socket, "WORK_ITEM_COMMAND_FAILED", expect.any(String), "req");
  f.service.execute.mockRejectedValueOnce(new Error("任务已变更，请刷新")); f.request("execute");
  await vi.waitFor(() => expect(f.sendError).toHaveBeenCalledWith(f.socket, "WORK_ITEM_COMMAND_FAILED", "任务已变更，请刷新", "req"));
});
