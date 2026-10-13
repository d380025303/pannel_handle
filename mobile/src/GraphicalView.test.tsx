import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalView } from "./GraphicalView";
import { PROTOCOL_VERSION, type ClientMessage, type GraphicalSnapshot, type RuntimeSession, type ServerMessage } from "./types";

const loginTerminal = vi.hoisted(() => ({ write: vi.fn(), input: null as null | ((data: string) => void) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; open() {} loadAddon() {} reset() {} focus() {} dispose() {}
  write(data: string) { loginTerminal.write(data); }
  onData(callback: (data: string) => void) { loginTerminal.input = callback; return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows Codex child activity cards and translated read-only member status", () => {
  const { emit } = fixture({ ...session, agentProvider: "codex" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, provider: "codex",
    items: [{ id: "activity", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/scout" }],
    subAgents: { expanded: true, selectedThreadId: "child", loading: false, error: null, warning: null,
      members: [{ threadId: "child", parentThreadId: "root", name: "scout", role: "", task: "inspect", status: "completed", createdAt: 0, loading: false, error: null, items: [{ id: "reply", type: "agentMessage", text: "child reply" }] }] }
  } });
  expect(screen.getByText("子 Agent · 开始任务")).toBeTruthy();
  expect(screen.getByText(/scout ·.*已完成/)).toBeTruthy();
  expect(screen.getByText("child reply")).toBeTruthy();
});

it("shows and clears OpenCode retry status from remote snapshots", () => {
  const { emit } = fixture({ ...session, agentProvider: "opencode" });
  const current = { ...snapshot, provider: "opencode" as const, busy: true,
    openCodeRetry: { attempt: 3, nextRetryAt: null, error: { type: "rate-limit", message: "稍后重试", status: 429 } } };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: current });
  expect(screen.getByText(/等待第 3 次自动重试/).textContent).toContain("HTTP 429 · 稍后重试");
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...current, openCodeRetry: null } });
  expect(screen.queryByText(/等待第 3 次自动重试/)).toBeNull();
});

it("shows OpenCode structured results and preserves expanded details on updates", async () => {
  const { emit } = fixture();
  const value = { ...snapshot, provider: "opencode" as const, items: [{ id: "tool", type: "toolCall", toolName: "Edit",
    arguments: false, result: 0, output: "unique output", locations: [{ path: "/work/a", line: 3 }], toolContent: [
      { type: "content", content: { type: "text", text: "unique output" } },
      { type: "diff", path: "/work/a", oldText: "before", newText: "after" },
      { type: "content", content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" } }
    ] }] };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: value });
  fireEvent.click(screen.getByRole("button", { name: /工具调用 · 1 项/ }));
  expect(screen.queryByText("unique output")).toBeNull();
  fireEvent.click(screen.getByText("Edit"));
  await waitFor(() => expect(screen.getAllByText("unique output")).toHaveLength(1));
  expect(screen.getByText("false")).toBeTruthy();
  expect(screen.getByText("0")).toBeTruthy();
  expect(screen.getByText("/work/a:3")).toBeTruthy();
  expect(screen.getByAltText("工具返回的图片")).toBeTruthy();
  fireEvent.click(screen.getByText("/work/a", { selector: "summary" }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...value, busy: true } });
  expect(screen.getByText("before").closest("details")?.open).toBe(true);
  expect(screen.getByText("after")).toBeTruthy();
});

const session: RuntimeSession = { id: "graph-1", title: "Agent", type: "windows", runtimeMode: "app-server", agentProvider: "codex" };
const snapshot: GraphicalSnapshot = {
  threadId: "thread-1", provider: "codex", busy: false, archived: false, error: null,
  mode: "default", nativeMode: null, capabilities: { history: true }, pendingPlan: null,
  items: [{ id: "m1", type: "agentMessage", text: "**完成**" }], approvals: [], questions: []
};

it("renders desktop turn diff cards and preserves expanded files on remote updates", async () => {
  const { emit } = fixture();
  const diff = [
    "diff --git a/src/example.ts b/src/example.ts", "--- a/src/example.ts", "+++ b/src/example.ts",
    "@@ -1 +1 @@", "-before", "+after",
    "diff --git a/assets/logo.png b/assets/logo.png", "Binary files /dev/null and b/assets/logo.png differ"
  ].join("\n");
  const update = (text: string, updatedAt: number) => emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id,
    snapshot: { ...snapshot, turnDiffs: [{ turnId: "turn-1", diff: text, updatedAt }] } });
  update(diff, 1);
  const card = screen.getByText("本轮变更").closest("details")!;
  expect(card.open).toBe(false);
  expect(screen.queryByRole("button", { name: "复制差异" })).toBeNull();
  fireEvent.click(screen.getByText("本轮变更"));
  expect(card.open).toBe(true);
  expect(screen.getByText("2 个文件")).toBeTruthy();
  const file = screen.getByText("src/example.ts").closest("details")!;
  expect(file.open).toBe(false);
  fireEvent.click(screen.getByText("src/example.ts"));
  await waitFor(() => expect(file.open).toBe(true));
  fireEvent(file, new Event("toggle"));
  expect(within(file).getByLabelText("新增 1 行，删除 1 行")).toBeTruthy();
  expect(within(file).getByText("before").closest(".delete")).toBeTruthy();
  expect(within(file).getByText("after").closest(".add")).toBeTruthy();
  expect(screen.getByText("Binary files /dev/null and b/assets/logo.png differ")).toBeTruthy();
  update(diff.replace("+after", "+updated"), 2);
  expect(screen.getByText("updated").closest("details")?.open).toBe(true);
  update("unrecognized diff", 3);
  expect(screen.getByText("unrecognized diff", { selector: "pre" })).toBeTruthy();
  update("", 4);
  expect(screen.getByText("本轮暂无文件差异。")).toBeTruthy();
});

function fixture(viewSession = session, graphicalMenuConfig: import("../../src/utils/graphicalMenu").GraphicalMenuConfig = {}) {
  const send = vi.fn((_message: ClientMessage) => true);
  type GraphicalMessage = Extract<ServerMessage,
    { type: "graphical.snapshot" | "graphical.delta" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "graphical.result" | "graphical.opencode.auth-data" | "graphical.opencode.auth-state" | "command.ok" | "error" }>;
  const listeners = new Set<(message: GraphicalMessage) => void>();
  const subscribe = (callback: (message: GraphicalMessage) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
  let changeEpoch: (value: number) => void = () => {};
  let changeMinimalMode: (value: boolean) => void = () => {};
  function TestView() {
    const [draft, setDraft] = useState("");
    const [epoch, setEpoch] = useState(1);
    const [minimalMode, setMinimalMode] = useState(false);
    changeMinimalMode = setMinimalMode;
    changeEpoch = setEpoch;
    return <GraphicalView minimalMode={minimalMode} session={viewSession} connectionEpoch={epoch} send={send} graphicalMenuConfig={graphicalMenuConfig}
      onGraphicalMessage={subscribe}
      draft={draft} setDraft={setDraft} submissionPending={false} onSubmitRequest={() => {}} />;
  }
  render(<TestView />);
  const emit = (message: GraphicalMessage) => act(() => { for (const listener of listeners) listener(message); });
  const reconnect = () => act(() => changeEpoch(2));
  const disconnect = () => act(() => changeEpoch(0));
  const setMinimalMode = (value: boolean) => act(() => changeMinimalMode(value));
  return { send, emit, reconnect, disconnect, setMinimalMode };
}

it("hides empty Codex reasoning before grouping tools and shows streamed summaries in order", () => {
  const { emit } = fixture();
  const items: GraphicalSnapshot["items"] = [
    { id: "tool-a", type: "commandExecution", turnId: "turn-1" },
    { id: "missing", type: "reasoning" },
    { id: "empty-array", type: "reasoning", summary: [] },
    { id: "empty-string", type: "reasoning", summary: [""] },
    { id: "streamed", type: "reasoning", summary: [" \n", { text: "\t" }, {}], status: "inProgress" },
    { id: "tool-b", type: "commandExecution", turnId: "turn-1" }
  ];
  const update = (nextItems: GraphicalSnapshot["items"]) => emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id,
    snapshot: { ...snapshot, items: nextItems } });
  update(items);
  expect(screen.queryByText("思考过程")).toBeNull();
  expect(screen.queryByText("状态已更新")).toBeNull();
  expect(screen.getAllByRole("button", { name: /工具调用 · 2 项/ })).toHaveLength(1);

  update(items.map(item => item.id === "streamed" ? { ...item, summary: ["分析问题", { text: "检查实现" }] } : item));
  const card = screen.getByText("思考过程").closest("details")!;
  expect(card.querySelector("pre")?.textContent).toBe("分析问题\n\n检查实现");
  const groups = screen.getAllByRole("button", { name: /工具调用 · 1 项/ });
  expect(groups[0].closest("section")?.nextElementSibling).toBe(card);
  expect(card.nextElementSibling).toBe(groups[1].closest("section"));

  update(items.map(item => item.id === "streamed" ? { ...item, status: "completed" } : item));
  expect(screen.queryByText("思考过程")).toBeNull();
});

it("preserves other providers' reasoning text and status event fallback", () => {
  const { emit } = fixture({ ...session, agentProvider: "codebuddy" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: {
    ...snapshot, provider: "codebuddy", items: [{ id: "reason", type: "reasoning", text: "正在检查代码" },
      { id: "review", type: "enteredReviewMode" }]
  } });
  expect(screen.getByText("正在检查代码")).toBeTruthy();
  expect(screen.getByText("思考过程")).toBeTruthy();
  expect(screen.getByText("状态已更新")).toBeTruthy();
});

function openSheet(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: new RegExp(name) }));
  return screen.getByRole("dialog", { name });
}

function modeButton(name: "Plan" | "Exec" | "Full Access") {
  if (!screen.queryByRole("dialog", { name: "更多操作" })) fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  return within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name });
}

function openOpenCodeHistory() {
  const f = fixture({ ...session, agentProvider: "opencode" });
  const current = { ...snapshot, provider: "opencode" as const, capabilities: { history: true, forkHistory: true, deleteHistory: true } };
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: current });
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: /历史记录/ }));
  const request = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.history")!;
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.history", sessionId: session.id, threadId: current.threadId,
    requestId: request.requestId, history: { data: [
      { id: "thread-1", title: "当前会话", updatedAt: 1 }, { id: "old-1", title: "旧会话", updatedAt: 1 }
    ], nextCursor: null } });
  const row = (title: string) => within(screen.getByText(title).closest(".graphical-history-row") as HTMLElement);
  return { ...f, current, row };
}

it("confirms mobile history deletion and refreshes only after success without clearing drafts", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    const f = openOpenCodeHistory();
    expect(f.row("当前会话").getByRole("button", { name: "删除" })).toHaveProperty("disabled", true);
    fireEvent.click(f.row("旧会话").getByRole("button", { name: "删除" }));
    expect(f.send.mock.calls.some(([message]) => message.type === "graphical.delete")).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(f.row("旧会话").getByRole("button", { name: "删除" }));
    const request = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.delete")!;
    expect(request).toMatchObject({ targetThreadId: "old-1", threadId: "thread-1" });
    expect(f.row("旧会话").getByRole("button", { name: "删除" })).toHaveProperty("disabled", true);
    f.emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: request.requestId, sessionId: session.id, threadId: "thread-1" });
    expect(f.send.mock.calls.filter(([message]) => message.type === "graphical.history")).toHaveLength(2);
    expect(screen.getByPlaceholderText("输入消息")).toHaveProperty("value", "草稿");
  } finally { confirm.mockRestore(); }
});

