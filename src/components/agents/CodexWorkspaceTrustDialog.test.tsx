// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexWorkspaceTrustRequest } from "../../vite-env";
import { CodexWorkspaceTrustDialog } from "./CodexWorkspaceTrustDialog";

const mocks = vi.hoisted(() => ({ input: null as null | ((data: string) => void), resize: null as null | (() => void) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  loadAddon() {} open() {} write() {} focus() {} dispose() {}
  onData(callback: (data: string) => void) { mocks.input = callback; return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const request: CodexWorkspaceTrustRequest = {
  id: "run-7", sessionId: "run-7", title: "SSH Codex", workspacePath: "C:\\runtime\\run-7",
  phase: "project", ready: true, terminalOpen: false, configPreview: '{"hooks":{}}', scriptPreview: "Write-Output ready", output: "", error: ""
};

afterEach(cleanup);

it("shows the exact workspace and hook content before granting project trust", async () => {
  const trustProject = vi.fn(async () => request);
  Object.defineProperty(window, "codexWorkspaceTrustApi", { configurable: true, value: {
    listPending: vi.fn(async () => [request]), trustProject, openHooks: vi.fn(), write: vi.fn(), resize: vi.fn(),
    finish: vi.fn(), cancel: vi.fn(), onChanged: vi.fn(() => () => {}), onOutput: vi.fn(() => () => {}),
    onResolved: vi.fn(() => () => {})
  } });
  render(<CodexWorkspaceTrustDialog />);
  expect(await screen.findByText("C:\\runtime\\run-7")).toBeTruthy();
  fireEvent.click(screen.getByText("查看 Hook 配置"));
  expect(screen.getByText('{"hooks":{}}')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "信任当前工作区" }));
  await waitFor(() => expect(trustProject).toHaveBeenCalledWith("run-7"));
});

it("explains host, port and user authorization across projects and concurrent workspaces", async () => {
  Object.defineProperty(window, "codexWorkspaceTrustApi", { configurable: true, value: {
    listPending: vi.fn(async () => [{ ...request, persistent: true, hostTrustLabel: "deploy@example.com:22" }]),
    onChanged: vi.fn(() => () => {}), onResolved: vi.fn(() => () => {})
  } });
  render(<CodexWorkspaceTrustDialog />);
  expect(await screen.findByText(/同一 SSH 主机、端口和用户（deploy@example.com:22）/)).toBeTruthy();
  expect(screen.getByText(/各项目与并发桥接工作区将复用授权/)).toBeTruthy();
});


it("stops late terminal input immediately and isolates old errors from a reopened request", async () => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { mocks.resize = callback; }
    observe() {} disconnect() {}
  });
  let resolved: (value: { id: string }) => void = () => {};
  let changed: (value: CodexWorkspaceTrustRequest) => void = () => {};
  let rejectWrite: (cause: Error) => void = () => {};
  let rejectFinish: (cause: Error) => void = () => {};
  const write = vi.fn(() => new Promise<void>((_, reject) => { rejectWrite = reject; }));
  const resize = vi.fn(async () => {});
  const hooks = { ...request, phase: "hooks" as const, terminalOpen: true };
  Object.defineProperty(window, "codexWorkspaceTrustApi", { configurable: true, value: {
    listPending: vi.fn(async () => [hooks]), write, resize,
    finish: vi.fn(() => new Promise((_, reject) => { rejectFinish = reject; })),
    onChanged: (callback: typeof changed) => { changed = callback; return () => {}; },
    onResolved: (callback: typeof resolved) => { resolved = callback; return () => {}; },
    onOutput: () => () => {}
  } });
  try {
    render(<CodexWorkspaceTrustDialog />);
    await screen.findByRole("button", { name: "检查并启动" });
    const oldInput = mocks.input!;
    const oldResize = mocks.resize!;
    act(() => oldInput("before"));
    fireEvent.click(screen.getByRole("button", { name: "检查并启动" }));
    act(() => {
      resolved({ id: hooks.id });
      oldInput("after");
      oldResize();
      changed({ ...hooks, id: "new-review" });
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(resize).not.toHaveBeenCalled();
    await act(async () => { rejectWrite(new Error("old write")); rejectFinish(new Error("old finish")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "检查并启动" }) as HTMLButtonElement).disabled).toBe(false);
    act(() => oldInput("disposed"));
    expect(write).toHaveBeenCalledTimes(1);
    act(() => mocks.input!("new input"));
    expect(write).toHaveBeenLastCalledWith("new-review", "new input");
  } finally { vi.unstubAllGlobals(); }
});
