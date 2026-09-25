import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import authModule from "./mobile-auth.cjs";
import sizeModule from "./terminal-size-owner.cjs";
import socketModule from "./mobile-socket-handlers.cjs";
import serviceModule from "./mobile-remote-service.cjs";

const { createMobileAuth } = authModule;
const { createTerminalSizeOwner } = sizeModule;
const { createMobileSocketHandlers } = socketModule;
const { createMobileRemoteService, MOBILE_GRACE_MS, PAIRING_TTL_MS } = serviceModule;

afterEach(() => vi.useRealTimers());

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0, remoteAddress: "192.168.1.2",
    subscriptions: new Set(), close: vi.fn(), send: vi.fn(), ping: vi.fn(), terminate: vi.fn()
  });
}

function fixture() {
  const session = { id: "run-1", cols: 100, rows: 30 };
  const device = { id: "phone-1", name: "Phone" };
  const accessStore = {
    getConfig: () => ({ enabled: true, interfaceName: "LAN", port: 43123 }),
    listDevices: () => [device], listAudit: () => [], recordAudit: vi.fn(),
    addDevice: vi.fn(() => ({ device, token: "test-token" })),
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
  const confirmPairing = vi.fn(async () => true);
  const notifyConnection = vi.fn();
  const sizes = createTerminalSizeOwner({
    terminalManager, stateHub, desktopBroadcast: broadcast, send,
    getActiveSocket: () => auth.getActiveClient()?.socket
  });
  const auth = createMobileAuth({
    accessStore, now: () => Date.now(), send, sendError, confirmPairing, notifyConnection,
    sendReady: client => handlers.sendReady(client),
    releaseDeviceSizes: sizes.releaseDeviceSizes, broadcastState: broadcast,
    currentState: () => ({ running: true, canonicalUrl: "http://desktop.local:43123", fallbackUrl: "http://192.168.1.1:43123" })
  });
  const handlers = createMobileSocketHandlers({
    terminalManager, stateHub, accessStore, auth, sizes, send, sendError,
    sessionStore: { getLibrary: () => [], getTemplate: () => null },
    agentSessionLauncher: {}, now: () => Date.now()
  });
  return { auth, sizes, handlers, device, accessStore, terminalManager, stateHub, send, sendError, confirmPairing, notifyConnection };
}

describe("mobile component collaboration", () => {
  it("consumes pairing nonces once and rejects expired pairing", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pairing = await f.auth.createPairing();
    const nonce = new URLSearchParams(new URL(pairing.url).hash.slice(1)).get("pair");
    const client = socket();
    await f.auth.handlePairRequest(client, { nonce, deviceName: "Phone" });
    expect(f.accessStore.addDevice).toHaveBeenCalledTimes(1);
    expect(f.auth.getActiveClient().socket).toBe(client);
    await f.auth.handlePairRequest(socket(), { nonce });
    expect(f.sendError).toHaveBeenLastCalledWith(expect.anything(), "PAIR_INVALID", expect.any(String));
    const expired = await f.auth.createPairing();
    await vi.advanceTimersByTimeAsync(PAIRING_TTL_MS + 1);
    await f.auth.handlePairRequest(socket(), { nonce: new URLSearchParams(new URL(expired.url).hash.slice(1)).get("pair") });
    expect(f.accessStore.addDevice).toHaveBeenCalledTimes(1);
    expect(f.confirmPairing).toHaveBeenCalledTimes(1);
  });

  it("keeps subscriptions and mobile size during reconnect grace, then restores the latest desktop size", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = socket();
    f.auth.authenticateSocket(first, f.device);
    first.subscriptions.add("run-1");
    f.sizes.applySize("run-1", f.device.id, 80, 20);
    f.sizes.resizeFromDesktop("run-1", 140, 45);
    expect(f.terminalManager.resize).toHaveBeenLastCalledWith("run-1", 80, 20);
    f.auth.handleSocketClosed(first);
    await vi.advanceTimersByTimeAsync(MOBILE_GRACE_MS - 1);
    const second = socket();
    f.auth.authenticateSocket(second, f.device);
    expect(second.subscriptions.has("run-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(MOBILE_GRACE_MS);
    expect(f.sizes.getSizeState("run-1").owner).toBe(f.device.id);
    expect(f.notifyConnection).toHaveBeenCalledTimes(1);
    f.auth.handleSocketClosed(second);
    await vi.advanceTimersByTimeAsync(MOBILE_GRACE_MS);
    expect(f.auth.getActiveClient()).toBeNull();
    expect(f.terminalManager.resize).toHaveBeenLastCalledWith("run-1", 140, 45);
    expect(f.stateHub.resize).toHaveBeenLastCalledWith("run-1", 140, 45);
  });

  it("blocks competing devices and immediately releases size ownership on revocation", () => {
    const f = fixture();
    const first = socket();
    f.auth.authenticateSocket(first, f.device);
    f.sizes.applySize("run-1", f.device.id, 80, 20);
    const other = socket();
    expect(f.auth.authenticateSocket(other, { id: "phone-2", name: "Other" })).toBe(false);
    expect(other.close).toHaveBeenCalledWith(1008, expect.any(String));
    f.auth.revokeDevice(f.device.id);
    expect(f.auth.getActiveClient()).toBeNull();
    expect(f.sizes.getSizeState("run-1").owner).toBe("desktop");
  });

  it("gates commands on authentication and enforces the authentication attempt window", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    const message = payload => client.emit("message", JSON.stringify({ v: 2, ...payload }));
    message({ type: "terminal.input", sessionId: "run-1", data: "x" });
    expect(f.terminalManager.write).not.toHaveBeenCalled();
    expect(f.sendError).toHaveBeenLastCalledWith(client, "AUTH_REQUIRED", expect.any(String));
    for (let i = 0; i < 6; i++) message({ type: "auth", deviceId: f.device.id, token: "bad" });
    expect(f.accessStore.verifyDevice).toHaveBeenCalledTimes(5);
    expect(f.sendError).toHaveBeenLastCalledWith(client, "AUTH_RATE_LIMIT", expect.any(String));
    await vi.advanceTimersByTimeAsync(60_001);
    message({ type: "auth", deviceId: f.device.id, token: "test-token" });
    message({ type: "terminal.input", sessionId: "run-1", data: "hello" });
    expect(f.terminalManager.write).toHaveBeenCalledWith("run-1", "hello");
  });

  it("preserves delta replay, snapshot fallback and the per-second input limit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const client = socket();
    f.handlers.handleWebSocket(client, { socket: { remoteAddress: "192.168.1.2" } });
    f.auth.authenticateSocket(client, f.device);
    const message = payload => client.emit("message", JSON.stringify({ v: 2, ...payload }));
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
    confirmPairing: f.confirmPairing, notifyConnection: f.notifyConnection,
    networkInterfaces: () => ({ LAN: [{ family: "IPv4", address: "192.168.1.1", internal: false }] }),
    createHttpServer, createWebSocketServer: () => wss, createDiscovery: () => discovery
  });
  await service.start();
  await service.start();
  expect(createHttpServer).toHaveBeenCalledTimes(1);
  server.emit("upgrade", { url: "/api/v1/ws", headers: { host: "192.168.1.1:43123" }, socket: { remoteAddress: "192.168.1.2" } }, {}, Buffer.alloc(0));
  client.emit("message", JSON.stringify({ v: 2, type: "auth", deviceId: f.device.id, token: "test-token" }));
  client.emit("message", JSON.stringify({ v: 2, type: "terminal.subscribe", sessionId: "run-1", lastSeq: 0 }));
  service.handleTerminalEvent("terminal:data", { id: "run-1", data: "output" });
  expect(client.send).toHaveBeenCalledWith(JSON.stringify({ v: 2, type: "terminal.data", sessionId: "run-1", data: "output", seq: 1 }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(client.ping).toHaveBeenCalledTimes(1);
  await service.stop();
  await service.stop();
  expect(server.close).toHaveBeenCalledTimes(1);
  expect(wss.close).toHaveBeenCalledTimes(1);
  expect(advertisement.stop).toHaveBeenCalledTimes(1);
  expect(discovery.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(service.getState()).toMatchObject({ running: false, activeDevice: null });
});
