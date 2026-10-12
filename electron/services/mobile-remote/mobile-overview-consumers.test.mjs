import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileRemoteService, PROTOCOL_VERSION } from "./mobile-remote-service.cjs";
import { createTerminalStateHub } from "../../terminal/terminal-state-hub.cjs";

afterEach(() => vi.useRealTimers());

function fixture({ enabled = true, stateHub, count = 1 } = {}) {
  const sessions = Array.from({ length: count }, (_, index) => ({ id: `run-${index}`, cols: 80, rows: 24 }));
  const hub = stateHub || { write: vi.fn(), getText: vi.fn(async () => text), resize: vi.fn() };
  let text = "initial";
  const servers = [];
  let nextSocket;
  const service = createMobileRemoteService({
    terminalManager: { listSessions: () => sessions, getSession: id => sessions.find(session => session.id === id) },
    stateHub: hub, sessionStore: { getLibrary: () => [] },
    accessStore: { getConfig: () => ({ enabled, port: 43123 }), verifyPassword: () => true, recordAudit: vi.fn(), listAudit: () => [] },
    desktopBroadcast: vi.fn(), notifyConnection: vi.fn(), getStaticRoot: () => ".", networkInterfaces: () => ({}),
    createHttpServer: () => {
      const server = Object.assign(new EventEmitter(), {
        listening: false,
        listen: () => { server.listening = true; server.emit("listening"); },
        close: callback => { server.listening = false; callback(); }
      });
      servers.push(server);
      return server;
    },
    createWebSocketServer: () => ({ clients: new Set(), close: vi.fn(), handleUpgrade: (_request, _socket, _head, callback) => callback(nextSocket) })
  });
  function connect(authenticate = true) {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), ping: vi.fn() });
    nextSocket = socket;
    servers[0].emit("upgrade", { url: "/api/v1/ws", headers: { host: "127.0.0.1:43123" }, socket: { remoteAddress: "127.0.0.1" } }, {}, Buffer.alloc(0));
    if (authenticate) socket.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, type: "password.login", password: "correct" }));
    return socket;
  }
  return { service, hub, sessions, connect, setText: value => { text = value; }, output: (id = sessions[0].id, data = "output\r\n") => service.handleDesktopEvent("terminal:data", { id, data }) };
}

function summaries(socket) {
  return socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(message => message.type === "session.overview").map(message => message.overview.summary);
}

describe("mobile overview consumers", () => {
  it.each([false, true])("does not read summaries for 20 terminals without clients (enabled=%s)", async enabled => {
    vi.useFakeTimers();
    const hub = createTerminalStateHub();
    const getText = vi.spyOn(hub, "getText");
    const f = fixture({ enabled, stateHub: hub, count: 20 });
    try {
      await f.service.start();
      for (let round = 0; round < 3; round++) {
        for (const session of f.sessions) f.output(session.id);
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(getText).not.toHaveBeenCalled();
      expect(hub.getDeltas("run-0", 0)).toHaveLength(3);
      await f.service.stop();
      f.output();
      await vi.advanceTimersByTimeAsync(300);
      expect(getText).not.toHaveBeenCalled();
    } finally {
      await f.service.stop();
      hub.shutdown();
    }
  });

  it("sends fresh summaries on reconnect and does not suppress updates with an old cache", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.service.start();
      const unauthenticated = f.connect(false);
      f.output();
      await vi.advanceTimersByTimeAsync(300);
      expect(f.hub.getText).not.toHaveBeenCalled();
      unauthenticated.emit("close");
      const first = f.connect();
      await vi.advanceTimersByTimeAsync(0);
      f.setText("A");
      f.output();
      await vi.advanceTimersByTimeAsync(300);
      expect(summaries(first)).toEqual(["initial", "A"]);
      f.output();
      first.emit("close");
      f.hub.getText.mockClear();
      await vi.advanceTimersByTimeAsync(300);
      expect(f.hub.getText).not.toHaveBeenCalled();
      f.setText("B");
      f.output();
      await vi.advanceTimersByTimeAsync(300);
      expect(f.hub.getText).not.toHaveBeenCalled();
      const second = f.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(summaries(second)).toEqual(["B"]);
      f.setText("A");
      f.output();
      await vi.advanceTimersByTimeAsync(300);
      expect(summaries(second)).toEqual(["B", "A"]);
    } finally { await f.service.stop(); }
  });

  it("discards an in-flight summary after all clients disconnect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.service.start();
      const client = f.connect();
      await vi.advanceTimersByTimeAsync(0);
      let resolveText;
      f.hub.getText.mockImplementationOnce(() => new Promise(resolve => { resolveText = resolve; }));
      f.output();
      await vi.advanceTimersByTimeAsync(300);
      client.emit("close");
      resolveText("discarded");
      await vi.advanceTimersByTimeAsync(0);
      expect(summaries(client)).toEqual(["initial"]);
    } finally { await f.service.stop(); }
  });
});