it("keeps history and draft on a failed mobile fork then clears the draft on confirmed success", () => {
  const f = openOpenCodeHistory();
  fireEvent.click(f.row("旧会话").getByRole("button", { name: "分叉" }));
  const request = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.fork")!;
  expect(request).toMatchObject({ targetThreadId: "old-1", threadId: "thread-1" });
  f.emit({ v: PROTOCOL_VERSION, type: "error", requestId: request.requestId, code: "FAILED", message: "分叉失败" });
  expect(screen.getByRole("dialog", { name: "历史对话" })).toBeTruthy();
  expect(screen.getByPlaceholderText("输入消息")).toHaveProperty("value", "草稿");
  fireEvent.click(f.row("旧会话").getByRole("button", { name: "分叉" }));
  const retry = f.send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.fork").at(-1)!;
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...f.current, threadId: "branch" } });
  f.emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: retry.requestId, sessionId: session.id, threadId: "branch" });
  expect(screen.queryByRole("dialog", { name: "历史对话" })).toBeNull();
  expect(screen.getByPlaceholderText("输入消息")).toHaveProperty("value", "");
});

it("ignores history mutation acknowledgements after a different conversation is opened", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  try {
    const f = openOpenCodeHistory();
    fireEvent.click(f.row("旧会话").getByRole("button", { name: "删除" }));
    const request = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.delete")!;
    f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...f.current, threadId: "other" } });
    f.emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: request.requestId, sessionId: session.id, threadId: "thread-1" });
    expect(f.send.mock.calls.filter(([message]) => message.type === "graphical.history")).toHaveLength(1);
    expect(screen.getByPlaceholderText("输入消息")).toHaveProperty("value", "草稿");
  } finally { confirm.mockRestore(); }
});

it("hides unsupported mobile history actions and releases pending history operations on reconnect", () => {
  const f = openOpenCodeHistory();
  fireEvent.click(f.row("旧会话").getByRole("button", { name: "分叉" }));
  f.reconnect();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id,
    snapshot: { ...f.current, capabilities: { history: true } } });
  expect(screen.queryByRole("button", { name: "分叉" })).toBeNull();
  expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  expect(screen.getByPlaceholderText("输入消息")).toHaveProperty("disabled", false);
});

it("subscribes to the selected graphical session and sends text with its thread identity", () => {
  const { send, emit } = fixture();
  expect(send).toHaveBeenCalledWith({ v: PROTOCOL_VERSION, type: "graphical.subscribe", sessionId: "graph-1", delta: true });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  expect(screen.getByText("完成")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "hello" } });
  const submit = screen.getByRole("button", { name: "发送" });
  expect(submit.querySelector("svg[aria-hidden='true']")).toBeTruthy();
  expect(submit.textContent).toBe("");
  fireEvent.click(submit);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.submit", sessionId: "graph-1", threadId: "thread-1", text: "hello" }));
});

it("shows OpenCode token totals and independent context usage from graphical snapshots", () => {
  const { emit } = fixture();
  const tokens = { inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 200, reasoningOutputTokens: 0, totalTokens: 1000 };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1",
    snapshot: { ...snapshot, provider: "opencode", tokenUsage: { total: tokens, last: tokens, modelContextWindow: null },
      contextUsage: { used: 250, size: 1000 }, outputRateAvailable: false } });
  expect(screen.getByText("Token：1,000")).toBeTruthy();
  expect(screen.getByLabelText("上下文用量").textContent).toContain("25.0%");
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1",
    snapshot: { ...snapshot, provider: "opencode", contextUsage: null } });
  expect(screen.queryByLabelText("上下文用量")).toBeNull();
});

it("updates the current message from a delta and resubscribes after a gap", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1",
    snapshot: { ...snapshot, streamId: "stream-1", revision: 1 } });
  emit({ v: PROTOCOL_VERSION, type: "graphical.delta", sessionId: "graph-1", streamId: "stream-1",
    threadId: "thread-1", baseRevision: 1, revision: 2,
    items: [], textDeltas: [{ itemId: "m1", delta: " 新内容" }] });
  expect(screen.getByText(/新内容/)).toBeTruthy();
  emit({ v: PROTOCOL_VERSION, type: "graphical.delta", sessionId: "graph-1", streamId: "stream-1",
    threadId: "thread-1", baseRevision: 4, revision: 5, items: [], textDeltas: [] });
  expect(send.mock.calls.filter(([message]) => message.type === "graphical.subscribe")).toHaveLength(2);
});

it("resubscribes after reconnect without losing the draft", () => {
  const { send, emit, reconnect } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "未发送的草稿" } });
  reconnect();
  expect(send.mock.calls.filter(([message]) => message.type === "graphical.subscribe")).toHaveLength(2);
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("未发送的草稿");
});

it("offers CodeBuddy Plan and Full Access and lets a pending plan return for revision", () => {
  const { send, emit } = fixture({ ...session, agentProvider: "codebuddy" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", mode: "default", executionPermission: "askApproval", nativeMode: "default",
    nativeModes: [{ id: "default", name: "Standard" }, { id: "plan", name: "Plan" },
      { id: "bypassPermissions", name: "Full Access" }]
  } });
  fireEvent.click(modeButton("Plan"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.mode", mode: "plan" }));
  const planRequest = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.mode")!;
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: planRequest.requestId });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", mode: "plan", nativeMode: "plan", executionPermission: "askApproval",
    nativeModes: [{ id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }]
  } });
  fireEvent.click(modeButton("Full Access"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.mode", mode: "default" }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", mode: "plan", nativeMode: "plan", busy: true,
    nativeModes: [{ id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }],
    pendingPlan: { itemId: "plan-1" }, items: [{ id: "plan-1", type: "plan", text: "# 实施计划" }]
  } });
  fireEvent.click(screen.getByRole("button", { name: "继续修改" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.plan", itemId: "plan-1", execute: false }));
});

it("uses saved graphical quick commands and preserves one-time commands on failure", () => {
  const { send, emit } = fixture({ ...session, quickCommands: [
    { id: "write", command: "继续", mode: "write" },
    { id: "auto", command: "检查", mode: "auto-enter" },
    { id: "once", command: "解释", mode: "one-time" }
  ] });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("继续");
  fireEvent.click(screen.getByRole("button", { name: "检查" }));
  const auto = send.mock.calls.map(([message]) => message).find((message): message is Extract<ClientMessage, { type: "quick-command.invoke" }> =>
    message.type === "quick-command.invoke" && message.commandId === "auto");
  expect(auto).toMatchObject({ sessionId: "graph-1", threadId: "thread-1" });
  emit({ v: PROTOCOL_VERSION, type: "error", code: "COMMAND_FAILED", message: "发送失败", requestId: auto!.requestId });
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("继续");
  fireEvent.click(screen.getByRole("button", { name: "解释" }));
  const once = send.mock.calls.map(([message]) => message).find((message): message is Extract<ClientMessage, { type: "quick-command.invoke" }> =>
    message.type === "quick-command.invoke" && message.commandId === "once");
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: once!.requestId });
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("继续解释");
});

it("shows concise CodeBuddy tool summaries and full titles on expansion", async () => {
  const { emit } = fixture();
  const command = "`cd /c/mine/crm/personal/pannel_handle && git diff electron/services/codebuddy-acp/session-service.cjs`";
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", items: [
      { id: "read", type: "toolCall", toolKind: "read", toolName: "Read C:\\work\\session-service.cjs (2 - 71)", status: "completed" },
      { id: "run", type: "toolCall", toolKind: "execute", toolName: command, output: "Show diffs of the two test files", status: "completed" },
      { id: "multiline", type: "toolCall", toolKind: "execute", toolName: "grep -n important src", output: "first line\nsecond line", status: "completed" },
      { id: "long", type: "toolCall", toolKind: "execute", toolName: "node -e run", output: "x".repeat(81), status: "completed" }
    ]
  } });
  fireEvent.click(screen.getByRole("button", { name: /工具调用 · 4 项/ }));
  const summaries = document.querySelectorAll(".graphical-tool summary");
  expect(summaries).toHaveLength(4);
  expect(summaries[0].textContent).toContain("读取文件");
  expect(summaries[0].textContent).toContain("session-service.cjs");
  expect(summaries[0].textContent).not.toContain("C:\\work");
  expect(summaries[1].textContent).toContain("Show diffs of the two test files");
  expect(summaries[1].textContent).not.toContain(command);
  expect(summaries[2].textContent).not.toContain("first line");
  expect(summaries[3].textContent).not.toContain("x".repeat(81));
  fireEvent.click(summaries[1]);
  await waitFor(() => expect(screen.getByText(command)).toBeTruthy());
  expect(screen.getAllByText("Show diffs of the two test files")).toHaveLength(2);
});

it("keeps Codex errors visible in the timeline after the transient error clears", () => {
  const { emit } = fixture();
  const failed = { ...snapshot, error: "额度不足", diagnostics: [{ id: "error-1", turnId: "turn-1", at: 1000,
    message: "额度不足", kind: "UsageLimitExceeded", httpStatusCode: 429, additionalDetails: "稍后重试" }] };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: failed });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...failed, error: null } });
  expect(screen.getByText("额度不足")).toBeTruthy();
  fireEvent.click(screen.getByText("运行错误"));
  expect(screen.getByText("UsageLimitExceeded · HTTP 429")).toBeTruthy();
  expect(screen.getByText("稍后重试")).toBeTruthy();
});

it("shows Codex quota details and refreshes the current thread", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const request = send.mock.calls.map(([message]) => message)
    .find((message): message is Extract<ClientMessage, { type: "graphical.usage" }> => message.type === "graphical.usage");
  expect(request).toMatchObject({ sessionId: "graph-1", threadId: "thread-1", force: false });
  emit({ v: PROTOCOL_VERSION, type: "graphical.usage", sessionId: "graph-1", threadId: "thread-1",
    requestId: request!.requestId, usage: { provider: "codex", fetchedAt: 1000, primaryLimitId: "main",
      limits: [{ id: "main", name: "Codex", usedPercent: 25, remainingPercent: 75, resetsAt: 2000 }] } });
  fireEvent.click(screen.getByRole("button", { name: /Codex 剩余 75%/ }));
  expect(screen.getByRole("region", { name: "额度详情" })).toBeTruthy();
  expect(screen.getByText(/重置时间/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新额度" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.usage", force: true,
    sessionId: "graph-1", threadId: "thread-1" }));
});

