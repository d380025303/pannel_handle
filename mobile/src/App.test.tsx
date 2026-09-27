import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { useRemoteConnection } from "./useRemoteConnection";
import type { RuntimeSession } from "./types";

vi.mock("./useRemoteConnection", () => ({ useRemoteConnection: vi.fn() }));
vi.mock("./TerminalView", () => ({ TerminalView: ({ session }: { session: RuntimeSession }) => <div>终端：{session.title}</div> }));
vi.mock("./GraphicalView", () => ({ GraphicalView: ({ session }: { session: RuntimeSession }) => <div>图形：{session.title}</div> }));

const storageKey = "pannel-handle-mobile-active-session";
const first: RuntimeSession = { id: "first", title: "第一个会话", type: "windows", runtimeMode: "terminal" };
const second: RuntimeSession = { id: "second", title: "第二个会话", type: "windows", runtimeMode: "terminal" };
const launched: RuntimeSession = { id: "launched", title: "新会话", type: "windows", runtimeMode: "terminal" };
let remote: ReturnType<typeof useRemoteConnection>;

beforeEach(() => {
  remote = {
    status: "connected", statusMessage: "已连接", sessions: [first, second], templates: [],
    device: null, lastLaunchedId: null, commandError: "", storageWarning: "",
    send: vi.fn(() => true), retry: vi.fn(), login: vi.fn(),
    onTerminalMessage: vi.fn(() => () => true), onGraphicalMessage: vi.fn(() => () => true)
  };
  vi.mocked(useRemoteConnection).mockImplementation(() => remote);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("restores the selected session after a page refresh", () => {
  const page = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: /第二个会话/ }));
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBe("second");

  page.unmount();
  remote = { ...remote, status: "connecting", sessions: [] };
  const refreshed = render(<App />);
  expect(localStorage.getItem(storageKey)).toBe("second");
  remote = { ...remote, status: "connected", sessions: [first, second] };
  refreshed.rerender(<App />);
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
});

it("falls back when the saved session is no longer running", () => {
  localStorage.setItem(storageKey, "closed");
  render(<App />);
  expect(screen.getByText("终端：第一个会话")).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBe("first");
});

it("clears the saved selection when no sessions are running", () => {
  localStorage.setItem(storageKey, "closed");
  remote = { ...remote, sessions: [] };
  render(<App />);
  expect(screen.getByText("没有运行中的会话")).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("selects a newly launched session once, then respects a manual switch", () => {
  const page = render(<App />);
  remote = { ...remote, lastLaunchedId: "launched" };
  page.rerender(<App />);
  remote = { ...remote, sessions: [first, second, launched] };
  page.rerender(<App />);
  expect(screen.getByText("终端：新会话")).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBe("launched");

  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: /第二个会话/ }));
  remote = { ...remote, sessions: [first, second, launched] };
  page.rerender(<App />);
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBe("second");
});

it("keeps session selection usable when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: /第二个会话/ }));
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
});
