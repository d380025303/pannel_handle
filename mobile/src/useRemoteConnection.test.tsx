import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRemoteConnection } from "./useRemoteConnection";
import { PROTOCOL_VERSION } from "./types";

const passwordKey = "pannel-handle-mobile-password";

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];

  constructor(public url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(data); }
  open() { this.readyState = FakeWebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  receive(type: string, fields: Record<string, unknown> = {}) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ v: PROTOCOL_VERSION, type, ...fields }) }));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("indexedDB", { deleteDatabase: vi.fn() });
  return renderHook(() => useRemoteConnection());
}

function ready(socket: FakeWebSocket) {
  act(() => socket.receive("ready", { payload: { deviceId: "phone-1", deviceName: "Phone", sessions: [], templates: [] } }));
}

it("stores a password only after successful login and uses it after refresh", () => {
  const first = setup();
  expect(first.result.current.status).toBe("password-required");
  expect(FakeWebSocket.instances).toHaveLength(0);
  act(() => first.result.current.login("correct-password"));
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  expect(JSON.parse(socket.sent[0])).toMatchObject({ type: "password.login", password: "correct-password" });
  expect(localStorage.getItem(passwordKey)).toBeNull();
  ready(socket);
  expect(first.result.current.status).toBe("connected");
  expect(localStorage.getItem(passwordKey)).toBe("correct-password");
  first.unmount();

  const refreshed = setup();
  expect(FakeWebSocket.instances).toHaveLength(2);
  act(() => FakeWebSocket.instances[1].open());
  expect(JSON.parse(FakeWebSocket.instances[1].sent[0])).toMatchObject({
    type: "password.login", password: "correct-password"
  });
  refreshed.unmount();
});

it("updates and removes session overviews as sessions change", () => {
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  act(() => socket.receive("ready", { payload: { deviceId: "phone-1", deviceName: "Phone",
    sessions: [{ id: "one", title: "One", type: "windows", runtimeMode: "terminal" }], templates: [] } }));
  act(() => socket.receive("session.overview", { overview: { sessionId: "one", status: "运行中", summary: "ready" } }));
  expect(hook.result.current.overviews.one.summary).toBe("ready");
  act(() => socket.receive("sessions.changed", { sessions: [] }));
  expect(hook.result.current.overviews.one).toBeUndefined();
});

it("clears a rejected saved password and waits for a new one", () => {
  localStorage.setItem(passwordKey, "old-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  act(() => socket.receive("error", { code: "PASSWORD_INVALID", message: "密码错误" }));
  expect(localStorage.getItem(passwordKey)).toBeNull();
  expect(hook.result.current.status).toBe("password-required");
});

it("shows an authentication rate limit without starting an automatic retry", () => {
  vi.useFakeTimers();
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  act(() => socket.receive("error", { code: "AUTH_RATE_LIMIT", message: "请稍后再试" }));
  act(() => socket.close());
  expect(hook.result.current.status).toBe("error");
  expect(hook.result.current.statusMessage).toBe("请稍后再试");
  expect(localStorage.getItem(passwordKey)).toBe("correct-password");
  act(() => vi.advanceTimersByTime(8000));
  expect(FakeWebSocket.instances).toHaveLength(1);
});

it.each(["PASSWORD_CHANGED", "CONNECTION_CLOSED"])("clears the password on %s", (code) => {
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  ready(socket);
  act(() => socket.receive("error", { code, message: "请重新输入" }));
  expect(localStorage.getItem(passwordKey)).toBeNull();
  expect(hook.result.current.status).toBe("password-required");
});

it("keeps the password when the service stops", () => {
  vi.useFakeTimers();
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  ready(socket);
  act(() => socket.receive("error", { code: "SERVICE_STOPPED", message: "服务已停止" }));
  act(() => socket.close());
  expect(localStorage.getItem(passwordKey)).toBe("correct-password");
  expect(hook.result.current.status).toBe("disconnected");
  act(() => vi.advanceTimersByTime(500));
  expect(FakeWebSocket.instances).toHaveLength(2);
  act(() => FakeWebSocket.instances[1].open());
  expect(JSON.parse(FakeWebSocket.instances[1].sent[0])).toMatchObject({ password: "correct-password" });
});

it("keeps the password after an unplanned network drop", () => {
  vi.useFakeTimers();
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  ready(socket);
  act(() => socket.close());
  expect(localStorage.getItem(passwordKey)).toBe("correct-password");
  expect(hook.result.current.status).toBe("disconnected");
  act(() => vi.advanceTimersByTime(500));
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it("replaces a silent foreground connection and ignores events from the old socket", () => {
  vi.useFakeTimers();
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const first = FakeWebSocket.instances[0];
  act(() => first.open());
  ready(first);
  expect(hook.result.current.connectionEpoch).toBe(1);
  act(() => vi.advanceTimersByTime(40_000));
  expect(FakeWebSocket.instances).toHaveLength(1);
  act(() => vi.advanceTimersByTime(10_000));
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(hook.result.current.status).toBe("connecting");
  act(() => first.receive("error", { code: "PASSWORD_CHANGED", message: "旧连接" }));
  expect(localStorage.getItem(passwordKey)).toBe("correct-password");
  const second = FakeWebSocket.instances[1];
  act(() => second.open());
  ready(second);
  expect(hook.result.current.status).toBe("connected");
  expect(hook.result.current.connectionEpoch).toBe(2);
});

it("keeps a connection with timely application pongs", () => {
  vi.useFakeTimers();
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  ready(socket);
  for (let index = 0; index < 6; index++) {
    act(() => vi.advanceTimersByTime(10_000));
    act(() => socket.receive("pong", { at: Date.now() }));
  }
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(hook.result.current.status).toBe("connected");
});

it("waits for a fresh pong after returning from a hidden page", () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  ready(socket);

  hidden = true;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(60_000));
  expect(FakeWebSocket.instances).toHaveLength(1);

  hidden = false;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(hook.result.current.status).toBe("connected");
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: "ping" });

  act(() => vi.advanceTimersByTime(40_000));
  expect(FakeWebSocket.instances).toHaveLength(1);
  act(() => vi.advanceTimersByTime(10_000));
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it("keeps the resumed connection when fresh pongs arrive", () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  localStorage.setItem(passwordKey, "correct-password");
  const hook = setup();
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  ready(socket);

  hidden = true;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(60_000));
  hidden = false;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  for (let index = 0; index < 3; index++) {
    act(() => vi.advanceTimersByTime(30_000));
    act(() => socket.receive("pong", { at: Date.now() }));
  }
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(hook.result.current.status).toBe("connected");
});

it("retries a connection that never finishes authentication", () => {
  vi.useFakeTimers();
  localStorage.setItem(passwordKey, "correct-password");
  setup();
  act(() => FakeWebSocket.instances[0].open());
  act(() => vi.advanceTimersByTime(15_000));
  act(() => vi.advanceTimersByTime(500));
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it("keeps the connection usable when browser storage rejects writes", () => {
  const original = Storage.prototype.setItem;
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === passwordKey) throw new Error("storage disabled");
    return original.call(this, key, value);
  });
  const hook = setup();
  act(() => hook.result.current.login("correct-password"));
  const socket = FakeWebSocket.instances[0];
  act(() => socket.open());
  ready(socket);
  expect(hook.result.current.status).toBe("connected");
  expect(hook.result.current.storageWarning).toContain("无法保存密码");
  setItem.mockRestore();
});