it("shows CodeBuddy credits and a retryable quota error", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1",
    snapshot: { ...snapshot, provider: "codebuddy" } });
  const request = send.mock.calls.map(([message]) => message)
    .find((message): message is Extract<ClientMessage, { type: "graphical.usage" }> => message.type === "graphical.usage");
  emit({ v: PROTOCOL_VERSION, type: "error", code: "GRAPHICAL_COMMAND_FAILED", message: "暂不可用",
    requestId: request!.requestId });
  fireEvent.click(screen.getByRole("button", { name: /额度暂不可用/ }));
  expect(screen.getByRole("alert").textContent).toContain("暂不可用");
  fireEvent.click(screen.getByRole("button", { name: "刷新额度" }));
  const retry = send.mock.calls.map(([message]) => message)
    .filter((message): message is Extract<ClientMessage, { type: "graphical.usage" }> => message.type === "graphical.usage").at(-1)!;
  emit({ v: PROTOCOL_VERSION, type: "graphical.usage", sessionId: "graph-1", threadId: "thread-1",
    requestId: retry.requestId, usage: { provider: "codebuddy", fetchedAt: 1000, primaryLimitId: "base",
      summary: { kind: "credits", total: 100, used: 30, remaining: 70, usedPercent: 30, remainingPercent: 70, unit: "Credits" },
      limits: [{ id: "base", name: "基础额度", usedPercent: 30, remainingPercent: 70, totalAmount: 100,
        remainingAmount: 70, unit: "Credits" }] } });
  expect(screen.getByRole("button", { name: /剩余 70 \/ 100 Credits/ })).toBeTruthy();
  expect(screen.getByText(/基础额度/)).toBeTruthy();
});

it("discards quota replies for a previous thread", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const previous = send.mock.calls.map(([message]) => message)
    .find((message): message is Extract<ClientMessage, { type: "graphical.usage" }> => message.type === "graphical.usage")!;
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1",
    snapshot: { ...snapshot, threadId: "thread-2" } });
  const current = send.mock.calls.map(([message]) => message)
    .filter((message): message is Extract<ClientMessage, { type: "graphical.usage" }> => message.type === "graphical.usage").at(-1)!;
  expect(current.threadId).toBe("thread-2");
  emit({ v: PROTOCOL_VERSION, type: "graphical.usage", sessionId: "graph-1", threadId: "thread-1",
    requestId: previous.requestId, usage: { provider: "codex", fetchedAt: 1000, primaryLimitId: "old",
      limits: [{ id: "old", name: "旧额度", usedPercent: 10, remainingPercent: 90 }] } });
  expect(screen.queryByText(/旧额度/)).toBeNull();
  emit({ v: PROTOCOL_VERSION, type: "graphical.usage", sessionId: "graph-1", threadId: "thread-2",
    requestId: current.requestId, usage: { provider: "codex", fetchedAt: 2000, primaryLimitId: "new",
      limits: [{ id: "new", name: "新额度", usedPercent: 20, remainingPercent: 80 }] } });
  expect(screen.getByRole("button", { name: /新额度 剩余 80%/ })).toBeTruthy();
});

it("shows current approval choices and ignores another session's snapshot", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "other", snapshot });
  expect(screen.queryByText("完成")).toBeNull();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, approvals: [{ requestId: "a1", method: "session/request_permission",
      params: { reason: "运行命令", choices: [{ id: "allow_once", label: "允许一次" }, { id: "deny", label: "拒绝" }] } }]
  } });
  fireEvent.click(screen.getByText("允许一次"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.approval", approvalId: "a1", decision: "allow_once" }));
});

it("sends CodeBuddy answers without a Codex note prefix and can cancel", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", questions: [{ requestId: 7, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [
      { id: "q_0", header: "范围", question: "选择范围", multiSelect: true,
        options: [{ label: "前端", description: "" }, { label: "后端", description: "" }] },
      { id: "q_1", header: "说明", question: "补充说明", options: null }
    ] } }]
  } });
  fireEvent.click(screen.getByLabelText("前端"));
  fireEvent.click(screen.getByLabelText("后端"));
  fireEvent.change(screen.getByLabelText("补充说明的自定义回答"), { target: { value: "只改页面" } });
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.answer", questionId: 7,
    answers: { q_0: { answers: ["前端", "后端"] }, q_1: { answers: ["只改页面"] } } }));
  fireEvent.click(screen.getByRole("button", { name: "取消提问" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.cancelQuestion", questionId: 7 }));
});

it("shows current model and effort and sends a Plan mode change", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, model: "gpt-6", models: [{ id: "gpt-6", displayName: "GPT-6" }], effort: "high"
  } });
  const header = document.querySelector(".graphical-header")!;
  expect(within(header as HTMLElement).getByRole("button", { name: "GPT-6" })).toBeTruthy();
  expect(within(header as HTMLElement).getByText("强度：高")).toBeTruthy();
  expect(document.querySelector(".graphical-session-settings")).toBeNull();
  expect(document.querySelector(".graphical-input-border")?.getAttribute("data-mode")).toBe("default");
  fireEvent.click(modeButton("Plan"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.mode", threadId: "thread-1", mode: "plan" }));
  expect((modeButton("Plan") as HTMLButtonElement).disabled).toBe(true);
  const requestId = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.mode")?.requestId;
  emit({ v: PROTOCOL_VERSION, type: "error", requestId, code: "GRAPHICAL_COMMAND_FAILED", message: "切换失败" });
  expect(screen.getByText("切换失败")).toBeTruthy();
  expect((modeButton("Plan") as HTMLButtonElement).disabled).toBe(false);
});

it("switches Plan and Exec over LAN HTTP without crypto.randomUUID", () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });

  fireEvent.click(modeButton("Plan"));
  const modeMessages = () => send.mock.calls.map(([message]) => message)
    .filter((message): message is Extract<ClientMessage, { type: "graphical.mode" }> => message.type === "graphical.mode");
  const plan = modeMessages().find(message => message.mode === "plan");
  expect(plan).toEqual(expect.objectContaining({ sessionId: "graph-1", threadId: "thread-1", requestId: expect.any(String) }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, mode: "plan" } });
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: plan!.requestId });
  expect(modeButton("Plan").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".graphical-input-border")?.getAttribute("data-mode")).toBe("plan");

  fireEvent.click(modeButton("Exec"));
  const exec = modeMessages().find(message => message.mode === "default");
  expect(exec).toEqual(expect.objectContaining({ sessionId: "graph-1", threadId: "thread-1", requestId: expect.any(String) }));
  expect(exec!.requestId).not.toBe(plan!.requestId);
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: exec!.requestId });
  expect(modeButton("Exec").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".graphical-input-border")?.getAttribute("data-mode")).toBe("default");
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, busy: true } });
  expect(document.querySelector(".graphical-input-border")?.classList.contains("is-running")).toBe(true);
  expect((modeButton("Plan") as HTMLButtonElement).disabled).toBe(true);
});

it("shows CodeBuddy native modes and switches any advertised mode", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", mode: "plan", nativeMode: "plan",
    nativeModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }],
    acpOptions: [{ id: "model", currentValue: "glm-5", options: [{ value: "glm-5", name: "GLM 5" }] }]
  } });
  expect(screen.getByRole("button", { name: "GLM 5" })).toBeTruthy();
  const models = openSheet("切换模型");
  expect(within(models).getByRole("button", { name: /GLM 5/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(models).getByRole("button", { name: "关闭弹层" }));
  expect(screen.queryByText("Plan 只读未生效")).toBeNull();
  const modes = openSheet("切换模式");
  expect(within(modes).getByRole("button", { name: /Plan/ }).getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".graphical-input-border")?.getAttribute("data-mode")).toBe("plan");
  fireEvent.click(within(modes).getByRole("button", { name: "Full Access" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.native-mode", modeId: "bypassPermissions" }));
});

it("shows Qoder's two ACP modes and switches to Bypass Permissions", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "qoder", nativeMode: "default", capabilities: { history: true, plan: false },
    nativeModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "Bypass Permissions" }]
  } });
  expect(screen.getByText("Qoder · 就绪")).toBeTruthy();
  const modes = openSheet("切换模式");
  expect(within(modes).queryByRole("button", { name: "Plan" })).toBeNull();
  fireEvent.click(within(modes).getByRole("button", { name: "Bypass Permissions" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.native-mode", modeId: "yolo" }));
});

it("changes Codex permission, keeps a failed choice retryable, and honors supported permissions", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, executionPermission: "askApproval", capabilities: { supportedPermissions: ["askApproval", "fullAccess"] }
  } });
  const permissions = openSheet("执行权限");
  expect((within(permissions).getByRole("button", { name: /只读/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(permissions).getByRole("button", { name: /完全访问/ }));
  const request = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.permission");
  expect(request).toEqual(expect.objectContaining({ threadId: "thread-1", permission: "fullAccess" }));
  emit({ v: PROTOCOL_VERSION, type: "error", code: "COMMAND_FAILED", message: "权限切换失败", requestId: request!.requestId });
  expect(within(permissions).getByRole("alert").textContent).toContain("权限切换失败");
  fireEvent.click(within(permissions).getByRole("button", { name: /完全访问/ }));
  const retry = send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.permission").at(-1)!;
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, executionPermission: "fullAccess" } });
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: retry.requestId });
  expect(screen.queryByRole("dialog", { name: "执行权限" })).toBeNull();
});

it("keeps an OpenCode native mode choice open after failure and retries", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "opencode", nativeMode: "build",
    nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full Access" }]
  } });
  const modes = openSheet("切换模式");
  expect(within(modes).getByRole("button", { name: /Build/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(modes).getByRole("button", { name: "Full Access" }));
  const request = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.native-mode")!;
  emit({ v: PROTOCOL_VERSION, type: "error", code: "COMMAND_FAILED", message: "模式不可用", requestId: request.requestId });
  expect(within(modes).getByRole("alert").textContent).toContain("模式不可用");
  fireEvent.click(within(modes).getByRole("button", { name: "Plan" }));
  const retry = send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.native-mode").at(-1)!;
  expect(retry).toEqual(expect.objectContaining({ modeId: "plan" }));
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: retry.requestId });
  expect(screen.queryByRole("dialog", { name: "切换模式" })).toBeNull();
});

it("executes the latest OpenCode Plan reply without sending the draft", () => {
  const { send, emit } = fixture();
  const planned: GraphicalSnapshot = { ...snapshot, provider: "opencode", nativeMode: "plan", mode: "plan",
    nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }],
    items: [{ id: "old-user", type: "userMessage", text: "旧问题" },
      { id: "old-plan", type: "agentMessage", text: "旧计划" },
      { id: "user", type: "userMessage", text: "制定计划" },
      { id: "plan", type: "agentMessage", text: "实施计划" }] };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...planned, busy: true } });
  expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "保留草稿" } });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: planned });
  const button = screen.getByRole("button", { name: "执行计划" });
  expect(button.closest("article")?.textContent).toContain("实施计划");
  expect(button.closest("article")?.textContent).not.toContain("旧计划");
  fireEvent.click(button);
  fireEvent.click(button);
  const requests = send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.plan");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual(expect.objectContaining({ sessionId: "graph-1", threadId: "thread-1", itemId: "plan", execute: true }));
  expect(send.mock.calls.map(([message]) => message).some(message => message.type === "graphical.submit")).toBe(false);
  expect((screen.getByPlaceholderText("输入消息") as HTMLTextAreaElement).value).toBe("保留草稿");
  emit({ v: PROTOCOL_VERSION, type: "error", code: "COMMAND_FAILED", message: "模式切换失败", requestId: requests[0].requestId });
  expect(screen.getByRole("alert").textContent).toContain("模式切换失败");
  expect((screen.getByRole("button", { name: "执行计划" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
  const retry = send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.plan").at(-1)!;
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...planned, nativeMode: "build", mode: "default" } });
  emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: retry.requestId });
  expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
});

