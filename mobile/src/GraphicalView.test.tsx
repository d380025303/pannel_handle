import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphicalView } from "./GraphicalView";
import { PROTOCOL_VERSION, type ClientMessage, type GraphicalSnapshot, type RuntimeSession, type ServerMessage } from "./types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const session: RuntimeSession = { id: "graph-1", title: "Agent", type: "windows", runtimeMode: "app-server", agentProvider: "codex" };
const snapshot: GraphicalSnapshot = {
  threadId: "thread-1", provider: "codex", busy: false, archived: false, error: null,
  mode: "default", nativeMode: null, capabilities: { history: true }, pendingPlan: null,
  items: [{ id: "m1", type: "agentMessage", text: "**完成**" }], approvals: [], questions: []
};

function fixture(viewSession = session) {
  const send = vi.fn((_message: ClientMessage) => true);
  type GraphicalMessage = Extract<ServerMessage,
    { type: "graphical.snapshot" | "graphical.usage" | "graphical.history" | "graphical.upload.ready" | "command.ok" | "error" }>;
  const listeners = new Set<(message: GraphicalMessage) => void>();
  const subscribe = (callback: (message: GraphicalMessage) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
  function TestView() {
    const [draft, setDraft] = useState("");
    return <GraphicalView session={viewSession} send={send}
      onGraphicalMessage={subscribe}
      draft={draft} setDraft={setDraft} submissionPending={false} onSubmitRequest={() => {}} />;
  }
  render(<TestView />);
  const emit = (message: GraphicalMessage) => act(() => { for (const listener of listeners) listener(message); });
  return { send, emit };
}

function openSheet(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: new RegExp(name) }));
  return screen.getByRole("dialog", { name });
}

function modeButton(name: "Plan" | "Exec") {
  if (!screen.queryByRole("dialog", { name: "更多操作" })) fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  return within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name });
}

it("subscribes to the selected graphical session and sends text with its thread identity", () => {
  const { send, emit } = fixture();
  expect(send).toHaveBeenCalledWith({ v: PROTOCOL_VERSION, type: "graphical.subscribe", sessionId: "graph-1" });
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  expect(screen.getByText("完成")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("输入消息"), { target: { value: "hello" } });
  fireEvent.click(screen.getByText("发送"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.submit", sessionId: "graph-1", threadId: "thread-1", text: "hello" }));
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

it("shows concise CodeBuddy tool summaries and full titles on expansion", () => {
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
  expect(screen.getByText(command)).toBeTruthy();
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
  expect(within(header as HTMLElement).getByText("模型：GPT-6")).toBeTruthy();
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

it("shows CodeBuddy native Plan as active", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot: {
    ...snapshot, provider: "codebuddy", mode: "plan", nativeMode: "plan",
    nativeModes: [{ id: "default" }, { id: "plan" }],
    acpOptions: [{ id: "model", currentValue: "glm-5", options: [{ value: "glm-5", name: "GLM 5" }] }]
  } });
  expect(screen.getByText("模型：GLM 5")).toBeTruthy();
  const models = openSheet("切换模型");
  expect(within(models).getByRole("button", { name: /GLM 5/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(models).getByRole("button", { name: "关闭弹层" }));
  expect(screen.queryByText("Plan 只读未生效")).toBeNull();
  expect(modeButton("Plan").getAttribute("aria-pressed")).toBe("true");
  expect((modeButton("Plan") as HTMLButtonElement).disabled).toBe(false);
  expect(document.querySelector(".graphical-input-border")?.getAttribute("data-mode")).toBe("plan");
  fireEvent.click(modeButton("Exec"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.mode", mode: "default" }));
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
  const picker = screen.getByLabelText("添加文件") as HTMLInputElement;
  const clickPicker = vi.spyOn(picker, "click").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "更多操作" })).getByRole("button", { name: /添加文件/ }));
  expect(clickPicker).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.change(screen.getByLabelText("添加文件"), { target: { files: [file] } });
  const prepare = send.mock.calls.map(([message]) => message).find(message => message.type === "graphical.upload.prepare");
  expect(prepare).toEqual(expect.objectContaining({ name: "note.txt", size: 5, threadId: "thread-1" }));
  emit({ v: PROTOCOL_VERSION, type: "graphical.upload.ready", requestId: prepare!.requestId, fileId: "file-1", url: "/api/v1/upload/file-1?ticket=abc" });
  await waitFor(() => expect(screen.getByText(/note.txt · 已上传/)).toBeTruthy());
  expect(fetch).toHaveBeenCalledWith("/api/v1/upload/file-1?ticket=abc", expect.objectContaining({ method: "POST", body: file }));
  fireEvent.click(screen.getByText("发送"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.submit", text: "", fileIds: ["file-1"] }));
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

it("opens history and starts a new conversation from the single menu", () => {
  const { send, emit } = fixture();
  emit({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "graph-1", snapshot });
  const more = screen.getByRole("button", { name: "更多操作" });
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  const menu = screen.getByRole("dialog", { name: "更多操作" });
  expect(within(menu).getByRole("group", { name: "会话模式" })).toBeTruthy();
  expect(within(menu).getAllByRole("button").map(button => button.textContent?.trim()))
    .toEqual(["×", "Plan", "Exec", "切换模型未提供", "切换 AgentCodex", "历史记录查看并恢复对话", "新对话", "添加文件0/10"]);
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

it("groups adjacent commands and file changes while keeping approvals visible", () => {
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
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.approval", approvalId: "approval-1", decision: true }));
  fireEvent.click(group);
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(Array.from(document.querySelectorAll(".graphical-tool-label")).map(node => node.textContent))
    .toEqual(["执行命令", "文件变更", "执行命令"]);
  expect(document.querySelectorAll(".graphical-tool[open]")).toHaveLength(0);
  fireEvent.click(screen.getByText("文件变更"));
  const fileTool = screen.getByText("文件变更").closest("details") as HTMLDetailsElement | null;
  expect(fileTool?.open).toBe(true);
  expect(fileTool?.querySelector("pre")?.textContent).toContain("src/App.tsx");
});

it("separates groups at messages and turns, and preserves expansion through updates", () => {
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
  expect(screen.getAllByText("pwd")).toHaveLength(2);
  const firstTool = screen.getAllByText("pwd")[0].closest("details") as HTMLDetailsElement;
  fireEvent.click(firstTool.querySelector("summary")!);
  expect(firstTool.open).toBe(true);
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
