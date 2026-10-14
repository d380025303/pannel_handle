import { EventEmitter, once } from "node:events";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import socketModule from "./mobile-socket-handlers.cjs";
import protocolModule from "./mobile-protocol.cjs";
import hubModule from "../../terminal/terminal-state-hub.cjs";
import httpModule from "./mobile-http.cjs";

const hubs = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.shutdown(); });

describe("mobile graphical submit text policy", () => {
  it.each(["graphical.submit", "quick-command.invoke"])("validates UTF-8 bytes and empty text through %s", async type => {
    const session = { id: "graph", runtimeMode: "app-server", quickCommands: [{ id: "quick", mode: "auto-enter", command: "" }] };
    const submit = vi.fn();
    const send = vi.fn();
    const sendError = vi.fn();
    const handlers = socketModule.createMobileSocketHandlers({
      terminalManager: { getSession: () => session },
      graphicalService: { snapshot: () => ({ threadId: "thread", provider: "codex" }), submit },
      stateHub: {}, now: Date.now, auth: {}, sizes: {}, send, sendError
    });
    const socket = new EventEmitter();
    handlers.handleWebSocket(socket, { socket: { remoteAddress: "127.0.0.1" } });
    socket.authenticated = true;
    socket.graphicalSessionId = session.id;
    const invoke = async text => {
      submit.mockClear();
      send.mockClear();
      sendError.mockClear();
      session.quickCommands[0].command = text;
      socket.emit("message", JSON.stringify({ v: protocolModule.PROTOCOL_VERSION, type,
        sessionId: session.id, threadId: "thread", commandId: "quick", text, requestId: "submit" }));
      await vi.waitFor(() => expect(send.mock.calls.length + sendError.mock.calls.length).toBe(1));
    };
    for (const text of ["中".repeat(6000), "中".repeat(5461) + "aa", " \n\t "]) {
      await invoke(text);
      expect(sendError).toHaveBeenCalledExactlyOnceWith(socket, "GRAPHICAL_COMMAND_FAILED", "消息为空或过长。", "submit");
      expect(submit).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
    const boundary = "中".repeat(5461) + "a";
    expect(Buffer.byteLength(boundary, "utf8")).toBe(16 * 1024);
    await invoke(` ${boundary} \n`);
    expect(submit).toHaveBeenCalledExactlyOnceWith(session.id, boundary, []);
    expect(sendError).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(socket, { type: "command.ok", requestId: "submit" });
  });
});

it("isolates an unauthenticated unmasked frame and keeps HTTP and another websocket available", async () => {
  let port;
  const closed = vi.fn();
  const uploads = { releaseSocket: vi.fn() };
  const files = { releaseSocket: vi.fn() };
  const handlers = socketModule.createMobileSocketHandlers({
    terminalManager: {}, stateHub: {}, now: Date.now, sizes: {}, uploads, files,
    auth: {
      handleSocketClosed: closed,
      handlePasswordLogin: socket => { socket.authenticated = true; }
    },
    send: (socket, message) => socket.send(JSON.stringify(message)), sendError: vi.fn()
  });
  const { handleHttp, verifyRequestHost } = httpModule.createMobileHttpHandler({
    accessStore: { getConfig: () => ({ port }) }, getAddress: () => "127.0.0.1", getStaticRoot: () => "."
  });
  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", handlers.handleWebSocket);
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/v1/ws" || !verifyRequestHost(request)) return socket.destroy();
    wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
  });
  const clients = [];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;
    const connect = async () => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
      clients.push(client);
      await once(client, "open");
      return client;
    };
    const healthy = await connect();
    healthy.send(JSON.stringify({ v: protocolModule.PROTOCOL_VERSION, type: "password.login" }));
    const ping = async at => {
      const message = once(healthy, "message");
      healthy.send(JSON.stringify({ v: protocolModule.PROTOCOL_VERSION, type: "ping", at }));
      expect(JSON.parse(String((await message)[0]))).toEqual({ type: "pong", at });
    };
    await ping(1);
    const invalid = await connect();
    const disconnected = once(invalid, "close");
    // Real TCP bytes: FIN text frame, one byte payload, deliberately no client mask.
    invalid._socket.write(Buffer.from([0x81, 0x01, 0x61]));
    await disconnected;
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    const failedSocket = closed.mock.calls[0][0];
    expect(failedSocket.authenticated).toBe(false);
    expect(failedSocket.mobileCloseReason).toBe("socket-error-WS_ERR_EXPECTED_MASK");
    expect(uploads.releaseSocket).toHaveBeenCalledExactlyOnceWith(failedSocket);
    expect(files.releaseSocket).toHaveBeenCalledExactlyOnceWith(failedSocket);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    await ping(2);
    expect(healthy.readyState).toBe(WebSocket.OPEN);
  } finally {
    for (const client of clients) client.terminate();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

function fixture() {
  const stateHub = hubModule.createTerminalStateHub();
  hubs.push(stateHub);
  stateHub.start("one");
  stateHub.start("two");
  const messages = [];
  const sendError = vi.fn();
  const handlers = socketModule.createMobileSocketHandlers({
    terminalManager: {
      getSession: id => ({ id, runtimeMode: "terminal" }),
      listSessions: () => [{ id: "one", runtimeMode: "terminal", type: "windows" }]
    },
    sessionStore: { getLibrary: () => [] },
    stateHub, now: () => 1, auth: { handleSocketClosed: vi.fn() },
    sizes: { getSizeState: () => ({ owner: "desktop", cols: 100, rows: 30 }) },
    send: (_socket, message) => messages.push(message), sendError
  });
  const socket = Object.assign(new EventEmitter(), { mobileDevice: { id: "phone" } });
  handlers.handleWebSocket(socket, { socket: { remoteAddress: "192.168.1.2" } });
  socket.authenticated = true;
  const subscribe = (sessionId = "one", lastSeq) => socket.emit("message", JSON.stringify({
    v: protocolModule.PROTOCOL_VERSION, type: "terminal.subscribe", sessionId, lastSeq
  }));
  const write = (data, sessionId = "one") => {
    const seq = stateHub.write(sessionId, data);
    handlers.handleTerminalData(socket, { type: "terminal.data", sessionId, data, seq });
  };
  const unsubscribe = (sessionId = "one") => socket.emit("message", JSON.stringify({
    v: protocolModule.PROTOCOL_VERSION, type: "terminal.unsubscribe", sessionId
  }));
  return { stateHub, messages, socket, subscribe, unsubscribe, write, sendError, handlers };
}

describe("mobile terminal subscription ordering", () => {
  it("stops all 1024 output frames after unsubscribe and restores the next snapshot", async () => {
    const f = fixture();
    f.subscribe("one", 0);
    f.write("LIVE");
    expect(f.messages.at(-1)).toMatchObject({ type: "terminal.data", data: "LIVE" });
    f.unsubscribe();
    f.messages.length = 0;
    for (let index = 0; index < 1024; index++) f.write("x".repeat(1024));
    expect(f.messages).toEqual([]);
    expect(f.socket.authenticated).toBe(true);
    f.subscribe();
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    expect(f.messages[0]).toMatchObject({ type: "terminal.snapshot", snapshot: { seq: 1025 } });
    f.write("RESUMED");
    expect(f.messages.at(-1)).toMatchObject({ type: "terminal.data", data: "RESUMED" });
    expect(f.sendError).not.toHaveBeenCalled();
  });

  it("still sends the homepage overview after unsubscribing", async () => {
    const f = fixture();
    f.subscribe("one", 0);
    f.unsubscribe();
    f.messages.length = 0;
    f.write("HOMEPAGE SUMMARY\r\n");
    f.handlers.sendReady(f.socket);
    await vi.waitFor(() => expect(f.messages.some(message => message.type === "session.overview")).toBe(true));
    expect(f.messages.find(message => message.type === "session.overview")).toMatchObject({
      overview: { sessionId: "one", summary: "HOMEPAGE SUMMARY" }
    });
    expect(f.messages.some(message => message.type === "terminal.data")).toBe(false);
  });

  it("keeps a newer session's pending snapshot and output when the old session unsubscribes", async () => {
    const f = fixture();
    f.subscribe("one", 0);
    f.subscribe("two");
    f.unsubscribe("one");
    f.write("NEW", "two");
    await vi.waitFor(() => expect(f.messages.some(message => message.type === "terminal.snapshot")).toBe(true));
    expect(f.messages.filter(message => message.type === "terminal.data")).toEqual([
      { type: "terminal.data", sessionId: "two", data: "NEW", seq: 1 }
    ]);
    expect(f.socket.subscriptions.has("two")).toBe(true);
  });

  it("includes scrollback in the first mobile subscription", async () => {
    const f = fixture();
    f.stateHub.start("one", 40, 3);
    const expectedLines = Array.from({ length: 12 }, (_, index) => `LINE_${index + 1}`);
    for (const line of expectedLines) f.write(`${line}\r\n`);

    f.subscribe();
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    expect(f.messages[0]).toMatchObject({ type: "terminal.snapshot", snapshot: { seq: 12 } });
    expect(f.messages[0].snapshot.ansi.match(/LINE_\d+/g)).toEqual(expectedLines);
    expect(f.sendError).not.toHaveBeenCalled();
  });

  it("sends the initial snapshot before concurrent output and displays each chunk once", async () => {
    const f = fixture();
    f.write("BEFORE\r\n");
    f.subscribe();
    f.write("AFTER\r\n");
    expect(f.messages).toEqual([]);
    await vi.waitFor(() => expect(f.messages).toHaveLength(2));
    expect(f.messages[0]).toMatchObject({ type: "terminal.snapshot", snapshot: { seq: 1 } });
    expect(f.messages[1]).toEqual({ type: "terminal.data", sessionId: "one", data: "AFTER\r\n", seq: 2 });

    // Apply the same reset/write/sequence rules as the mobile terminal to a real terminal.
    const display = hubModule.createTerminalStateHub();
    hubs.push(display);
    let lastSeq = 0;
    for (const message of f.messages) {
      if (message.type === "terminal.snapshot") {
        display.start("display", message.snapshot.cols, message.snapshot.rows);
        display.write("display", message.snapshot.ansi);
        lastSeq = message.snapshot.seq;
      } else if (message.seq > lastSeq) {
        display.write("display", message.data);
        lastSeq = message.seq;
      }
    }
    const text = await display.getText("display");
    expect(text.match(/BEFORE/g)).toHaveLength(1);
    expect(text.match(/AFTER/g)).toHaveLength(1);
    expect(lastSeq).toBe(2);
    f.write("LIVE");
    expect(f.messages.at(-1)).toMatchObject({ type: "terminal.data", data: "LIVE", seq: 3 });
    expect(f.sendError).not.toHaveBeenCalled();
  });

  it("omits buffered output already included in the snapshot", async () => {
    const f = fixture();
    const getSnapshot = f.stateHub.getSnapshot;
    let resolve;
    f.stateHub.getSnapshot = () => new Promise(done => { resolve = done; });
    f.subscribe();
    f.write("INCLUDED");
    resolve(await getSnapshot("one"));
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    expect(f.messages[0]).toMatchObject({ type: "terminal.snapshot", snapshot: { seq: 1, ansi: "INCLUDED" } });
  });

  it.each(["switch", "close", "resubscribe", "unsubscribe"])("discards a pending snapshot after %s", async action => {
    const f = fixture();
    let resolve;
    const snapshot = await f.stateHub.getSnapshot("one");
    f.stateHub.getSnapshot = () => new Promise(done => { resolve = done; });
    f.subscribe();
    const finishOld = resolve;
    f.write("OLD");
    if (action === "close") f.socket.emit("close", 1000);
    else if (action === "unsubscribe") f.unsubscribe();
    else f.subscribe(action === "switch" ? "two" : "one", 0);
    const before = [...f.messages];
    finishOld(snapshot);
    await new Promise(done => setImmediate(done));
    expect(f.messages).toEqual(before);
    expect(f.messages.some(message => message.type === "terminal.snapshot")).toBe(false);
  });

  it("replays reconnect deltas and then forwards live output", () => {
    const f = fixture();
    f.write("BEFORE");
    f.write("AFTER");
    f.subscribe("one", 1);
    f.write("LIVE");
    expect(f.messages.map(message => message.type)).toEqual(["terminal.data", "terminal.size-owner", "terminal.data"]);
    expect(f.messages.filter(message => message.type === "terminal.data").map(message => message.seq)).toEqual([2, 3]);
  });
});

it("rechecks batch candidates, skips stale sessions and continues after failures", async () => {
  const messages = [];
  const uploads = { releaseSession: vi.fn() };
  const closeSession = vi.fn(id => { if (id === "bad") throw new Error("failure"); });
  const handlers = socketModule.createMobileSocketHandlers({
    terminalManager: { getSession: id => id === "missing" ? null : ({ id, runtimeMode: "terminal" }), closeSession },
    getAgentStatus: id => ({ status: id === "running" ? "running" : "completed" }),
    stateHub: {}, now: Date.now, auth: {}, sizes: {}, uploads,
    send: (_socket, message) => messages.push(message), sendError: vi.fn()
  });
  const socket = new EventEmitter();
  handlers.handleWebSocket(socket, { socket: { remoteAddress: "127.0.0.1" } });
  socket.authenticated = true;
  socket.emit("message", JSON.stringify({ v: 8, type: "sessions.close-completed", requestId: "batch",
    sessionIds: ["running", "missing", "bad", "done", "done"] }));
  await vi.waitFor(() => expect(messages).toContainEqual({ type: "sessions.close-completed.result", requestId: "batch", closed: 1, skipped: 2, failed: 1 }));
  expect(closeSession.mock.calls.map(([id]) => id)).toEqual(["bad", "done"]);
  expect(uploads.releaseSession.mock.calls.map(([id]) => id)).toEqual(["bad", "done"]);
});


it.each(["cancelled", "disconnected", "connected"])("handles %s file-list results without sending abandoned lists", async state => {
  let resolve;
  const files = { list: vi.fn(() => new Promise(done => { resolve = done; })), releaseSocket: vi.fn() };
  const send = vi.fn();
  const sendError = vi.fn();
  const handlers = socketModule.createMobileSocketHandlers({
    terminalManager: {}, sizes: {}, now: Date.now, files, send, sendError,
    auth: { handleSocketClosed: socket => { socket.authenticated = false; } }
  });
  const socket = new EventEmitter();
  handlers.handleWebSocket(socket, { socket: { remoteAddress: "127.0.0.1" } });
  socket.authenticated = true;
  socket.emit("message", JSON.stringify({ v: protocolModule.PROTOCOL_VERSION, type: "files.list", path: null, requestId: "list" }));
  expect(files.list).toHaveBeenCalledWith(null, socket);
  if (state === "disconnected") socket.emit("close");
  resolve(state === "cancelled" ? undefined : { path: null, entries: [] });
  await new Promise(done => setImmediate(done));
  if (state === "connected") expect(send).toHaveBeenCalledExactlyOnceWith(socket, { type: "files.list.result", requestId: "list", path: null, entries: [] });
  else expect(send).not.toHaveBeenCalled();
  expect(sendError).not.toHaveBeenCalled();
});