it("hides the OpenCode Build shortcut when unavailable, failed, or followed by a new request", () => {
  const { emit } = fixture();
  const planned: GraphicalSnapshot = { ...snapshot, provider: "opencode", nativeMode: "plan", mode: "plan",
    nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }],
    items: [{ id: "user", type: "userMessage", text: "制定计划" },
      { id: "plan", type: "turnPlan", plan: [{ step: "实施", status: "pending" }] }] };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: planned });
  expect(screen.getByRole("button", { name: "执行计划" })).toBeTruthy();
  for (const changes of [
    { nativeModes: [{ id: "plan", name: "Plan" }] },
    { error: "计划失败" },
    { items: [...planned.items, { id: "next", type: "userMessage", text: "再想想" }] }
  ]) {
    emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...planned, ...changes } });
    expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
  }
});

it("switches advertised Codex and ACP models while idle", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, backend: "openai", model: "a", models: [{ id: "a", displayName: "A" }, { id: "b", displayName: "B" }]
  } });
  let models = openSheet("切换模型");
  fireEvent.click(within(models).getByRole("button", { name: "B" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.model", modelId: "b", threadId: "thread-1" }));
  const requestId = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.model")?.requestId;
  emit({ v: PROTOCOL_VERSION, type: "error", code: "GRAPHICAL_COMMAND_FAILED", message: "切换失败", requestId });
  models = openSheet("切换模型");
  expect(within(models).getByRole("button", { name: /A.*当前使用/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(models).getByRole("button", { name: "关闭弹层" }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "opencode", acpOptions: [{ id: "model", currentValue: "x", options: [{ value: "x", name: "X" }, { value: "y", name: "Y" }] }]
  } });
  models = openSheet("切换模型");
  fireEvent.click(within(models).getByRole("button", { name: "Y" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.model", modelId: "y" }));
});

it("uploads a phone file and sends an attachment-only message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const file = new File(["hello"], "note.txt", { type: "text/plain" });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  const picker = within(screen.getByRole("dialog", { name: "更多操作" })).getByLabelText("添加文件") as HTMLInputElement;
  expect(picker.closest("label")?.textContent).toContain("添加文件");
  fireEvent.change(picker, { target: { files: [file] } });
  expect(screen.getByText(/note.txt · 上传中/)).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(picker.value).toBe("");
  const prepare = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.upload.prepare");
  expect(prepare).toEqual(expect.objectContaining({ name: "note.txt", size: 5, threadId: "thread-1" }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.upload.ready", requestId: prepare!.requestId, fileId: "file-1", url: "/api/v1/upload/file-1?ticket=abc" });
  await waitFor(() => expect(screen.getByText(/note.txt · 已上传/)).toBeTruthy());
  expect(fetch).toHaveBeenCalledWith("/api/v1/upload/file-1?ticket=abc", expect.objectContaining({ method: "POST", body: file }));
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.submit", text: "", fileIds: ["file-1"] }));
});

it("keeps the file sheet open on cancel and accepts the same file again", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const file = new File(["hello"], "note.txt", { type: "text/plain" });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  let picker = within(screen.getByRole("dialog", { name: "更多操作" })).getByLabelText("添加文件") as HTMLInputElement;
  fireEvent.change(picker, { target: { files: [] } });
  expect(screen.getByRole("dialog", { name: "更多操作" })).toBeTruthy();
  fireEvent.change(picker, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  picker = within(screen.getByRole("dialog", { name: "更多操作" })).getByLabelText("添加文件") as HTMLInputElement;
  fireEvent.change(picker, { target: { files: [file] } });
  expect(screen.getAllByText(/note.txt · 上传中/)).toHaveLength(2);
  expect(send.mock.calls.filter(([message]) => message.type === "graphical.upload.prepare")).toHaveLength(2);
});

it("shows the file size error after selection", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  const picker = within(screen.getByRole("dialog", { name: "更多操作" })).getByLabelText("添加文件");
  fireEvent.change(picker, { target: { files: [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.bin")] } });
  expect(screen.getByRole("alert").textContent).toContain("单个附件必须在 10 MB 以内");
  expect(send.mock.calls.some(([message]) => message.type === "graphical.upload.prepare")).toBe(false);
});

it("lets a failed phone upload retry", async () => {
  const upload = vi.fn().mockRejectedValueOnce(new Error("网络中断")).mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", upload);
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  const file = new File(["hello"], "note.txt");
  fireEvent.change(within(screen.getByRole("dialog", { name: "更多操作" })).getByLabelText("添加文件"), { target: { files: [file] } });
  const requests = () => send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.upload.prepare");
  emit({ v: PROTOCOL_VERSION, type: "graphical.upload.ready", requestId: requests()[0].requestId, fileId: "file-1", url: "/api/v1/upload/file-1?ticket=abc" });
  await waitFor(() => expect(screen.getByText(/note.txt · 上传失败/)).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("网络中断");
  fireEvent.click(screen.getByRole("button", { name: /重试上传/ }));
  expect(requests()).toHaveLength(2);
  emit({ v: PROTOCOL_VERSION, type: "graphical.upload.ready", requestId: requests()[1].requestId, fileId: "file-2", url: "/api/v1/upload/file-2?ticket=def" });
  await waitFor(() => expect(screen.getByText(/note.txt · 已上传/)).toBeTruthy());
  expect(upload).toHaveBeenCalledTimes(2);
});

it("confirms a graphical Agent switch in a sheet, tracks failure, and blocks pending work", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const agents = openSheet("切换 Agent");
  fireEvent.click(within(agents).getByRole("button", { name: "CodeBuddy" }));
  expect(screen.getByText(/关闭当前运行会话并启动新会话/)).toBeTruthy();
  expect(send.mock.calls.map(([message]) => message).some(message => message.type === "session.switch-agent")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
  const switchMessage = send.mock.calls.map(([message]) => message).find(message => message.type === "session.switch-agent");
  expect(switchMessage).toEqual(expect.objectContaining({ sessionId: "graph-1", threadId: "thread-1", provider: "codebuddy" }));
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: /切换 Agent/ }).hasAttribute("disabled")).toBe(true);
  emit({ v: PROTOCOL_VERSION, type: "error", code: "COMMAND_FAILED", message: "目标 Agent 不可用", requestId: switchMessage!.requestId });
  expect(screen.getByText("目标 Agent 不可用")).toBeTruthy();
  expect(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: /切换 Agent/ }).hasAttribute("disabled")).toBe(false);
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, busy: true } });
  expect(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: /切换 Agent/ }).hasAttribute("disabled")).toBe(true);
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, pendingPlan: { itemId: "plan-1" }
  } });
  expect(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: /切换 Agent/ }).hasAttribute("disabled")).toBe(true);
});

it("offers Gemini in the graphical Agent switcher", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const agents = openSheet("切换 Agent");
  fireEvent.click(within(agents).getByRole("button", { name: "Gemini" }));
  fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
  expect(send.mock.calls.map(([message]) => message).find(message => message.type === "session.switch-agent"))
    .toMatchObject({ provider: "gemini" });
});

it("offers Grok in the graphical Agent switcher", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const agents = openSheet("切换 Agent");
  fireEvent.click(within(agents).getByRole("button", { name: "Grok" }));
  fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
  expect(send.mock.calls.map(([message]) => message).find(message => message.type === "session.switch-agent"))
    .toMatchObject({ provider: "grok" });
});

it("opens history and starts a new conversation from the single menu", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const more = screen.getByRole("button", { name: "更多操作" });
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const menu = screen.getByRole("dialog", { name: "更多操作" });
  expect(within(menu).getByRole("group", { name: "会话模式" })).toBeTruthy();
  expect(within(menu).getByRole("button", { name: /历史记录/ }).querySelector("svg[aria-hidden='true']")).toBeTruthy();
  expect(within(menu).getAllByRole("button").map(button => button.textContent?.trim()))
    .toEqual(["", "Plan", "Exec", "执行权限未提供", "切换模型未提供", "配置与权限", "Codex 版本", "Skills、Apps 和 MCP", "插件管理", "目标管理", "代码审查", "后台终端", "Codex 账号", "工作区文件", "MCP 配置", "压缩对话", "切换 AgentCodex", "历史记录查看并恢复对话", "新对话"]);
  expect(within(menu).getByLabelText("添加文件").closest("label")?.textContent).toBe("添加文件0/10");
  fireEvent.click(within(menu).getByRole("button", { name: /历史记录/ }));
  expect(screen.getByRole("dialog", { name: "历史对话" })).toBeTruthy();
  const historyRequest = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.history");
  expect(historyRequest).toEqual(expect.objectContaining({ sessionId: "graph-1", threadId: "thread-1" }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.history", sessionId: "graph-1", threadId: "thread-1",
    requestId: historyRequest!.requestId, history: { data: [{ id: "old-1", title: "以前的对话", updatedAt: 1700000000 }], nextCursor: null } });
  fireEvent.click(within(screen.getByRole("dialog", { name: "历史对话" })).getByRole("button", { name: /以前的对话/ }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.resume", targetThreadId: "old-1" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(more);
  fireEvent.click(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: "新对话" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.new-thread", threadId: "thread-1" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("groups adjacent commands and file changes while keeping approvals visible", async () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, items: [
      { id: "cmd-1", turnId: "turn-1", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "file-1", turnId: "turn-1", type: "fileChange", changes: [{ path: "src/App.tsx" }], status: "completed" },
      { id: "cmd-2", turnId: "turn-1", type: "commandExecution", command: "pnpm test", status: "failed" }
    ], approvals: [{ requestId: "approval-1", method: "item/fileChange/requestApproval", params: { reason: "修改文件" } }]
  } });
  const group = screen.getByRole("button", { name: /工具调用 · 3 项/ });
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(group.textContent).toContain("有失败");
  expect(screen.queryByText("pwd")).toBeNull();
  expect(screen.getByText("文件修改确认")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "批准一次" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.approval", approvalId: "approval-1", decision: "accept" }));
  fireEvent.click(group);
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(Array.from(document.querySelectorAll(".graphical-tool-label")).map(node => node.textContent))
    .toEqual(["执行命令", "文件变更", "执行命令"]);
  expect(document.querySelectorAll(".graphical-tool[open]")).toHaveLength(0);
  fireEvent.click(screen.getByText("文件变更"));
  const fileTool = screen.getByText("文件变更").closest("details") as HTMLDetailsElement | null;
  expect(fileTool?.open).toBe(true);
  await waitFor(() => expect(fileTool?.querySelector("pre")?.textContent).toContain("src/App.tsx"));
});

