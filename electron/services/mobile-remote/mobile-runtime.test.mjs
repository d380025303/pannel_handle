import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import authModule from "./mobile-auth.cjs";
import sizeModule from "./terminal-size-owner.cjs";
import socketModule from "./mobile-socket-handlers.cjs";
import serviceModule from "./mobile-remote-service.cjs";

const { createMobileAuth } = authModule;
const { createTerminalSizeOwner } = sizeModule;
const { createMobileSocketHandlers } = socketModule;
const { createMobileRemoteService, PROTOCOL_VERSION } = serviceModule;

afterEach(() => vi.useRealTimers());

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0, remoteAddress: "192.168.1.2",
    subscriptions: new Set(), close: vi.fn(), send: vi.fn(), ping: vi.fn(), terminate: vi.fn()
  });
}

function fixture(graphicalService) {
  const session = { id: "run-1", cols: 100, rows: 30, term: { write: vi.fn() } };
  const device = { id: "phone-1", name: "Phone" };
  const accessStore = {
    getConfig: () => ({ enabled: true, interfaceName: "LAN", port: 43123 }),
    listDevices: () => [device], listAudit: () => [], recordAudit: vi.fn(),
    addDevice: vi.fn(() => ({ device, token: "test-token" })),
    verifyPassword: vi.fn(password => password === "correct-password"),
    setPassword: vi.fn(),
    verifyDevice: vi.fn((id, token) => id === device.id && token === "test-token" ? device : null),
    revokeDevice: vi.fn(() => true)
  };
  const terminalManager = {
    getSession: id => id === session.id ? session : null,
    listSessions: () => [session], resize: vi.fn(), write: vi.fn(),
    updateSession: vi.fn(), closeSession: vi.fn()
  };
  const stateHub = {
    resize: vi.fn(), getDeltas: vi.fn(() => []), getSnapshot: vi.fn(),
    start: vi.fn(), write: vi.fn(() => 1), remove: vi.fn()
  };
  const broadcast = vi.fn();
  const send = vi.fn();
  const sendError = vi.fn();
  const files = { list: vi.fn(async () => ({ path: null, entries: [] })),
    prepare: vi.fn(async () => ({ url: "/api/v1/download/test?ticket=secret" })), releaseSocket: vi.fn() };
  const notifyConnection = vi.fn();
  const sizes = createTerminalSizeOwner({
    terminalManager, stateHub, desktopBroadcast: broadcast, send,
    getSubscribedSockets: sessionId => auth.getClients().map(client => client.socket).filter(client => client.subscriptions.has(sessionId))
  });
  const auth = createMobileAuth({
    accessStore, now: () => Date.now(), send, sendError, notifyConnection,
    sendReady: client => handlers.sendReady(client),
    releaseDeviceSizes: sizes.releaseDeviceSizes, broadcastState: broadcast,
    currentState: () => ({ running: true }),
  });
  const handlers = createMobileSocketHandlers({
    terminalManager, stateHub, accessStore, auth, sizes, send, sendError, graphicalService,
    sessionStore: { getLibrary: () => [], getTemplate: () => null },
    agentSessionLauncher: {}, now: () => Date.now(), files
  });
  return { auth, sizes, handlers, device, accessStore, terminalManager, stateHub, send, sendError, notifyConnection, files };
}

