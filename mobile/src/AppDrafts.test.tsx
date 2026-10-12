import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { useRemoteConnection } from "./useRemoteConnection";
import { PROTOCOL_VERSION, type ClientMessage, type GraphicalSnapshot, type RuntimeSession, type ServerMessage } from "./types";

vi.mock("./useRemoteConnection", () => ({ useRemoteConnection: vi.fn() }));
vi.mock("./TerminalView", () => ({ TerminalView: ({ pasteText, setPasteText, pasteOpen, setPasteOpen }: {
  pasteText: string; setPasteText: (text: string) => void; pasteOpen: boolean; setPasteOpen: (open: boolean) => void;
}) => <div><button onClick={() => setPasteOpen(true)}>粘贴</button>{pasteOpen && <textarea aria-label="终端粘贴" value={pasteText}
  onChange={event => setPasteText(event.target.value)} />}</div> }));

type GraphicalMessage = Extract<ServerMessage,
  { type: "graphical.snapshot" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "graphical.result" | "graphical.opencode.auth-data" | "graphical.opencode.auth-state" | "command.ok" | "error" }>;
const first: RuntimeSession = { id: "graph-1", title: "图形一", type: "windows", runtimeMode: "app-server", agentProvider: "codex" };
const second: RuntimeSession = { ...first, id: "graph-2", title: "图形二" };
const terminal: RuntimeSession = { id: "terminal-1", title: "终端", type: "windows", runtimeMode: "terminal" };
const listeners = new Set<(message: GraphicalMessage) => void>();
const snapshot: GraphicalSnapshot = { threadId: "thread-1", provider: "codex", busy: false, archived: false, error: null,
  mode: "default", nativeMode: null, capabilities: { history: true }, pendingPlan: null, items: [], approvals: [], questions: [] };
let remote: ReturnType<typeof useRemoteConnection>;

function emit(message: GraphicalMessage) {
  act(() => { for (const listener of listeners) listener(message); });
}
function showGraphical(sessionId: string) {
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId, snapshot: { ...snapshot, threadId: `thread-${sessionId}` } });
}
function switchTo(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "打开会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
}

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  remote = { mobileGraphicalSessionMinimalMode: false, graphicalMenuConfig: {}, status: "connected", statusMessage: "已连接", sessions: [first, second, terminal], overviews: {}, templates: [], device: null,
    lastLaunchedId: null, commandError: "", storageWarning: "", connectionEpoch: 1, send: vi.fn(() => true), retry: vi.fn(), login: vi.fn(),
    onWorkItemMessage: vi.fn(() => () => {}), onTerminalMessage: vi.fn(() => () => true),
    onGraphicalMessage: vi.fn(listener => { listeners.add(listener); return () => listeners.delete(listener); }),
    onFileMessage: vi.fn(() => () => true) };
  vi.mocked(useRemoteConnection).mockImplementation(() => remote);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it("restores separate graphical drafts and the terminal paste dialog after switching sessions", () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开图形一详情" }));
  showGraphical(first.id);
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "第一条草稿" } });
  switchTo("图形二");
  showGraphical(second.id);
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "第二条草稿" } });
  switchTo("终端");
  fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
  fireEvent.change(screen.getByRole("textbox", { name: "终端粘贴" }), { target: { value: "待粘贴" } });
  switchTo("图形一");
  showGraphical(first.id);
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("第一条草稿");
  switchTo("图形二");
  showGraphical(second.id);
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("第二条草稿");
  switchTo("终端");
  expect((screen.getByRole("textbox", { name: "终端粘贴" }) as HTMLTextAreaElement).value).toBe("待粘贴");
});

it("handles a submit reply while another session is selected without deleting newer edits", () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开图形一详情" }));
  showGraphical(first.id);
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "待发送" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  const firstRequest = vi.mocked(remote.send).mock.calls.map(([message]) => message)
    .find((message): message is Extract<ClientMessage, { type: "graphical.submit" }> => message.type === "graphical.submit")!;
  switchTo("图形二");
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: firstRequest.requestId });
  switchTo("图形一");
  showGraphical(first.id);
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("");

  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "旧内容" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  const secondRequest = vi.mocked(remote.send).mock.calls.map(([message]) => message)
    .filter((message): message is Extract<ClientMessage, { type: "graphical.submit" }> => message.type === "graphical.submit").at(-1)!;
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "新内容" } });
  switchTo("图形二");
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: secondRequest.requestId });
  switchTo("图形一");
  showGraphical(first.id);
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("新内容");
});

it("keeps a failed graphical submission available for retry after switching away", () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开图形一详情" }));
  showGraphical(first.id);
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "重试内容" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  const request = vi.mocked(remote.send).mock.calls.map(([message]) => message)
    .find((message): message is Extract<ClientMessage, { type: "graphical.submit" }> => message.type === "graphical.submit")!;
  switchTo("图形二");
  emit({ v: PROTOCOL_VERSION, type: "error", requestId: request.requestId, code: "COMMAND_FAILED", message: "失败" });
  switchTo("图形一");
  showGraphical(first.id);
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("重试内容");
  expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(false);
});

it("preserves an OpenCode draft when reconnect replaces the running session", () => {
  remote.sessions = [{ ...first, agentProvider: "opencode" }];
  const view = render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "打开图形一详情" }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: first.id, snapshot: { ...snapshot, provider: "opencode", openCodeMobile: true } });
  fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "draft to keep" } });
  remote.sessions = []; view.rerender(<App />);
  const replacement = { ...first, id: "replacement", agentProvider: "opencode" as const };
  remote.sessions = [replacement]; remote.lastLaunchedId = replacement.id; view.rerender(<App />);
  emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: first.id, threadId: "thread-1", requestId: "reconnect", result: { id: replacement.id, previousSessionId: first.id } });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: replacement.id, snapshot: { ...snapshot, provider: "opencode", openCodeMobile: true } });
  expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toBe("draft to keep");
});