it("separates groups at messages and turns, and preserves expansion through updates", async () => {
  const { emit } = fixture();
  const first = { id: "cmd-1", turnId: "turn-1", type: "commandExecution", command: "pwd", status: "inProgress" };
  const second = { id: "cmd-2", turnId: "turn-1", type: "commandExecution", command: "dir", status: "completed" };
  const items = [first, second, { id: "reply", turnId: "turn-1", type: "agentMessage", text: "检查完成" },
    { id: "cmd-3", turnId: "turn-1", type: "commandExecution", command: "git status", status: "completed" },
    { id: "cmd-4", turnId: "turn-2", type: "commandExecution", command: "pnpm build", status: "completed" }];
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, items } });
  expect(document.querySelectorAll(".graphical-tool-group")).toHaveLength(3);
  const firstGroup = screen.getByRole("button", { name: /工具调用 · 2 项/ });
  fireEvent.click(firstGroup);
  expect(screen.getAllByText("pwd")).toHaveLength(1);
  const firstTool = screen.getAllByText("pwd")[0].closest("details") as HTMLDetailsElement;
  fireEvent.click(firstTool.querySelector("summary")!);
  expect(firstTool.open).toBe(true);
  await waitFor(() => expect(firstTool.querySelector(".graphical-tool-details")).toBeTruthy());
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, items: [{ ...first, output: "done", status: "completed" }, ...items.slice(1)]
  } });
  expect(firstGroup.getAttribute("aria-expanded")).toBe("true");
  expect(firstTool.open).toBe(true);
  expect(firstTool.querySelector(".graphical-tool-details")?.textContent).toContain("done");
  expect(firstGroup.textContent).toContain("已完成");
  expect(screen.getByText("检查完成")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /工具调用 · 1 项/ })).toHaveLength(2);
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, threadId: "thread-2", items } });
  expect(screen.getByRole("button", { name: /工具调用 · 2 项/ }).getAttribute("aria-expanded")).toBe("false");
});

const effortSnapshot: GraphicalSnapshot = { ...snapshot, provider: "opencode", acpOptions: [
  { id: "effort", type: "select", currentValue: "low", options: [
    { value: "low", name: "Low" }, { value: "custom", name: "Custom effort", description: "Provider variant" }
  ] }
] };

it("switches OpenCode effort with live choices and recovers from failure and reconnect", () => {
  const { emit, send, reconnect } = fixture();
  emit({ v: 8, type: "graphical.snapshot", sessionId: "graph-1", snapshot: effortSnapshot });
  let sheet = openSheet("思考强度");
  expect(within(sheet).getByRole("button", { name: /Low.*当前使用/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(sheet).getByRole("button", { name: /Custom effort/ }));
  const request = send.mock.calls.map(([value]) => value).find(value => value.type === "graphical.effort")!;
  expect(request).toEqual(expect.objectContaining({ v: 8, sessionId: "graph-1", threadId: "thread-1", effort: "custom" }));
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect((within(screen.getByRole("dialog")).getByRole("button", { name: /思考强度/ }) as HTMLButtonElement).disabled).toBe(true);
  emit({ v: 8, type: "error", code: "GRAPHICAL_COMMAND_FAILED", message: "强度切换失败", requestId: request.requestId });
  expect(screen.getByRole("alert").textContent).toContain("强度切换失败");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /思考强度/ }));
  sheet = screen.getByRole("dialog", { name: "思考强度" });
  expect(within(sheet).getByRole("button", { name: /Low.*当前使用/ })).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: /Custom effort/ }));
  reconnect();
  sheet = openSheet("思考强度");
  fireEvent.click(within(sheet).getByRole("button", { name: /Custom effort/ }));
  const latest = send.mock.calls.map(([value]) => value).filter(value => value.type === "graphical.effort").at(-1)!;
  emit({ v: 8, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...effortSnapshot,
    acpOptions: [{ ...effortSnapshot.acpOptions![0], currentValue: "custom" }] } });
  emit({ v: 8, type: "command.ok", requestId: latest.requestId });
  sheet = openSheet("思考强度");
  expect(within(sheet).getByRole("button", { name: /Custom effort.*当前使用/ }).getAttribute("aria-pressed")).toBe("true");
  emit({ v: 8, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...effortSnapshot, acpOptions: [] } });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /思考强度/ })).toBeNull();
});

it.each([
  { busy: true }, { archived: true }, { approvals: [{ requestId: 1, method: "approval", params: {} }] },
  { questions: [{ requestId: 1, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [] } }] }
])("disables effort changes while the session is unavailable: %j", state => {
  const { emit, send } = fixture();
  emit({ v: 8, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...effortSnapshot, ...state } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect((within(screen.getByRole("dialog")).getByRole("button", { name: /思考强度/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(send.mock.calls.some(([value]) => value.type === "graphical.effort")).toBe(false);
});

it("keeps effort and model mutations exclusive and clears effort state on thread changes", () => {
  const { emit, send } = fixture();
  const value: GraphicalSnapshot = { ...effortSnapshot, acpOptions: [...effortSnapshot.acpOptions!,
    { id: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }] };
  emit({ v: 8, type: "graphical.snapshot", sessionId: "graph-1", snapshot: value });
  const models = openSheet("切换模型");
  fireEvent.click(within(models).getByRole("button", { name: "B" }));
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect((within(screen.getByRole("dialog")).getByRole("button", { name: /思考强度/ }) as HTMLButtonElement).disabled).toBe(true);
  const model = send.mock.calls.map(([m]) => m).find(m => m.type === "graphical.model")!;
  emit({ v: 8, type: "command.ok", requestId: model.requestId });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /思考强度/ }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Custom effort/ }));
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect((within(screen.getByRole("dialog")).getByRole("button", { name: /切换模型/ }) as HTMLButtonElement).disabled).toBe(true);
  emit({ v: 8, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...value, threadId: "thread-2" } });
  const effort = openSheet("思考强度");
  expect((within(effort).getByRole("button", { name: /Custom effort/ }) as HTMLButtonElement).disabled).toBe(false);
});

it("disables effort while a phone attachment is pending", () => {
  const { emit } = fixture();
  emit({ v: 8, type: "graphical.snapshot", sessionId: "graph-1", snapshot: effortSnapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("添加文件"), {
    target: { files: [new File(["hello"], "note.txt")] }
  });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect((within(screen.getByRole("dialog")).getByRole("button", { name: /思考强度/ }) as HTMLButtonElement).disabled).toBe(true);
});


it("matches desktop permission entry and no-op behavior for busy or unready conversations", () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, busy: true } });
  let sheet = openSheet("执行权限");
  expect(within(sheet).getByRole("button", { name: /完全访问/ })).toHaveProperty("disabled", true);
  fireEvent.click(within(sheet).getByRole("button", { name: "关闭弹层" }));
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, threadId: null, executionPermission: "askApproval"
  } });
  sheet = openSheet("执行权限");
  fireEvent.click(within(sheet).getByRole("button", { name: /完全访问/ }));
  fireEvent.click(within(sheet).getByRole("button", { name: /需要确认/ }));
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.permission")).toBe(false);
});

it("allows archived permission changes regardless of the permissions capability and keeps current choice a no-op", () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, archived: true, executionPermission: "askApproval", capabilities: { permissions: false }
  } });
  const sheet = openSheet("执行权限");
  const current = within(sheet).getByRole("button", { name: /需要确认/ });
  expect(current).toHaveProperty("disabled", false);
  fireEvent.click(current);
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.permission")).toBe(false);
  fireEvent.click(within(sheet).getByRole("button", { name: /完全访问/ }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.permission", permission: "fullAccess" }));
});

it("tracks mode and permission requests independently and does not close a different sheet", () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, executionPermission: "askApproval" } });
  fireEvent.click(modeButton("Plan"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: /执行权限/ }));
  const sheet = screen.getByRole("dialog", { name: "执行权限" });
  const choice = within(sheet).getByRole("button", { name: /完全访问/ });
  fireEvent.click(choice);
  fireEvent.click(choice);
  const permissions = f.send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.permission");
  expect(permissions).toHaveLength(1);
  const mode = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.mode")!;
  f.emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: mode.requestId });
  expect(screen.getByRole("dialog", { name: "执行权限" })).toBeTruthy();
  expect(choice).toHaveProperty("disabled", true);
  fireEvent.click(within(sheet).getByRole("button", { name: "关闭弹层" }));
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(modeButton("Plan")).toHaveProperty("disabled", false);
  f.emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: permissions[0].requestId });
  expect(screen.getByRole("dialog", { name: "更多操作" })).toBeTruthy();
});

it("clears pending permissions on conversation changes and reconnect and ignores stale replies", () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  let sheet = openSheet("执行权限");
  fireEvent.click(within(sheet).getByRole("button", { name: /完全访问/ }));
  const first = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.permission")!;
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: { ...snapshot, threadId: "thread-2" } });
  sheet = openSheet("执行权限");
  const choice = within(sheet).getByRole("button", { name: /完全访问/ });
  expect(choice).toHaveProperty("disabled", false);
  fireEvent.click(choice);
  const second = f.send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.permission").at(-1)!;
  f.emit({ v: PROTOCOL_VERSION, type: "command.ok", requestId: first.requestId });
  expect(choice).toHaveProperty("disabled", true);
  f.disconnect();
  expect(choice).toHaveProperty("disabled", false);
  f.reconnect();
  expect(choice).toHaveProperty("disabled", false);
  f.emit({ v: PROTOCOL_VERSION, type: "error", requestId: second.requestId, code: "COMMAND_FAILED", message: "旧权限错误" });
  expect(screen.queryByText("旧权限错误")).toBeNull();
  expect(screen.getByRole("dialog", { name: "执行权限" })).toBeTruthy();
});


it.each([
  { signedOut: true }, { archived: true }, { compacting: true, busy: true },
  { reviewing: true, busy: true }, { sandboxSettingUp: true }, { mainAgentChanging: true },
  { provider: "opencode" as const, busy: true }
])("blocks ordinary sends for desktop restricted state %j and preserves the draft", state => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留草稿" } });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, ...state } });
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.submit")).toBe(false);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("保留草稿");
});

it("allows Codex messages while busy", () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id,
    snapshot: { ...snapshot, busy: true, executionPermission: "readOnly" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "继续" } });
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.submit")).toBe(true);
});


it("selects Codex reasoning effort from the live model catalog", () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, backend: "openai", model: "gpt", effort: "medium", models: [{ id: "gpt", displayName: "GPT", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "normal" }, { reasoningEffort: "high", description: "deep" }] }] } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: /思考强度/ }));
  fireEvent.click(screen.getByRole("button", { name: /high/ }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.effort", effort: "high" }));
});

it("loads Skills and sends a structured capability reference with the draft", async () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: "Skills、Apps 和 MCP" }));
  const request = f.send.mock.calls.map(([value]) => value).find(value => value.type === "graphical.codex.capabilities")!;
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: snapshot.threadId, requestId: (request as { requestId: string }).requestId,
    result: { skills: [{ name: "example", path: "/work/SKILL.md", description: "test", enabled: true, scope: "project" }], apps: [], mcp: [], errors: {} } });
  await waitFor(() => expect(screen.getByRole("button", { name: "example" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "example" }));
  expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toContain("$example");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.submit", references: [{ kind: "skill", name: "example", path: "/work/SKILL.md", token: "$example" }] }));
});