describe("mobile component collaboration", () => {
  it("authenticates a password and exposes a connected client", () => {
    const f = fixture();
    const client = socket();
    f.auth.handlePasswordLogin(client, { password: "wrong-password", deviceName: "Phone" });
    expect(f.accessStore.addDevice).not.toHaveBeenCalled();
    f.auth.handlePasswordLogin(client, { password: "correct-password", deviceName: "Phone" });
    expect(f.accessStore.verifyPassword).toHaveBeenCalledWith("correct-password");
    expect(f.auth.getClients()[0].socket).toBe(client);
    expect(client.authenticated).toBe(true);
  });

  it("releases mobile size ownership immediately after disconnect", () => {
    const f = fixture();
    const first = socket();
    f.auth.handlePasswordLogin(first, { password: "correct-password", deviceName: "Phone" });
    first.subscriptions.add("run-1");
    f.sizes.applySize("run-1", first.mobileDevice.id, 80, 20);
    f.sizes.resizeFromDesktop("run-1", 140, 45);
    expect(f.terminalManager.resize).toHaveBeenLastCalledWith("run-1", 80, 20);
    f.auth.handleSocketClosed(first);
    expect(f.auth.getClients()).toHaveLength(0);
    expect(f.terminalManager.resize).toHaveBeenLastCalledWith("run-1", 140, 45);
    expect(f.stateHub.resize).toHaveBeenLastCalledWith("run-1", 140, 45);
  });

  it("allows separate authenticated clients and disconnects one without releasing another", () => {
    const f = fixture();
    const first = socket();
    f.auth.handlePasswordLogin(first, { password: "correct-password", deviceName: "Phone" });
    f.sizes.applySize("run-1", first.mobileDevice.id, 80, 20);
    const other = socket();
    f.auth.handlePasswordLogin(other, { password: "correct-password", deviceName: "Other" });
    expect(f.auth.getClients()).toHaveLength(2);
    f.auth.disconnectClient(first.mobileDevice.id);
    expect(f.auth.getClients()).toHaveLength(1);
    expect(f.sizes.getSizeState("run-1").owner).toBe("desktop");
  });

  it("distinguishes a service stop from a desktop disconnect and password change", () => {
    const f = fixture();
    for (const [reason, code] of [
      ["service-stopped", "SERVICE_STOPPED"],
      ["desktop-disconnect", "CONNECTION_CLOSED"],
      ["password-changed", "PASSWORD_CHANGED"]
    ]) {
      const client = socket();
      f.auth.handlePasswordLogin(client, { password: "correct-password", deviceName: "Phone" });
      f.auth.disconnectClient(client.mobileDevice.id, reason);
      expect(f.sendError).toHaveBeenLastCalledWith(client, code, expect.any(String));
    }
  });

  it("records the WebSocket close code for an unexpected disconnect", () => {
    const f = fixture();
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    f.auth.handlePasswordLogin(client, { password: "correct-password", deviceName: "Phone" });
    client.emit("close", 1006);
    expect(f.accessStore.recordAudit).toHaveBeenCalledWith("connection.disconnected",
      expect.objectContaining({ reason: "socket-close-1006" }));
  });

  it("gates commands on authentication and enforces the authentication attempt window", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    const message = payload => client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
    message({ type: "terminal.input", sessionId: "run-1", data: "x" });
    expect(f.terminalManager.write).not.toHaveBeenCalled();
    expect(f.sendError).toHaveBeenLastCalledWith(client, "AUTH_REQUIRED", expect.any(String));
    for (let i = 0; i < 6; i++) message({ type: "password.login", password: "bad", deviceName: "Phone" });
    expect(f.accessStore.verifyPassword).toHaveBeenCalledTimes(5);
    expect(f.sendError).toHaveBeenLastCalledWith(client, "AUTH_RATE_LIMIT", expect.any(String));
    await vi.advanceTimersByTimeAsync(60_001);
    message({ type: "password.login", password: "correct-password", deviceName: "Phone" });
    message({ type: "terminal.input", sessionId: "run-1", data: "hello" });
    expect(f.terminalManager.write).toHaveBeenCalledWith("run-1", "hello");
  });

  it("requires a valid password before issuing a device and receiving sessions", () => {
    const f = fixture();
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    const message = payload => client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
    message({ type: "password.login", password: "wrong-password", deviceName: "Phone" });
    expect(f.sendError).toHaveBeenLastCalledWith(client, "PASSWORD_INVALID", expect.any(String));
    expect(f.accessStore.addDevice).not.toHaveBeenCalled();
    message({ type: "password.login", password: "correct-password", deviceName: "Phone" });
    expect(f.accessStore.verifyPassword).toHaveBeenCalledWith("correct-password");
    expect(client.authenticated).toBe(true);
    expect(f.send).toHaveBeenCalledWith(client, expect.objectContaining({ type: "ready" }));
  });

  it("only serves file browser commands after authentication", async () => {
    const f = fixture();
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    const message = payload => client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
    message({ type: "files.list", path: null, requestId: "before" });
    expect(f.files.list).not.toHaveBeenCalled();
    f.auth.handlePasswordLogin(client, { password: "correct-password", deviceName: "Phone" });
    message({ type: "files.list", path: null, requestId: "list-1" });
    message({ type: "files.download.prepare", path: "C:\\note.txt", requestId: "get-1" });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(client,
      expect.objectContaining({ type: "files.download.ready", requestId: "get-1" })));
    expect(f.files.prepare).toHaveBeenCalledWith(client, "C:\\note.txt");
    client.emit("close");
    expect(f.files.releaseSocket).toHaveBeenCalledWith(client);
  });

  it("preserves delta replay, snapshot fallback and the per-second input limit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    f.auth.handlePasswordLogin(client, { password: "correct-password", deviceName: "Phone" });
    const message = payload => client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
    f.stateHub.getDeltas.mockReturnValue([{ data: "delta", seq: 2 }]);
    message({ type: "terminal.subscribe", sessionId: "run-1", lastSeq: 1 });
    expect(f.send).toHaveBeenCalledWith(client, { type: "terminal.data", sessionId: "run-1", data: "delta", seq: 2 });
    const snapshot = { sessionId: "run-1", data: "snapshot" };
    f.stateHub.getDeltas.mockReturnValue(null);
    f.stateHub.getSnapshot.mockResolvedValue(snapshot);
    message({ type: "terminal.subscribe", sessionId: "run-1" });
    await Promise.resolve();
    expect(f.send).toHaveBeenCalledWith(client, { type: "terminal.snapshot", snapshot });
    for (let i = 0; i < 17; i++) message({ type: "terminal.input", sessionId: "run-1", data: "x".repeat(16 * 1024) });
    expect(f.terminalManager.write).toHaveBeenCalledTimes(16);
    expect(f.sendError).toHaveBeenLastCalledWith(client, "COMMAND_FAILED", expect.any(String), undefined);
    await vi.advanceTimersByTimeAsync(1000);
    message({ type: "terminal.input", sessionId: "run-1", data: "x" });
    expect(f.terminalManager.write).toHaveBeenCalledTimes(17);
  });

  it("runs saved quick commands by ID and only removes a one-time command after writing", async () => {
    const f = fixture();
    const session = f.terminalManager.getSession("run-1");
    session.quickCommands = [
      { id: "write", command: "pwd", mode: "write" },
      { id: "auto", command: "ls", mode: "auto-enter" },
      { id: "once", command: "exit", mode: "one-time" }
    ];
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    f.auth.handlePasswordLogin(client, { password: "correct-password", deviceName: "Phone" });
    const message = payload => client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
    message({ type: "quick-command.invoke", sessionId: "run-1", commandId: "write", requestId: "1" });
    message({ type: "quick-command.invoke", sessionId: "run-1", commandId: "auto", requestId: "2" });
    message({ type: "quick-command.invoke", sessionId: "run-1", commandId: "once", requestId: "3" });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(client, { type: "command.ok", requestId: "3" }));
    expect(f.terminalManager.write.mock.calls).toEqual([["run-1", "pwd"], ["run-1", "ls\r"], ["run-1", "exit"]]);
    expect(f.terminalManager.updateSession).toHaveBeenCalledWith("run-1", { quickCommands: session.quickCommands.slice(0, 2) });
    f.terminalManager.updateSession.mockClear();
    session.type = "ssh";
    session.sshConnectionState = "disconnected";
    message({ type: "quick-command.invoke", sessionId: "run-1", commandId: "once", requestId: "offline" });
    await vi.waitFor(() => expect(f.sendError).toHaveBeenCalledWith(client, "COMMAND_FAILED", "终端当前不可写入，请稍后重试。", "offline"));
    expect(f.terminalManager.updateSession).not.toHaveBeenCalled();
  });

  it("submits graphical quick commands and keeps them after a failed submit", async () => {
    const graphicalService = { snapshot: vi.fn(() => ({ threadId: "thread-1", archived: false })), submit: vi.fn() };
    const f = fixture(graphicalService);
    const session = f.terminalManager.getSession("run-1");
    session.runtimeMode = "app-server";
    session.quickCommands = [{ id: "auto", command: "检查", mode: "auto-enter" }, { id: "once", command: "解释", mode: "one-time" }];
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    f.auth.handlePasswordLogin(client, { password: "correct-password", deviceName: "Phone" });
    client.graphicalSessionId = "run-1";
    const message = payload => client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, sessionId: "run-1", threadId: "thread-1", ...payload }));
    graphicalService.submit.mockRejectedValueOnce(new Error("提交失败"));
    message({ type: "quick-command.invoke", commandId: "auto", requestId: "fail" });
    await vi.waitFor(() => expect(f.sendError).toHaveBeenCalledWith(client, "GRAPHICAL_COMMAND_FAILED", "提交失败", "fail"));
    expect(f.terminalManager.updateSession).not.toHaveBeenCalled();
    graphicalService.submit.mockResolvedValueOnce(undefined);
    message({ type: "quick-command.invoke", commandId: "auto", requestId: "ok" });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(client, { type: "command.ok", requestId: "ok" }));
    expect(graphicalService.submit).toHaveBeenLastCalledWith("run-1", "检查", []);
    message({ type: "quick-command.invoke", commandId: "once", requestId: "once" });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(client, { type: "command.ok", requestId: "once" }));
    expect(f.terminalManager.updateSession).toHaveBeenCalledWith("run-1", { quickCommands: session.quickCommands.slice(0, 1) });
  });
});

