import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerFiles } from "./ComputerFiles";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "./types";

type FileMessage = Extract<ServerMessage, { type: "files.list.result" | "files.search.result" | "files.download.ready" | "error" }>;
const listeners = new Set<(message: FileMessage) => void>();
const send = vi.fn((_message: ClientMessage) => true);
const onFileMessage = (listener: (message: FileMessage) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const emit = (message: FileMessage) => act(() => { for (const listener of listeners) listener(message); });
const requests = () => send.mock.calls.map(([message]) => message as unknown as { type: string; requestId: string; path?: string | null });

afterEach(() => { cleanup(); listeners.clear(); send.mockClear(); vi.restoreAllMocks(); });

it("browses drives and folders, then starts a single browser download", () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  render(<ComputerFiles connectionEpoch={1} send={send} onFileMessage={onFileMessage} onClose={() => undefined} />);
  const rootRequest = requests()[0];
  expect(rootRequest).toMatchObject({ type: "files.list", path: null });
  emit({ v: PROTOCOL_VERSION, type: "files.list.result", requestId: rootRequest.requestId, path: null,
    entries: [{ name: "C:\\", path: "C:\\", type: "drive", size: null }] });
  fireEvent.click(screen.getByRole("button", { name: /C:\\/ }));
  const folderRequest = requests().at(-1)!;
  expect(folderRequest).toMatchObject({ type: "files.list", path: "C:\\" });
  emit({ v: PROTOCOL_VERSION, type: "files.list.result", requestId: folderRequest.requestId, path: "C:\\",
    entries: [{ name: "report.txt", path: "C:\\report.txt", type: "file", size: 12 }] });
  fireEvent.click(screen.getByRole("button", { name: "下载" }));
  const downloadRequest = requests().at(-1)!;
  expect(downloadRequest).toMatchObject({ type: "files.download.prepare", path: "C:\\report.txt" });
  emit({ v: PROTOCOL_VERSION, type: "files.download.ready", requestId: downloadRequest.requestId,
    url: "/api/v1/download/123?ticket=abc" });
  expect(click).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toContain("浏览器下载记录");
});

it("shows a retryable directory error", () => {
  render(<ComputerFiles connectionEpoch={1} send={send} onFileMessage={onFileMessage} onClose={() => undefined} />);
  emit({ v: PROTOCOL_VERSION, type: "error", code: "FILE_COMMAND_FAILED", message: "没有权限", requestId: requests()[0].requestId });
  expect(screen.getByRole("alert").textContent).toBe("没有权限");
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(requests()).toHaveLength(2);
});

it("refreshes the current folder after reconnect", () => {
  const props = { send, onFileMessage, onClose: () => undefined };
  const page = render(<ComputerFiles {...props} connectionEpoch={1} />);
  expect(requests()).toHaveLength(1);
  page.rerender(<ComputerFiles {...props} connectionEpoch={2} />);
  expect(requests()).toHaveLength(2);
  expect(requests()[1]).toMatchObject({ type: "files.list", path: null });
});

it("keeps the current folder on failed jumps and uses real parents", () => {
  render(<ComputerFiles connectionEpoch={1} send={send} onFileMessage={onFileMessage} onClose={() => undefined} />);
  emit({ v: 8, type: "files.list.result", requestId: requests()[0].requestId, path: null, entries: [] });
  fireEvent.change(screen.getByLabelText("目录路径"), { target: { value: "C:\\deep\\folder" } });
  fireEvent.click(screen.getByText("跳转"));
  emit({ v: 8, type: "files.list.result", requestId: requests().at(-1)!.requestId, path: "C:\\deep\\folder", entries: [] });
  fireEvent.change(screen.getByLabelText("目录路径"), { target: { value: "C:\\missing" } });
  fireEvent.click(screen.getByText("跳转"));
  emit({ v: 8, type: "error", requestId: requests().at(-1)!.requestId, code: "FILE_COMMAND_FAILED", message: "不存在" });
  expect(screen.getByRole("navigation").textContent).toContain("folder");
  fireEvent.click(screen.getByText("上一级"));
  expect(requests().at(-1)).toMatchObject({ path: "C:\\deep" });
});

it("searches recursively, ignores cancelled results and clears results", () => {
  render(<ComputerFiles connectionEpoch={1} send={send} onFileMessage={onFileMessage} onClose={() => undefined} />);
  emit({ v: 8, type: "files.list.result", requestId: requests()[0].requestId, path: "C:\\", entries: [] });
  fireEvent.change(screen.getByLabelText("搜索文件名"), { target: { value: "report" } });
  fireEvent.click(screen.getByText("搜索"));
  const first = requests().at(-1)!;
  fireEvent.click(screen.getByText("取消"));
  expect(requests().at(-1)).toMatchObject({ type: "files.search.cancel", requestId: first.requestId });
  emit({ v: 8, type: "files.search.result", requestId: first.requestId, path: "C:\\", entries: [], reason: "complete", skipped: 0 });
  expect(screen.queryByText(/找到/)).toBeNull();
  fireEvent.click(screen.getByText("搜索"));
  emit({ v: 8, type: "files.search.result", requestId: requests().at(-1)!.requestId, path: "C:\\", entries: [{ name: "report.txt", path: "C:\\sub\\report.txt", type: "file", size: 10 }], reason: "result-limit", skipped: 1 });
  expect(screen.getByRole("status").textContent).toContain("结果不完整");
  expect(screen.getByText("sub\\report.txt")).toBeTruthy();
  fireEvent.click(screen.getByText("打开所在目录"));
  expect(requests().at(-1)).toMatchObject({ type: "files.list", path: "C:\\sub" });
});