it("toggles Codex skills, prevents duplicate writes and refreshes the actual state", async () => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  const caps = (enabled: boolean) => ({ skills: [{ name: "example", path: "/work/SKILL.md", description: "test", enabled, scope: "project" }], apps: [], mcp: [], errors: {} });
  const reply = (type: string, result: unknown, error?: string) => {
    const request = f.send.mock.calls.map(([value]) => value).filter(value => value.type === type).at(-1)! as { requestId: string };
    if (error) f.emit({ v: PROTOCOL_VERSION, type: "error", requestId: request.requestId, code: "COMMAND_FAILED", message: error });
    else f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: snapshot.threadId, requestId: request.requestId, result });
  };
  fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "保留草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" })); fireEvent.click(screen.getByRole("button", { name: "Skills、Apps 和 MCP" }));
  reply("graphical.codex.capabilities", caps(true));
  const disable = await screen.findByRole("button", { name: "禁用技能 example" });
  fireEvent.click(disable); fireEvent.click(disable);
  expect(f.send.mock.calls.filter(([value]) => value.type === "graphical.codex.skill-enable")).toHaveLength(1);
  expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "graphical.codex.skill-enable", input: { path: "/work/SKILL.md", enabled: false } }));
  reply("graphical.codex.skill-enable", undefined);
  await waitFor(() => expect(f.send.mock.calls.filter(([value]) => value.type === "graphical.codex.capabilities")).toHaveLength(2));
  reply("graphical.codex.capabilities", caps(false));
  const enable = await screen.findByRole("button", { name: "启用技能 example" });
  expect((screen.getByRole("button", { name: "example · 已停用" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toBe("保留草稿");
  fireEvent.click(enable); reply("graphical.codex.skill-enable", undefined);
  await waitFor(() => expect(f.send.mock.calls.filter(([value]) => value.type === "graphical.codex.capabilities")).toHaveLength(3));
  reply("graphical.codex.capabilities", caps(true));
  await screen.findByRole("button", { name: "禁用技能 example" });
});

it("preserves skill state on write failure and ignores a late write after switching threads", async () => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" })); fireEvent.click(screen.getByRole("button", { name: "Skills、Apps 和 MCP" }));
  const reply = (type: string, result: unknown, error?: string) => {
    const request = f.send.mock.calls.map(([value]) => value).filter(value => value.type === type).at(-1)! as { requestId: string };
    if (error) f.emit({ v: PROTOCOL_VERSION, type: "error", requestId: request.requestId, code: "COMMAND_FAILED", message: error });
    else f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: snapshot.threadId, requestId: request.requestId, result });
  };
  reply("graphical.codex.capabilities", { skills: [{ name: "example", path: "/work/SKILL.md", enabled: true, description: "test", scope: "project" }], apps: [], mcp: [], errors: {} });
  fireEvent.click(await screen.findByRole("button", { name: "禁用技能 example" }));
  reply("graphical.codex.skill-enable", undefined, "保存失败");
  await screen.findByText("保存失败");
  fireEvent.click(screen.getByRole("button", { name: "禁用技能 example" }));
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, threadId: "new" } });
  reply("graphical.codex.skill-enable", undefined);
  await waitFor(() => expect(screen.queryByRole("button", { name: "禁用技能 example" })).toBeNull());
  expect(f.send.mock.calls.filter(([value]) => value.type === "graphical.codex.capabilities")).toHaveLength(1);
});

it("reports a saved skill setting separately from a failed refresh", async () => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  const reply = (type: string, result: unknown) => {
    const request = f.send.mock.calls.map(([value]) => value).filter(value => value.type === type).at(-1)! as { requestId: string };
    f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: snapshot.threadId, requestId: request.requestId, result });
  };
  fireEvent.click(screen.getByRole("button", { name: "更多操作" })); fireEvent.click(screen.getByRole("button", { name: "Skills、Apps 和 MCP" }));
  reply("graphical.codex.capabilities", { skills: [{ name: "example", path: "/work/SKILL.md", enabled: true, description: "test", scope: "project" }], apps: [], mcp: [], errors: {} });
  fireEvent.click(await screen.findByRole("button", { name: "禁用技能 example" }));
  reply("graphical.codex.skill-enable", undefined);
  await waitFor(() => expect(f.send.mock.calls.filter(([value]) => value.type === "graphical.codex.capabilities")).toHaveLength(2));
  reply("graphical.codex.capabilities", { skills: [], apps: [], mcp: [], errors: { skills: "读取失败" } });
  await screen.findByText("已保存，刷新失败：读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(f.send.mock.calls.filter(([value]) => value.type === "graphical.codex.skill-enable")).toHaveLength(1);
});

it("ignores a late capabilities response after the conversation changes", async () => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" })); fireEvent.click(screen.getByRole("button", { name: "Skills、Apps 和 MCP" }));
  const request = f.send.mock.calls.map(([value]) => value).find(value => value.type === "graphical.codex.capabilities")!;
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, threadId: "new" } });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: snapshot.threadId, requestId: (request as { requestId: string }).requestId, result: { skills: [{ name: "stale" }], apps: [], mcp: [], errors: {} } });
  await waitFor(() => expect(screen.queryByText("stale")).toBeNull());
});

it("clears a pending advanced request on disconnect and supports reopening", async () => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" })); fireEvent.click(screen.getByRole("button", { name: "Skills、Apps 和 MCP" }));
  f.disconnect();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("连接中断"));
  f.reconnect();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(f.send.mock.calls.filter(([value]) => value.type === "graphical.codex.capabilities")).toHaveLength(2);
});


it("retains a fast-mode request across the host's temporary restarting snapshot", async () => {
  const f = fixture(); const current = { ...snapshot, backend: "openai", fastMode: false };
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: current });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" })); fireEvent.click(screen.getByRole("button", { name: /快速模式/ }));
  const request = f.send.mock.calls.map(([value]) => value).find(value => value.type === "graphical.codex.fast-mode")!;
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...current, threadId: null } });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...current, fastMode: true } });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: current.threadId, requestId: (request as { requestId: string }).requestId, result: null });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText("快速模式")).toBeTruthy();
});

it.each(["form", "openai/form"] as const)("renders %s MCP tool approval and sends an empty object on mobile", async mode => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot,
    elicitations: [{ requestId: 9, submitting: false, params: { threadId: "thread-1", serverName: "pannel_handle_remote", mode,
      message: 'Allow the pannel_handle_remote MCP server to run tool "remote_exec"?', requestedSchema: { type: "object", properties: {} } } }] } });
  expect(screen.getByText("是否允许 pannel_handle_remote 调用工具 remote_exec？")).toBeTruthy();
  expect(screen.queryByLabelText("JSON 表单内容")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "允许" }));
  await waitFor(() => expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codex.elicitation",
    input: { requestId: 9, action: "accept", content: {} } })));
});

it.each([["拒绝", "decline"], ["取消", "cancel"]] as const)("sends MCP tool approval %s on mobile", async (label, action) => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot,
    elicitations: [{ requestId: 9, submitting: false, params: { threadId: "thread-1", serverName: "pannel_handle_remote", mode: "form",
      message: 'Allow the pannel_handle_remote MCP server to run tool "remote_exec"?', requestedSchema: { type: "object" } } }] } });
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codex.elicitation",
    input: { requestId: 9, action, content: undefined } })));
});

it("uses the same MCP schema form validation and submits the mobile response", async () => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, elicitations: [{ requestId: 9, submitting: false, params: { threadId: "thread-1", serverName: "test", mode: "form", message: "details", requestedSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"] } } }] } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("请填写"));
  fireEvent.change(screen.getByLabelText(/count/), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codex.elicitation", input: { requestId: 9, action: "accept", content: { count: 2 } } }));
});

it("opens Apps from the slash picker without sending the command as a message", () => {
  const f = fixture(); f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "/apps" } });
  fireEvent.click(screen.getByRole("option", { name: /apps/ }));
  expect(screen.getByRole("tab", { name: "Apps" }).getAttribute("aria-selected")).toBe("true");
  expect(f.send.mock.calls.some(([value]) => value.type === "graphical.submit")).toBe(false);
});


it.each([
  { capabilities: null, type: "boolean", option: true },
  { capabilities: {}, type: "boolean", option: true },
  { capabilities: { multitask: false }, type: "boolean", option: true },
  { capabilities: { multitask: true }, type: "select", option: true },
  { capabilities: { multitask: true }, type: undefined, option: true },
  { capabilities: { multitask: true }, type: "boolean", option: false }
])("hides unsupported mobile Multitask controls: %j", ({ capabilities, type, option }) => {
  const f = fixture({ ...session, agentProvider: "codebuddy" });
  const buddy: GraphicalSnapshot = { ...snapshot, provider: "codebuddy", codeBuddyMobile: true, capabilities,
    acpOptions: option ? [{ id: "multitask", type, currentValue: true, options: [] }] : [] };
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: buddy });
  fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "/multitask" } });
  expect(screen.queryByRole("option", { name: /multitask/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: /会话配置/ }));
  expect(screen.queryByRole("checkbox", { name: "Multitask" })).toBeNull();
});

it.each([true, false, "true"])("uses strict boolean mobile Multitask state: %j", currentValue => {
  const f = fixture({ ...session, agentProvider: "codebuddy" });
  const buddy: GraphicalSnapshot = { ...snapshot, provider: "codebuddy", codeBuddyMobile: true, capabilities: { multitask: true },
    acpOptions: [{ id: "multitask", type: "boolean", currentValue, options: [] }] };
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: buddy });
  fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "/multitask" } });
  fireEvent.click(screen.getByRole("option", { name: /multitask/i }));
  const checkbox = screen.getByRole("checkbox", { name: "Multitask" }) as HTMLInputElement;
  expect(checkbox.checked).toBe(currentValue === true);
  fireEvent.click(checkbox);
  expect(checkbox.disabled).toBe(true);
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codebuddy.multitask", input: { enabled: currentValue !== true } }));
});

it("updates mobile Multitask availability and disables it during a turn", () => {
  const f = fixture({ ...session, agentProvider: "codebuddy" });
  const buddy: GraphicalSnapshot = { ...snapshot, provider: "codebuddy", codeBuddyMobile: true, capabilities: { multitask: true },
    acpOptions: [{ id: "multitask", type: "boolean", currentValue: false, options: [] }] };
  const emit = (value: GraphicalSnapshot) => f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: value });
  emit(buddy);
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: /会话配置/ }));
  emit({ ...buddy, busy: true });
  const checkbox = screen.getByRole("checkbox", { name: "Multitask" }) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  checkbox.click();
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.codebuddy.multitask")).toBe(false);
  emit({ ...buddy, capabilities: { multitask: false } });
  expect(screen.queryByRole("checkbox", { name: "Multitask" })).toBeNull();
  emit(buddy);
  expect((screen.getByRole("checkbox", { name: "Multitask" }) as HTMLInputElement).disabled).toBe(false);
});

