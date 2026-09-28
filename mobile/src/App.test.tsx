import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { useRemoteConnection } from "./useRemoteConnection";
import type { RuntimeSession, SavedTemplate } from "./types";

vi.mock("./useRemoteConnection", () => ({ useRemoteConnection: vi.fn() }));
vi.mock("./TerminalView", () => ({ TerminalView: ({ session }: { session: RuntimeSession }) => <div>终端：{session.title}</div> }));
vi.mock("./GraphicalView", () => ({ GraphicalView: ({ session }: { session: RuntimeSession }) => <div>图形：{session.title}</div> }));

const storageKey = "pannel-handle-mobile-active-session";
const first: RuntimeSession = { id: "first", title: "第一个会话", type: "windows", runtimeMode: "terminal" };
const second: RuntimeSession = { id: "second", title: "第二个会话", type: "windows", runtimeMode: "terminal" };
const launched: RuntimeSession = { id: "launched", title: "新会话", type: "windows", runtimeMode: "terminal" };
const productionTemplate: SavedTemplate = {
  id: "production", title: "Production API", type: "ssh", runtimeMode: "terminal",
  cwd: "/srv/application", sshEndpoint: "server.example.com", tags: ["Customer-A"], runningCount: 0
};
const developmentTemplate: SavedTemplate = {
  id: "development", title: "开发环境", type: "wsl", runtimeMode: "terminal",
  wslDistro: "Ubuntu-24.04", runningCount: 1
};
let remote: ReturnType<typeof useRemoteConnection>;

beforeEach(() => {
  remote = {
    status: "connected", statusMessage: "已连接", sessions: [first, second], overviews: {}, templates: [],
    device: null, lastLaunchedId: null, commandError: "", storageWarning: "", connectionEpoch: 1,
    send: vi.fn(() => true), retry: vi.fn(), login: vi.fn(),
    onTerminalMessage: vi.fn(() => () => true), onGraphicalMessage: vi.fn(() => () => true), onFileMessage: vi.fn(() => () => true)
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
  fireEvent.click(screen.getAllByRole("button", { name: /第二个会话/ }).at(-1)!);
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toBe("second");

  page.unmount();
  remote = { ...remote, status: "connecting", sessions: [] };
  const refreshed = render(<App />);
  expect(localStorage.getItem(storageKey)).toBe("second");
  remote = { ...remote, status: "connected", sessions: [first, second] };
  refreshed.rerender(<App />);
  expect(screen.getByRole("button", { name: "打开第二个会话详情" })).toBeTruthy();
  expect(screen.queryByText("终端：第二个会话")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开第二个会话详情" }));
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
});

it("keeps the current session visible while reconnecting", () => {
  remote = { ...remote, device: { deviceId: "phone-1", deviceName: "Phone" } };
  const page = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开第一个会话详情" }));
  expect(screen.getByText("终端：第一个会话")).toBeTruthy();
  remote = { ...remote, status: "disconnected", statusMessage: "连接已断开，正在重试…" };
  page.rerender(<App />);
  expect(screen.getByText("终端：第一个会话")).toBeTruthy();
  expect(screen.getByText("正在恢复连接")).toBeTruthy();
  remote = { ...remote, status: "connected", connectionEpoch: 2 };
  page.rerender(<App />);
  expect(screen.getByText("终端：第一个会话")).toBeTruthy();
  expect(screen.queryByText("正在恢复连接")).toBeNull();
});

it("falls back when the saved session is no longer running", () => {
  localStorage.setItem(storageKey, "closed");
  render(<App />);
  expect(screen.getByRole("button", { name: "打开第一个会话详情" })).toBeTruthy();
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
  fireEvent.click(screen.getAllByRole("button", { name: /第二个会话/ }).at(-1)!);
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
  fireEvent.click(screen.getAllByRole("button", { name: /第二个会话/ }).at(-1)!);
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
});

it("shows live overviews on the home cards and returns from details", () => {
  remote = { ...remote, overviews: { first: { sessionId: "first", status: "运行中", summary: "构建已完成" } } };
  render(<App />);
  expect(screen.getByText("构建已完成")).toBeTruthy();
  expect(screen.getByText("运行中")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "打开第一个会话详情" }));
  expect(screen.getByText("终端：第一个会话")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回首页" }));
  expect(screen.getByText("构建已完成")).toBeTruthy();
});

it("returns home when the open session ends", () => {
  const page = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开第二个会话详情" }));
  expect(screen.getByText("终端：第二个会话")).toBeTruthy();
  remote = { ...remote, sessions: [first] };
  page.rerender(<App />);
  expect(screen.getByRole("heading", { name: "运行中的会话" })).toBeTruthy();
  expect(screen.queryByText("终端：第一个会话")).toBeNull();
});

it("searches saved templates by title and available metadata without changing running sessions", () => {
  remote = { ...remote, templates: [productionTemplate, developmentTemplate] };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  expect(screen.queryByRole("searchbox", { name: "搜索已保存模板" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "已保存模板 (2)" }));
  const search = screen.getByRole("searchbox", { name: "搜索已保存模板" });

  for (const query of ["  PRODUCTION  ", "SSH", "/srv/app", "SERVER.EXAMPLE", "customer-a"]) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getByText("Production API")).toBeTruthy();
    expect(screen.queryByText("开发环境")).toBeNull();
  }
  fireEvent.change(search, { target: { value: "ubuntu" } });
  expect(screen.getByText("开发环境")).toBeTruthy();
  expect(screen.queryByText("Production API")).toBeNull();

  fireEvent.change(search, { target: { value: "missing" } });
  expect(screen.getByText("没有匹配的模板")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "清除模板搜索" }));
  expect(screen.getByText("Production API")).toBeTruthy();
  expect(screen.getByText("开发环境")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "运行中 (2)" }));
  expect(screen.getAllByRole("button", { name: /第一个会话/ }).at(-1)).toBeTruthy();
  expect(screen.queryByRole("searchbox", { name: "搜索已保存模板" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "已保存模板 (2)" }));
  expect(screen.getByRole("searchbox", { name: "搜索已保存模板" }).getAttribute("value")).toBe("");
});

it("starts a filtered template and resets search when the drawer closes", () => {
  remote = { ...remote, templates: [productionTemplate, developmentTemplate] };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: "已保存模板 (2)" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索已保存模板" }), { target: { value: "Production" } });
  fireEvent.click(screen.getByRole("button", { name: "启动" }));
  expect(remote.send).toHaveBeenCalledWith(expect.objectContaining({ type: "template.launch", templateId: "production" }));
  fireEvent.click(screen.getByRole("button", { name: "已保存模板 (2)" }));
  expect(screen.getByText("开发环境")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索已保存模板" }), { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "×" }));
  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  expect(screen.getByText("Production API")).toBeTruthy();
});

it("keeps the no-templates message distinct from no search matches", () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: "已保存模板 (0)" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索已保存模板" }), { target: { value: "missing" } });
  expect(screen.getByText("请先在电脑端创建会话模板")).toBeTruthy();
  expect(screen.queryByText("没有匹配的模板")).toBeNull();
});
