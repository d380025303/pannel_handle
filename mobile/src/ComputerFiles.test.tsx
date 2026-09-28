import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerFiles } from "./ComputerFiles";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "./types";

type FileMessage = Extract<ServerMessage, { type: "files.list.result" | "files.download.ready" | "error" }>;
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