it("keeps CLI advertised Multitask commands as drafts when the local control is unavailable", () => {
  const f = fixture({ ...session, agentProvider: "codebuddy" });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: {
    ...snapshot, provider: "codebuddy", codeBuddyMobile: true, capabilities: { multitask: false },
    availableCommands: [{ name: "multitask", description: "CLI command" }]
  } });
  const input = screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "/multitask" } });
  fireEvent.click(screen.getByRole("option", { name: /multitask/i }));
  expect(input.value).toBe("/multitask ");
  expect(screen.queryByRole("dialog", { name: "CodeBuddy 会话配置" })).toBeNull();
});

it("offers complete CodeBuddy menus and leaves unsupported hosts compatible", () => {
  const { emit, send } = fixture({ ...session, agentProvider: "codebuddy" });
  const buddy = { ...snapshot, provider: "codebuddy" as const, codeBuddyMobile: true, capabilities: { history: true, sideQuestion: true } };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: buddy });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  for (const name of ["目标管理", "独立旁问", "CLI 版本", "插件管理", "定时任务", "后台智能体", "MCP 管理"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "目标管理" }));
  expect(screen.getByRole("dialog", { name: "CodeBuddy 目标管理" })).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("写下可验证的完成条件"), { target: { value: "finish tests" } });
  fireEvent.click(screen.getByRole("button", { name: "创建目标" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codebuddy.goal.set", input: expect.objectContaining({ objective: "finish tests" }) }));
});

it("shows CodeBuddy teams and confirms rewind using desktop scopes", () => {
  const { emit, send } = fixture({ ...session, agentProvider: "codebuddy" });
  const buddy = { ...snapshot, provider: "codebuddy" as const, codeBuddyMobile: true, capabilities: { history: true, rewind: true },
    team: { name: "builders", isAutoTeam: false, hasLiveMembers: true, members: [{ name: "worker", status: "idle", items: [{ id: "member-msg", type: "agentMessage", text: "member result" }] }] },
    items: [{ id: "user", type: "userMessage", text: "implement", rewindMessageId: "msg" }] };
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: buddy });
  expect(screen.getByText("member result")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "回退到此处" }));
  fireEvent.change(screen.getByRole("combobox", { name: "回退范围" }), { target: { value: "CodeAndConversation" } });
  fireEvent.click(screen.getByRole("button", { name: "确认回退" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codebuddy.rewind", input: { messageId: "msg", scope: "CodeAndConversation" } }));
});

it("hides new CodeBuddy operations when connected to an old host", () => {
  const { emit } = fixture({ ...session, agentProvider: "codebuddy" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, provider: "codebuddy" } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(screen.queryByRole("button", { name: "插件管理" })).toBeNull();
  expect(screen.getByText("更新桌面宿主后可使用完整 CodeBuddy 功能。")).toBeTruthy();
});


it("keeps CodeBuddy side questions available while the main task runs and rejects pending RPC on disconnect", async () => {
  const { emit, send, disconnect } = fixture({ ...session, agentProvider: "codebuddy" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, provider: "codebuddy", codeBuddyMobile: true, busy: true, capabilities: { sideQuestion: true } } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: "独立旁问" }));
  fireEvent.change(screen.getByRole("textbox", { name: "旁问问题" }), { target: { value: "what changed?" } });
  fireEvent.click(screen.getByRole("button", { name: "发送旁问" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codebuddy.side-question", input: { question: "what changed?" } }));
  disconnect();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("连接中断"));
});

it("loads CodeBuddy verified service models and confirms a source restart", async () => {
  const { emit, send } = fixture({ ...session, agentProvider: "codebuddy" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, provider: "codebuddy", codeBuddyMobile: true, modelSource: "native", acpOptions: [{ id: "model", currentValue: "native", options: [{ value: "native", name: "Native" }] }] } });
  openSheet("切换模型");
  const requests = send.mock.calls.map(([message]) => message);
  for (const request of requests.filter(message => message.type === "graphical.codebuddy.models" || message.type === "graphical.codebuddy.model-metadata")) {
    if (!("requestId" in request)) continue;
    emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: "thread-1", requestId: ("requestId" in request ? request.requestId : undefined)!, result: request.type === "graphical.codebuddy.models" ? [{ source: "minimax", id: "verified", name: "Verified Model" }] : [] });
  }
  await waitFor(() => expect(screen.getByRole("button", { name: "minimax · Verified Model" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "minimax · Verified Model" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.codebuddy.model-source", input: { source: "minimax", modelId: "verified" } }));
  vi.restoreAllMocks();
});

it("keeps CodeBuddy management actions restricted to Windows hosts", () => {
  const { emit } = fixture({ ...session, type: "ssh", agentProvider: "codebuddy" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, provider: "codebuddy", codeBuddyMobile: true } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(screen.queryByRole("button", { name: "MCP 管理" })).toBeNull();
  expect(screen.queryByRole("button", { name: "后台智能体" })).toBeNull();
  expect(screen.getByRole("button", { name: "目标管理" })).toBeTruthy();
});

function openCodeFixture(extra: Partial<GraphicalSnapshot> = {}) {
  const f = fixture({ ...session, agentProvider: "opencode" });
  const current: GraphicalSnapshot = { ...snapshot, provider: "opencode", openCodeMobile: true, nativeMode: "build", nativeModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }], ...extra };
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: current });
  const reply = (type: string, result: unknown) => {
    const request = f.send.mock.calls.map(([message]) => message).filter(message => message.type === type).at(-1)!;
    f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: current.threadId, requestId: "requestId" in request ? request.requestId : "", result });
  };
  return { ...f, current, reply };
}

it("loads current OpenCode Skills and MCP and inserts prompts without sending", async () => {
  const f = openCodeFixture();
  const sheet = openSheet("Skills 和 MCP");
  f.reply("graphical.opencode.capabilities", { skills: [{ id: "review", name: "Review", description: "Inspect", enabled: true, path: "/review", scope: "project" }], apps: [], mcp: [], errors: {} });
  await waitFor(() => expect(within(sheet).getByRole("button", { name: /Review/ })).toBeTruthy());
  expect(within(sheet).queryByRole("tab", { name: "Apps" })).toBeNull();
  fireEvent.click(within(sheet).getByRole("button", { name: /Review/ }));
  expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toContain("请使用 skill 工具加载 review");
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.submit")).toBe(false);
  const second = openSheet("Skills 和 MCP");
  f.reply("graphical.opencode.capabilities", { skills: [], apps: [], mcp: [{ name: "search", status: "connected", tools: [{ name: "web_search", description: "Search" }] }], errors: {} });
  fireEvent.click(within(second).getByRole("tab", { name: "MCP" }));
  await waitFor(() => expect(within(second).getByRole("button", { name: /web_search/ })).toBeTruthy());
  fireEvent.click(within(second).getByRole("button", { name: /web_search/ }));
  expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toContain("请使用 MCP 工具 web_search");
});

it("shows only advertised OpenCode slash commands and keeps native commands as drafts", () => {
  const f = openCodeFixture({ availableCommands: [{ name: "compact", description: "Compact session" }] });
  const input = screen.getByRole("textbox", { name: "图形对话输入" }); fireEvent.change(input, { target: { value: "/" } });
  expect(screen.getByRole("option", { name: /compact/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /插件|Apps|goal|review/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /compact/ })); expect((input as HTMLTextAreaElement).value).toBe("/compact ");
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.submit")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.submit", text: "/compact" }));
});

it("confirms OpenCode message reverts and preserves the draft on failure", async () => {
  const f = openCodeFixture({ capabilities: { history: true, revertHistory: true }, items: [{ id: "u", type: "userMessage", text: "question", rewindMessageId: "msg" }] });
  fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "回退到此处" }));
  fireEvent.click(screen.getByRole("button", { name: "回退对话与文件" }));
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.opencode.revert")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "确认回退" }));
  const request = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.opencode.revert")!;
  expect(request).toEqual(expect.objectContaining({ input: { messageId: "msg" } }));
  f.emit({ v: PROTOCOL_VERSION, type: "error", code: "GRAPHICAL_COMMAND_FAILED", message: "回退失败", requestId: "requestId" in request ? request.requestId : "" });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("回退失败"));
  expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toBe("my draft");
});

it("starts OpenCode login without a thread, deduplicates terminal output and cancels on close", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); loginTerminal.write.mockClear();
  const f = openCodeFixture({ threadId: null, acpAuth: { status: "idle", generation: 0, error: null, required: true, methods: [{ id: "login", name: "Login", description: "" }] } });
  const sheet = openSheet("登录 OpenCode"); fireEvent.click(within(sheet).getByRole("button", { name: "开始登录" }));
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.opencode.auth-data", id: session.id, generation: 7, seq: 2, data: "second" });
  f.reply("graphical.opencode.auth-start", { generation: 7, seq: 1, history: "first" });
  await waitFor(() => expect(loginTerminal.write).toHaveBeenCalledWith("second"));
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.opencode.auth-data", id: session.id, generation: 7, seq: 2, data: "second" });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.opencode.auth-data", id: session.id, generation: 8, seq: 3, data: "foreign" });
  expect(loginTerminal.write.mock.calls).toEqual([["first"], ["second"]]);
  act(() => loginTerminal.input?.("\r"));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.opencode.auth-write", input: { generation: 7, data: "\r" } }));
  fireEvent.click(within(sheet).getByRole("button", { name: "关闭弹层" }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.opencode.auth-cancel", input: { generation: 7 } }));
});

