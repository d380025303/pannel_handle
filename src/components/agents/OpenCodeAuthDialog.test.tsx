// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenCodeAuthApi } from "../../vite-env";
import { OpenCodeAuthDialog } from "./OpenCodeAuthDialog";

const terminal = vi.hoisted(() => ({ write: vi.fn(), reset: vi.fn(), focus: vi.fn(), dispose: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 20; textarea = document.createElement("textarea");
  loadAddon() {} open() {} onData() { return { dispose: vi.fn() }; }
  attachCustomKeyEventHandler() {} hasSelection() { return false; }
  write = terminal.write; reset = terminal.reset; focus = terminal.focus; dispose = terminal.dispose;
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

let data: Parameters<OpenCodeAuthApi["onData"]>[0];
let state: Parameters<OpenCodeAuthApi["onState"]>[0];
const start = vi.fn(); const cancel = vi.fn();
const auth = { status: "idle" as const, generation: 0, error: null, required: false,
  methods: [{ id: "opencode-login", name: "OpenCode 登录", description: "Login" }] };

beforeEach(() => {
  vi.clearAllMocks();
  start.mockResolvedValue({ generation: 1, history: "existing output", seq: 1 }); cancel.mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(window, "openCodeAuthApi", { configurable: true, value: {
    start, cancel, write: vi.fn(), resize: vi.fn(),
    onData: (callback: typeof data) => { data = callback; return vi.fn(); },
    onState: (callback: typeof state) => { state = callback; return vi.fn(); }
  } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("does not launch automatically or twice under StrictMode and restores buffered output", async () => {
  render(<StrictMode><OpenCodeAuthDialog sessionId="one" auth={auth} onClose={vi.fn()} /></StrictMode>);
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "开始登录" }));
  await waitFor(() => expect(terminal.write).toHaveBeenCalledWith("existing output"));
  expect(start).toHaveBeenCalledExactlyOnceWith("one", "opencode-login");
  act(() => {
    data({ id: "one", generation: 0, seq: 2, data: "stale" });
    data({ id: "one", generation: 1, seq: 2, data: "new output" });
  });
  expect(terminal.write).not.toHaveBeenCalledWith("stale");
  expect(terminal.write).toHaveBeenCalledWith("new output");
  act(() => state({ id: "one", generation: 1, status: "succeeded", error: null }));
  expect(screen.getByText("登录完成，已重新连接原会话")).toBeTruthy();
});

it("shows a failed login and allows retry", async () => {
  start.mockRejectedValueOnce(new Error("cannot start"));
  render(<OpenCodeAuthDialog sessionId="one" auth={auth} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始登录" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "cannot start");
  fireEvent.click(screen.getByRole("button", { name: "重试登录" }));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
});

it("cancels a pending start immediately on unmount and cancels its late result", async () => {
  let resolve!: (value: { generation: number; seq: number; history: string }) => void;
  start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<OpenCodeAuthDialog sessionId="one" auth={auth} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始登录" }));
  act(() => state({ id: "one", generation: 7, status: "running", error: null }));
  view.unmount(); expect(cancel).toHaveBeenCalledWith("one", 7);
  await act(async () => resolve({ generation: 7, seq: 0, history: "" }));
  expect(cancel).toHaveBeenCalledTimes(2);
});

it("shows terminal instructions when no supported method is advertised", () => {
  render(<OpenCodeAuthDialog sessionId="one" auth={{ ...auth, methods: [] }} onClose={vi.fn()} />);
  expect(screen.getByText("opencode auth login")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "开始登录" })).toBeNull();
});