it("assembles mobile resources, forwards terminal events and stops repeatedly without leaking timers", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const server = Object.assign(new EventEmitter(), {
    listening: false,
    listen: vi.fn(() => { server.listening = true; server.emit("listening"); }),
    close: vi.fn(callback => { server.listening = false; callback(); return server; })
  });
  const client = socket();
  const wss = { clients: new Set([client]), close: vi.fn(), handleUpgrade: vi.fn((_request, _socket, _head, callback) => callback(client)) };
  const advertisement = { stop: vi.fn() };
  const discovery = { publish: vi.fn(() => advertisement), destroy: vi.fn() };
  const broadcast = vi.fn();
  const createHttpServer = vi.fn(() => server);
  const service = createMobileRemoteService({
    terminalManager: f.terminalManager, stateHub: f.stateHub, accessStore: f.accessStore,
    agentSessionLauncher: {}, sessionStore: { getLibrary: () => [] },
    getStaticRoot: () => ".", desktopBroadcast: broadcast,
    notifyConnection: f.notifyConnection,
    networkInterfaces: () => ({ LAN: [{ family: "IPv4", address: "192.168.1.1", internal: false }] }),
    createHttpServer, createWebSocketServer: () => wss, createDiscovery: () => discovery
  });
  await service.start();
  await service.start();
  expect(createHttpServer).toHaveBeenCalledTimes(1);
  server.emit("upgrade", { url: "/api/v1/ws", headers: { host: "192.168.1.1:43123" }, socket: { remoteAddress: "192.168.1.2" } }, {}, Buffer.alloc(0));
  client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, type: "password.login", password: "correct-password", deviceName: "Phone" }));
  client.emit("message", JSON.stringify({ v: PROTOCOL_VERSION, type: "terminal.subscribe", sessionId: "run-1", lastSeq: 0 }));
  service.handleTerminalEvent("terminal:data", { id: "run-1", data: "output" });
  expect(client.send).toHaveBeenCalledWith(JSON.stringify({ v: PROTOCOL_VERSION, type: "terminal.data", sessionId: "run-1", data: "output", seq: 1 }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(client.ping).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(client.terminate).not.toHaveBeenCalled();
  client.emit("pong");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(client.terminate).toHaveBeenCalledTimes(1);
  expect(f.accessStore.recordAudit).toHaveBeenCalledWith("connection.heartbeat-timeout", expect.objectContaining({ deviceName: "Phone" }));
  service.setPassword("rotated-password");
  expect(f.accessStore.setPassword).toHaveBeenCalledWith("rotated-password");
  expect(client.close).toHaveBeenCalledWith(1008, "password-changed");
  expect(service.getState().activeConnections).toHaveLength(0);
  await service.stop();
  await service.stop();
  expect(server.close).toHaveBeenCalledTimes(1);
  expect(wss.close).toHaveBeenCalledTimes(1);
  expect(advertisement.stop).toHaveBeenCalledTimes(1);
  expect(discovery.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(service.getState()).toMatchObject({ running: false, activeConnections: [] });
});