it("disables advanced OpenCode entries against older hosts", () => {
  openCodeFixture({ openCodeMobile: false }); fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(screen.getByRole("button", { name: "Skills 和 MCP" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("更新桌面宿主后可使用完整 OpenCode 功能。")).toBeTruthy();
});

it("refreshes OpenCode capabilities after failure and keeps disconnected MCP tools disabled", async () => {
  const f = openCodeFixture(), sheet = openSheet("Skills 和 MCP");
  const request = f.send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.opencode.capabilities")!;
  f.emit({ v: PROTOCOL_VERSION, type: "error", code: "GRAPHICAL_COMMAND_FAILED", message: "能力读取失败", requestId: "requestId" in request ? request.requestId : "" });
  await waitFor(() => expect(within(sheet).getByRole("alert").textContent).toContain("能力读取失败"));
  fireEvent.click(within(sheet).getByRole("button", { name: "刷新" }));
  f.reply("graphical.opencode.capabilities", { skills: [], apps: [], mcp: [{ name: "offline", status: "failed", tools: [{ name: "offline_tool", description: "Unavailable" }] }], errors: {} });
  fireEvent.click(within(sheet).getByRole("tab", { name: "MCP" }));
  await waitFor(() => expect(within(sheet).getByRole("button", { name: /offline_tool/ }).hasAttribute("disabled")).toBe(true));
});

it("restores a staged OpenCode revert and refreshes the snapshot", async () => {
  const f = openCodeFixture({ openCodeRevert: { messageID: "msg" }, capabilities: { history: true, revertHistory: true } });
  fireEvent.click(screen.getByRole("button", { name: "恢复回退" }));
  const sheet = screen.getByRole("dialog", { name: "回退与恢复" });
  fireEvent.click(within(sheet).getByRole("button", { name: "恢复回退" }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.opencode.restore", input: {} }));
  f.reply("graphical.opencode.restore", { ...f.current, openCodeRevert: null });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...f.current, openCodeRevert: null } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("对话已回退；发送新消息将提交回退。")).toBeNull();
});

it("shows the OpenCode version upgrade confirmation before invoking update", async () => {
  const f = openCodeFixture(), sheet = openSheet("CLI 版本");
  f.reply("graphical.opencode.version", { status: "available", currentVersion: "2.0.18", latestVersion: "2.0.19", method: "npm", environment: "windows" });
  await waitFor(() => expect(within(sheet).getByRole("button", { name: /更新 OpenCode/ })).toBeTruthy());
  fireEvent.click(within(sheet).getByRole("button", { name: /更新 OpenCode/ }));
  expect(f.send.mock.calls.some(([message]) => message.type === "graphical.opencode.version-update")).toBe(false);
  fireEvent.click(within(sheet).getByRole("button", { name: /确认更新/ }));
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.opencode.version-update" }));
  f.reply("graphical.opencode.version-update", { status: "current", currentVersion: "2.0.19", latestVersion: "2.0.19", environment: "windows", restartRequired: true });
  await waitFor(() => expect(within(sheet).getByText(/手动重启会话/)).toBeTruthy());
});

it("disables OpenCode mutations while waiting for a Question", () => {
  openCodeFixture({ questions: [{ requestId: 1, submitting: false, params: { threadId: "thread-1", turnId: "turn", questions: [{ id: "q", header: "Question", question: "Choose", options: [{ label: "A", description: "" }] }] } }] });
  expect(screen.getByRole("button", { name: "Build" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: /登录 OpenCode/ }).hasAttribute("disabled")).toBe(true);
});


it("reads Codex configuration and selects named permissions through mobile commands", async () => {
  const f = fixture();
  const state = { ...snapshot, executionPermission: "askApproval", permissionProfileId: null };
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: state });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: "配置与权限" }));
  const request = f.send.mock.calls.map(([m]) => m).find(m => m.type === "graphical.codex.configuration")! as Extract<ClientMessage, { type: `graphical.codex.${string}` }>;
  expect(request).toMatchObject({ threadId: "thread-1", sessionId: session.id });
  const result = { cwd: "/remote", config: { status: "ready", data: { values: { model: "test" }, layers: [] } },
    requirements: { status: "ready", data: null }, profiles: { status: "ready", data: [{ id: "project", allowed: true, reason: null }, { id: "denied", allowed: false, reason: "管理员禁止" }] },
    legacy: [{ id: "askApproval", allowed: true, reason: null }], runtime: { mode: "default", executionPermission: "askApproval", permissionProfileId: null } };
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: "thread-1", requestId: ("requestId" in request ? request.requestId : undefined)!, result });
  await screen.findByText("工作区：/remote");
  expect((screen.getByRole("button", { name: "denied" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "project" }));
  await waitFor(() => expect(f.send.mock.calls.map(([m]) => m).some(m => m.type === "graphical.codex.permission-profile")).toBe(true));
  const select = f.send.mock.calls.map(([m]) => m).find(m => m.type === "graphical.codex.permission-profile")! as Extract<ClientMessage, { type: `graphical.codex.${string}` }>;
  expect(select).toMatchObject({ input: { profileId: "project" } });
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: "thread-1", requestId: ("requestId" in select ? select.requestId : undefined)!, result: {} });
  await waitFor(() => expect(f.send.mock.calls.map(([m]) => m).filter(m => m.type === "graphical.codex.configuration")).toHaveLength(2));
  const refresh = f.send.mock.calls.map(([m]) => m).filter(m => m.type === "graphical.codex.configuration").at(-1)! as Extract<ClientMessage, { type: `graphical.codex.${string}` }>;
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.result", sessionId: session.id, threadId: "thread-1", requestId: ("requestId" in refresh ? refresh.requestId : undefined)!, result: { ...result, runtime: { ...result.runtime, permissionProfileId: "project" } } });
  await waitFor(() => expect(screen.getByRole("button", { name: "project" }).getAttribute("aria-pressed")).toBe("true"));
});

it("exposes configuration recovery when a saved profile prevents creating a thread", async () => {
  const f = fixture();
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: { ...snapshot, threadId: null, permissionError: "权限档已失效" } });
  expect(screen.getByRole("alert").textContent).toContain("权限档已失效");
  fireEvent.click(screen.getByRole("button", { name: "配置与权限" }));
  expect(f.send.mock.calls.map(([m]) => m).find(m => m.type === "graphical.codex.configuration")).toMatchObject({ threadId: null });
});


it("rejects phone images before upload while allowing ordinary files for a text-only model", async () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id,
    snapshot: { ...snapshot, model: "text", models: [{ id: "text", displayName: "Text", inputModalities: ["text"] }] } });
  expect(screen.getByText("当前模型不支持图片输入")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  const picker = within(screen.getByRole("dialog", { name: "更多操作" })).getByLabelText("添加文件") as HTMLInputElement;
  fireEvent.change(picker, { target: { files: [new File(["image"], "photo.bmp"), new File(["hello"], "notes.txt")] } });
  const prepares = send.mock.calls.map(([message]) => message).filter(message => message.type === "graphical.upload.prepare");
  expect(prepares).toHaveLength(1);
  expect(prepares[0]).toMatchObject({ name: "notes.txt" });
  expect(screen.queryByText(/photo.bmp/)).toBeNull();
});


it("preserves the phone draft and uploaded image when model capabilities change", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  const { send, emit } = fixture();
  const update = (inputModalities: string[]) => emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id,
    snapshot: { ...snapshot, model: "m", models: [{ id: "m", displayName: "M", inputModalities }] } });
  update(["text", "image"]);
  fireEvent.change(screen.getByRole("textbox", { name: "图形对话输入" }), { target: { value: "保留草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.change(within(screen.getByRole("dialog", { name: "更多操作" })).getByLabelText("添加文件"),
    { target: { files: [new File(["image"], "photo.png", { type: "image/png" })] } });
  const prepare = send.mock.calls.map(([m]) => m).find(m => m.type === "graphical.upload.prepare")!;
  emit({ v: PROTOCOL_VERSION, type: "graphical.upload.ready", requestId: ("requestId" in prepare ? prepare.requestId : undefined)!, fileId: "image-1", url: "/upload" });
  await screen.findByText(/photo.png · 已上传/);
  update(["text"]);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(send.mock.calls.some(([m]) => m.type === "graphical.submit")).toBe(false);
  expect((screen.getByRole("textbox", { name: "图形对话输入" }) as HTMLTextAreaElement).value).toBe("保留草稿");
  expect(screen.getByText(/photo.png · 已上传/)).toBeTruthy();
});


it.each([true, false])("reviews idle CodeBuddy worker plans on mobile: execute=%s", execute => {
  const { send, emit } = fixture({ ...session, agentProvider: "codebuddy" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", mode: "default", nativeMode: "default", busy: false,
    pendingPlan: { itemId: "worker-plan" }, items: [{ id: "worker-plan", type: "plan", text: "# Worker plan" }]
  } });
  expect(screen.getByText("# Worker plan")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: execute ? "执行计划" : "继续修改" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.plan", itemId: "worker-plan", execute }));
});


it("uses host menu settings, returns to primary, and preserves nested new-thread handling", () => {
  const { emit, send } = fixture(session, { codex: ["new-thread", "model"] });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  const sheet = screen.getByRole("dialog", { name: "更多操作" });
  expect(within(sheet).queryByRole("button", { name: "新对话" })).toBeNull();
  fireEvent.click(within(sheet).getByRole("button", { name: "其他操作" }));
  expect(within(sheet).getByRole("button", { name: /切换模型/ }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(within(sheet).getByRole("button", { name: /返回更多操作/ }));
  expect(within(sheet).queryByRole("button", { name: "新对话" })).toBeNull();
  fireEvent.click(within(sheet).getByRole("button", { name: "其他操作" }));
  fireEvent.click(within(sheet).getByRole("button", { name: "新对话" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.new-thread", sessionId: session.id, threadId: snapshot.threadId }));
  expect(screen.queryByRole("dialog", { name: "更多操作" })).toBeNull();
});


it.each(["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"] as const)("hides %s reasoning immediately and restores streamed content without resubscribing", provider => {
  const f = fixture({ ...session, agentProvider: provider });
  const items: GraphicalSnapshot["items"] = [
    { id: "tool-a", type: "commandExecution", turnId: "turn-1" },
    { id: "reason", type: "reasoning", text: "分析问题", summary: ["分析问题"] },
    { id: "tool-b", type: "commandExecution", turnId: "turn-1" },
    { id: "answer", type: "agentMessage", text: "保留回答" }
  ];
  const update = (text: string) => f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id,
    snapshot: { ...snapshot, provider, items: items.map(item => item.id === "reason" ? { ...item, text, summary: [text] } : item) } });
  update("分析问题");
  expect(screen.getByText("思考过程")).toBeTruthy();
  const subscriptions = f.send.mock.calls.filter(([message]) => message.type === "graphical.subscribe").length;
  f.setMinimalMode(true);
  expect(screen.queryByText("思考过程")).toBeNull();
  expect(screen.getByText("保留回答")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /工具调用 · 2 项/ })).toHaveLength(1);
  update("新增思考内容");
  expect(screen.queryByText("新增思考内容")).toBeNull();
  f.setMinimalMode(false);
  expect(screen.getByText("新增思考内容")).toBeTruthy();
  expect(f.send.mock.calls.filter(([message]) => message.type === "graphical.subscribe")).toHaveLength(subscriptions);
});


it.each(["codex", "codebuddy"] as const)("applies minimal mode to %s member timelines", provider => {
  const f = fixture({ ...session, agentProvider: provider });
  const items = [{ id: "reason", type: "reasoning", summary: ["成员思考"], text: "成员思考" },
    { id: "reply", type: "agentMessage", text: "成员回答" }];
  f.emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: session.id, snapshot: {
    ...snapshot, provider,
    ...(provider === "codex" ? { subAgents: { expanded: true, selectedThreadId: "child", loading: false, error: null, warning: null,
      members: [{ threadId: "child", parentThreadId: "root", name: "scout", role: "", task: "inspect", status: "completed", createdAt: 0, loading: false, error: null, items }] } }
      : { team: { name: "builders", isAutoTeam: false, hasLiveMembers: true, members: [{ name: "worker", status: "idle", items }] } })
  } });
  if (provider === "codex") expect(screen.getByText("成员思考")).toBeTruthy();
  else expect(screen.queryByText("成员思考")).toBeNull();
  f.setMinimalMode(true);
  expect(screen.queryByText("成员思考")).toBeNull();
  expect(screen.getByText("成员回答")).toBeTruthy();
  f.setMinimalMode(false);
  if (provider === "codex") expect(screen.getByText("成员思考")).toBeTruthy();
  else expect(screen.queryByText("成员思考")).toBeNull();
});
