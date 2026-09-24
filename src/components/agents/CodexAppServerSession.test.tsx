// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import type { Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession as SessionView, type CodexAppServerSessionHandle } from "./CodexAppServerSession";

function CodexAppServerSession({ sessionId, ref }: { sessionId: string | null; ref?: Ref<CodexAppServerSessionHandle> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!sessionId) return null;
  return <SessionView ref={ref} sessionId={sessionId} draft={drafts[sessionId] ?? ""} setDraft={value => setDrafts(current => {
    const nextDraft = typeof value === "function" ? value(current[sessionId] ?? "") : value;
    return { ...current, [sessionId]: nextDraft };
  })} />;
}

describe("CodexAppServerSession", () => {
  afterEach(cleanup);
  let changed: (payload: any) => void;
  const submit = vi.fn().mockResolvedValue(undefined);
  const resolveApproval = vi.fn().mockResolvedValue(undefined);
  const answerQuestion = vi.fn().mockResolvedValue(undefined);
  const listHistory = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  const newThread = vi.fn().mockResolvedValue({ threadId: "thread-2", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const resume = vi.fn().mockResolvedValue({ threadId: "old-thread", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const setMode = vi.fn().mockImplementation(async (_id, mode) => ({ threadId: "thread-1", mode, busy: false, error: null, items: [], approvals: [] }));
  const setExecutionPermission = vi.fn().mockImplementation(async (_id, executionPermission) => ({
    threadId: "thread-1", mode: "default", executionPermission, busy: false, error: null, items: [], approvals: [] }));
  const chooseFiles = vi.fn().mockResolvedValue([]);
  const pasteImage = vi.fn().mockResolvedValue({ status: "saved", path: "C:\\project\\.pannel-handle-images\\capture.png", size: 3 });
  const discardImage = vi.fn().mockResolvedValue(undefined);
  const executePlan = vi.fn().mockResolvedValue(undefined);
  const dismissPlan = vi.fn().mockImplementation(async () => ({ threadId: "thread-1", mode: "plan", busy: false,
    error: null, pendingPlan: null, items: [{ id: "plan-1", type: "plan", text: "# 正式计划" }], approvals: [] }));

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    submit.mockClear(); resolveApproval.mockClear(); answerQuestion.mockReset().mockResolvedValue(undefined); listHistory.mockReset().mockResolvedValue({ data: [], nextCursor: null }); newThread.mockClear(); resume.mockClear(); setMode.mockClear(); setExecutionPermission.mockClear(); chooseFiles.mockClear(); pasteImage.mockClear(); discardImage.mockClear(); executePlan.mockClear(); dismissPlan.mockClear();
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
      snapshot: vi.fn().mockResolvedValue({ threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, items: [], approvals: [] }),
      submit, interrupt: vi.fn(), resolveApproval, answerQuestion, listHistory,
      resume, newThread, setMode, setExecutionPermission, chooseFiles, pasteImage, discardImage, executePlan, dismissPlan,
      previewAttachment: vi.fn().mockResolvedValue({ kind: "image", dataUrl: "data:image/png;base64,AA==" }),
      onChanged: (callback: typeof changed) => { changed = callback; return () => {}; }
    } });
  });

  it("follows streamed plan text and new lines after the reader scrolls up", async () => {
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(window.codexAppServerApi.snapshot).toHaveBeenCalledWith("run-1"));
    const messages = container.querySelector<HTMLElement>(".codex-app-server-messages")!;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 600 });
    const snapshot = (text: string) => ({ threadId: "thread-1", mode: "plan", busy: true,
      error: null, approvals: [], items: [{ id: "plan-1", type: "plan", text }] });

    act(() => changed({ id: "run-1", snapshot: snapshot("# 计划") }));
    expect(messages.scrollTop).toBe(600);

    messages.scrollTop = 80;
    act(() => changed({ id: "run-1", snapshot: snapshot("# 计划\n第一步") }));
    expect(messages.scrollTop).toBe(600);

    messages.scrollTop = 120;
    act(() => changed({ id: "run-1", snapshot: snapshot("# 计划\n第一步\n第二步") }));
    expect(messages.scrollTop).toBe(600);
  });

  it("opens history from the input menu and keeps icon actions inside the input", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    const composer = container.querySelector(".codex-app-server-composer")!;
    await waitFor(() => expect(screen.getByRole("button", { name: "新对话" })).toHaveProperty("disabled", false));
    expect(container.querySelector(".codex-app-server-toolbar")).toBeNull();
    const inputBorder = container.querySelector(".codex-app-server-input-border")!;
    for (const name of ["更多操作", "新对话", "发送"]) expect(inputBorder.contains(screen.getByRole("button", { name }))).toBe(true);
    expect(composer.querySelector(".codex-app-server-composer-footer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu", { name: "会话操作" });
    const modeGroup = screen.getByRole("group", { name: "模式" });
    const permissionGroup = screen.getByRole("group", { name: "执行权限（下一轮生效）" });
    expect(menu.contains(modeGroup)).toBe(true);
    expect(menu.contains(permissionGroup)).toBe(true);
    expect(modeGroup.querySelectorAll('.codex-app-server-mode-options > [role="menuitemradio"]')).toHaveLength(2);
    expect(permissionGroup.querySelectorAll('.codex-app-server-permission-options > [role="menuitemradio"]')).toHaveLength(3);
    expect(screen.getByRole("menuitemradio", { name: "Exec" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "附加文件" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Exec" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Plan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    const dialog = await screen.findByRole("dialog", { name: "历史会话" });
    expect(composer.contains(dialog)).toBe(false);
    expect(await screen.findByText("会话 ID：old-thread")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "历史会话" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.change(screen.getByPlaceholderText("向 Codex 发送消息"), { target: { value: "新对话前的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await waitFor(() => expect(newThread).toHaveBeenCalledWith("run-1"));
    expect(screen.queryByRole("dialog", { name: "历史会话" })).toBeNull();
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the selected execution permission and disables switching while running", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    expect((await screen.findByText("执行权限：需要确认")).getAttribute("data-permission")).toBe("askApproval");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitemradio", { name: "需要确认" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "完全访问" }));
    await waitFor(() => expect(setExecutionPermission).toHaveBeenCalledWith("run-1", "fullAccess"));
    expect((await screen.findByText("执行权限：完全访问")).getAttribute("data-permission")).toBe("fullAccess");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", executionPermission: "fullAccess",
      busy: true, error: null, items: [], approvals: [] } }));
    expect(screen.getByText("执行权限：完全访问")).toBeTruthy();
    expect(screen.queryByText(/Plan 时只读/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitemradio", { name: "只读" })).toHaveProperty("disabled", true);
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", executionPermission: "readOnly",
      busy: false, error: null, items: [], approvals: [] } }));
    expect(screen.getByText("执行权限：只读").getAttribute("data-permission")).toBe("readOnly");
  });

  it("routes source links through the parent file navigation handler", async () => {
    const onLinkClick = vi.fn();
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [{ id: "reply", type: "agentMessage", text: "[源码](src/App.tsx:42)" }], approvals: []
    });
    render(<SessionView sessionId="run-1" draft="" setDraft={() => {}} onLinkClick={onLinkClick} />);
    fireEvent.click(await screen.findByRole("link", { name: "源码" }));
    expect(onLinkClick).toHaveBeenCalledWith("src/App.tsx:42");
  });

  it("shows conversation content without user or Codex role labels", async () => {
    vi.mocked(window.codexAppServerApi.snapshot).mockResolvedValueOnce({
      threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false, error: null, pendingPlan: null,
      items: [
        { id: "user", type: "userMessage", text: "检查项目" },
        { id: "agent", type: "agentMessage", text: "开始检查" },
        { id: "command", type: "commandExecution", command: "pwd", status: "completed" },
        { id: "progress", type: "agentMessage", text: "继续检查" },
        { id: "command-2", type: "commandExecution", command: "dir", status: "completed" },
        { id: "plan", type: "plan", text: "执行步骤" }
      ], approvals: []
    });
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    expect(await screen.findByText("继续检查")).toBeTruthy();
    expect(container.querySelector(".codex-app-server-message.userMessage")?.textContent).toBe("检查项目");
    expect(container.querySelector(".codex-app-server-message.agentMessage")?.textContent).toBe("开始检查");
    expect(Array.from(container.querySelectorAll(".codex-app-server-message.agentMessage")).map(node => node.textContent))
      .toEqual(["开始检查", "继续检查"]);
    expect(container.querySelector(".codex-app-server-message.plan > strong")?.textContent).toBe("计划");
  });

  it("searches titles and IDs across history pages", async () => {
    listHistory.mockImplementation(async (_id, cursor) => cursor === "next"
      ? { data: [{ id: "second-id", title: "部署记录", updatedAt: 122, source: "cli", status: "notLoaded" }], nextCursor: null }
      : { data: [{ id: "first-id", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: "next" });
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    await screen.findByText("会话 ID：first-id");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "SECOND-ID" } });
    expect(await screen.findByText("会话 ID：second-id")).toBeTruthy();
    expect(screen.queryByText("会话 ID：first-id")).toBeNull();
    expect(listHistory).toHaveBeenCalledWith("run-1", "next");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "之前" } });
    expect(await screen.findByText("会话 ID：first-id")).toBeTruthy();
    expect(screen.queryByText("会话 ID：second-id")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "missing" } });
    expect(await screen.findByText("没有匹配的历史会话。")).toBeTruthy();
  });

  it("keeps the history dialog open and shows errors when listing or resuming fails", async () => {
    listHistory.mockRejectedValueOnce(new Error("读取失败"));
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "读取失败");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史会话" }), { target: { value: "old" } });
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "旧会话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    const item = await screen.findByRole("button", { name: /旧会话/ });
    resume.mockRejectedValueOnce(new Error("恢复失败"));
    fireEvent.click(item);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "恢复失败");
    expect(screen.getByRole("dialog", { name: "历史会话" })).toBeTruthy();
  });

  it("answers multiple App Server questions with choices and free text", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [],
      questions: [{ requestId: 42, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "framework", header: "框架", question: "选择框架", isOther: true,
          options: [{ label: "React", description: "使用 React" }, { label: "Vue", description: "使用 Vue" }] },
        { id: "details", header: "细节", question: "请补充", options: null }
      ] } }] } }));
    expect(screen.getByText("选择框架")).toBeTruthy();
    expect(screen.queryByText("请补充")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(screen.getByRole("alert").textContent).toContain("请回答");
    fireEvent.click(screen.getByRole("radio", { name: /React/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "补充说明或自定义回答" }), { target: { value: "继续" } });
    expect(screen.getByRole("tab", { name: /框架.*已回答/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /细节.*待回答/ }));
    expect(screen.getByText("请补充")).toBeTruthy();
    expect(screen.queryByText("选择框架")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "保持简单" } });
    fireEvent.click(screen.getByRole("tab", { name: /框架.*已回答/ }));
    expect(screen.getByRole("radio", { name: /React/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("textbox", { name: "补充说明或自定义回答" })).toHaveProperty("value", "继续");
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("run-1", 42, {
      framework: { answers: ["React", "user_note: 继续"] }, details: { answers: ["user_note: 保持简单"] }
    }));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, approvals: [], questions: [],
      items: [{ id: "question-answer:turn-1:42", type: "questionAnswer", turnId: "turn-1", status: "completed", questions: [
        { id: "framework", header: "框架", question: "选择框架", answers: ["React", "user_note: 继续"] },
        { id: "details", header: "细节", question: "请补充", answers: ["user_note: 保持简单"] }
      ] }] } }));
    expect(screen.queryByRole("button", { name: "提交回答" })).toBeNull();
    expect(screen.getByRole("article", { name: "已回答的 Codex 提问" }).textContent).toContain("选择框架");
    expect(screen.getByRole("article", { name: "已回答的 Codex 提问" }).textContent).toContain("补充说明：保持简单");
  });

  it("switches to the first unanswered question before submission", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [],
      questions: [{ requestId: 44, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "first", header: "第一题", question: "选择方案", options: [{ label: "方案 A", description: "描述" }] },
        { id: "second", header: "第二题", question: "补充细节", options: null }
      ] } }] } }));
    fireEvent.click(screen.getByRole("tab", { name: /第二题.*待回答/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "细节" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(screen.getByRole("tab", { name: /第一题.*待回答/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("第一题");
    expect(answerQuestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /方案 A/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("run-1", 44, {
      first: { answers: ["方案 A"] }, second: { answers: ["user_note: 细节"] }
    }));
  });

  it("keeps the Question available after a failed answer", async () => {
    answerQuestion.mockRejectedValueOnce(new Error("发送失败"));
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [],
      questions: [{ requestId: 43, submitting: false, params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "answer", header: "答案", question: "请输入答案", options: null },
        { id: "reason", header: "理由", question: "请输入理由", options: null }
      ] } }] } }));
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("tab", { name: /理由.*待回答/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "回答" }), { target: { value: "保持简单" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "发送失败");
    fireEvent.click(screen.getByRole("tab", { name: /答案.*已回答/ }));
    expect(screen.getByRole("textbox", { name: "回答" })).toHaveProperty("value", "继续");
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(2));
    expect(answerQuestion).toHaveBeenLastCalledWith("run-1", 43, {
      answer: { answers: ["user_note: 继续"] }, reason: { answers: ["user_note: 保持简单"] }
    });
  });

  it("sends messages and displays a command approval", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "检查项目" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "检查项目", []));
    expect(input.value).toBe("");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [],
      approvals: [{ requestId: 9, method: "item/commandExecution/requestApproval", params: { command: "pnpm test", cwd: "C:\\repo" } }] } });
    expect(await screen.findByText("pnpm test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批准一次" }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith("run-1", 9, true));
  });

  it("animates the input border only while running in either mode", async () => {
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByPlaceholderText("向 Codex 发送消息")).toHaveProperty("disabled", false));
    const inputBorder = container.querySelector(".codex-app-server-input-border")!;
    expect(inputBorder.classList.contains("is-running")).toBe(false);
    expect((inputBorder as HTMLElement).dataset.mode).toBe("default");

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [], approvals: [] } });
    await waitFor(() => expect(inputBorder.classList.contains("is-running")).toBe(true));
    expect((inputBorder as HTMLElement).dataset.mode).toBe("default");

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: true, error: null, items: [], approvals: [] } });
    await waitFor(() => expect((inputBorder as HTMLElement).dataset.mode).toBe("plan"));
    expect(inputBorder.classList.contains("is-running")).toBe(true);
    expect(screen.queryByText("Codex 正在运行…")).toBeNull();
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null, items: [], approvals: [] } });
    await waitFor(() => expect(inputBorder.classList.contains("is-running")).toBe(false));
    expect((inputBorder as HTMLElement).dataset.mode).toBe("plan");

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, items: [], approvals: [] } });
    await waitFor(() => expect((inputBorder as HTMLElement).dataset.mode).toBe("default"));
    expect(inputBorder.classList.contains("is-running")).toBe(false);
  });

  it("keeps each App Server draft when switching sessions and visiting a terminal session", async () => {
    const { rerender } = render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "第一会话草稿" } });

    rerender(<CodexAppServerSession sessionId="run-2" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByPlaceholderText("向 Codex 发送消息"), { target: { value: "第二会话草稿" } });

    rerender(<CodexAppServerSession sessionId={null} />);
    expect(screen.queryByPlaceholderText("向 Codex 发送消息")).toBeNull();
    rerender(<CodexAppServerSession sessionId="run-1" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("第一会话草稿");
    rerender(<CodexAppServerSession sessionId="run-2" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("第二会话草稿");
  });

  it("restores a failed send to its original session after switching away", async () => {
    let rejectSend: (reason: Error) => void = () => {};
    submit.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const { rerender } = render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "发送失败后保留" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "发送失败后保留", []));

    rerender(<CodexAppServerSession sessionId="run-2" />);
    fireEvent.change(screen.getByPlaceholderText("向 Codex 发送消息"), { target: { value: "第二会话内容" } });
    await act(async () => rejectSend(new Error("发送失败")));
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("第二会话内容");

    rerender(<CodexAppServerSession sessionId="run-1" />);
    expect((screen.getByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement).value).toBe("发送失败后保留");
  });

  it("fills the draft or sends an App Server quick command according to its mode", async () => {
    const ref = createRef<CodexAppServerSessionHandle>();
    render(<CodexAppServerSession sessionId="run-1" ref={ref} />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "已有内容 " } });
    await act(async () => { expect(await ref.current?.applyQuickCommand({ id: "write", command: "继续", mode: "write" })).toBe(true); });
    expect(input.value).toBe("已有内容 继续");
    await act(async () => { expect(await ref.current?.applyQuickCommand({ id: "send", command: "立即检查", mode: "auto-enter" })).toBe(true); });
    expect(submit).toHaveBeenCalledWith("run-1", "立即检查", []);
    expect(input.value).toBe("已有内容 继续");
  });

  it("renders plan Markdown and keeps completed tool details collapsed", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null, approvals: [], items: [
      { id: "plan-1", type: "plan", text: "# 正式计划\n\n- 检查代码" },
      { id: "cmd-1", type: "commandExecution", command: "pnpm build", output: "构建成功", status: "completed" }
    ] } });
    expect(await screen.findByRole("heading", { name: "正式计划" })).toBeTruthy();
    expect(screen.getByText("检查代码")).toBeTruthy();
    const summary = screen.getByRole("button", { name: /工具调用 · 1 项/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("已完成");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("pnpm build")).toBeTruthy();
    expect(screen.getByText("构建成功")).toBeTruthy();
  });

  it("groups adjacent tool calls and keeps the group open during output updates", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const first = { id: "cmd-1", type: "commandExecution", command: "pnpm build", output: "构建成功", status: "completed" };
    const second = { id: "cmd-2", type: "commandExecution", command: "pnpm test", output: "正在测试", status: "inProgress" };
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [], items: [first, second] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 2 项/ });
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(1);
    expect(summary.textContent).toContain("进行中");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(screen.getByText("pnpm build")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("构建成功")).toBeTruthy();

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      first, { ...second, output: "测试完成", status: "completed" }
    ] } });
    expect(await screen.findByText("测试完成")).toBeTruthy();
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(summary.textContent).toContain("已完成");
  });

  it("starts a new tool group for the next turn", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "cmd-1", turnId: "turn-1", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "cmd-2", turnId: "turn-1", type: "commandExecution", command: "dir", status: "failed" },
      { id: "msg-1", turnId: "turn-1", type: "agentMessage", text: "检查结果" },
      { id: "cmd-3", turnId: "turn-2", type: "commandExecution", command: "pnpm test", status: "completed" }
    ] } });
    const summaries = await screen.findAllByText(/工具调用 · [12] 项/);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].closest("button")?.textContent).toContain("有失败");
    expect(summaries[1].closest("button")?.textContent).toContain("已完成");
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(2);
  });

  it("starts a new tool group after each Codex reply in the same turn", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const firstCalls = Array.from({ length: 4 }, (_, index) => ({
      id: `cmd-a-${index}`, turnId: "turn-1", type: "commandExecution", command: `a-${index}`, status: "completed"
    }));
    const secondCalls = Array.from({ length: 5 }, (_, index) => ({
      id: `cmd-b-${index}`, turnId: "turn-1", type: "commandExecution", command: `b-${index}`, status: "completed"
    }));
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [], items: [
      { id: "msg-a", turnId: "turn-1", type: "agentMessage", text: "回复 A" },
      ...firstCalls, { id: "reasoning-1", turnId: "turn-1", type: "reasoning" },
      { id: "msg-b", turnId: "turn-1", type: "agentMessage", text: "回复 B" }, ...secondCalls
    ] } });
    const firstSummary = await screen.findByRole("button", { name: /工具调用 · 4 项/ });
    const secondSummary = screen.getByRole("button", { name: /工具调用 · 5 项/ });
    expect(Array.from(document.querySelectorAll(".codex-app-server-messages > article, .codex-app-server-messages > section"))
      .slice(0, 4).map(node => node.textContent)).toEqual([
        expect.stringContaining("回复 A"), expect.stringContaining("工具调用 · 4 项"),
        expect.stringContaining("回复 B"), expect.stringContaining("工具调用 · 5 项")
      ]);
    expect(screen.queryByText("a-0")).toBeNull();
    expect(screen.queryByText("b-0")).toBeNull();
    fireEvent.click(firstSummary);
    expect(Array.from(firstSummary.closest(".codex-app-server-event")!.querySelectorAll(".codex-app-server-tool pre"))
      .map(node => node.textContent)).toEqual(["a-0", "a-1", "a-2", "a-3"]);
    expect(screen.queryByText("b-0")).toBeNull();
    fireEvent.click(secondSummary);
    expect(Array.from(secondSummary.closest(".codex-app-server-event")!.querySelectorAll(".codex-app-server-tool pre"))
      .map(node => node.textContent)).toEqual(["b-0", "b-1", "b-2", "b-3", "b-4"]);
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "msg-a", turnId: "turn-1", type: "agentMessage", text: "回复 A" },
      ...firstCalls, { id: "reasoning-1", turnId: "turn-1", type: "reasoning" },
      { id: "msg-b", turnId: "turn-1", type: "agentMessage", text: "回复 B" },
      ...secondCalls.slice(0, -1), { ...secondCalls.at(-1)!, output: "完成" }
    ] } });
    expect(await screen.findByText("完成")).toBeTruthy();
    expect(firstSummary.getAttribute("aria-expanded")).toBe("true");
    expect(secondSummary.getAttribute("aria-expanded")).toBe("true");
  });

  it("folds commands and file changes into one ordered group", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "cmd-1", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "file-1", type: "fileChange", changes: [{ path: "src/App.tsx", kind: "update" }], status: "completed" },
      { id: "cmd-2", type: "commandExecution", command: "pnpm build", status: "completed" }
    ] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 3 项/ });
    const details = summary.closest(".codex-app-server-event")!;
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(1);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("已完成");
    fireEvent.click(summary);
    const calls = Array.from(details.querySelectorAll(".codex-app-server-tool"));
    expect(calls.map(call => call.querySelector("strong")?.textContent)).toEqual(["执行命令", "修改文件", "执行命令"]);
    expect(calls.map(call => call.querySelector("pre")?.textContent)).toEqual(["pwd", expect.stringContaining("src/App.tsx"), "pnpm build"]);
  });

  it("keeps a file approval visible while its tool group is collapsed", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [
      { id: "file-1", type: "fileChange", changes: [{ path: "src/App.tsx" }], status: "pending" }
    ], approvals: [{ requestId: 10, method: "item/fileChange/requestApproval", params: { itemId: "file-1" } }] } });
    const summary = await screen.findByRole("button", { name: /工具调用 · 1 项/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("文件修改确认")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批准一次" })).toBeTruthy();
  });

  it("shows confirmation below a completed plan and executes it only once", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null,
      pendingPlan: { itemId: "plan-1" }, approvals: [], items: [{ id: "plan-1", type: "plan", text: "# 正式计划" }] } });
    const confirm = await screen.findByRole("group", { name: "确认执行计划" });
    expect(confirm.closest("article")?.textContent).toContain("正式计划");
    fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
    fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
    await waitFor(() => expect(executePlan).toHaveBeenCalledTimes(1));
    expect(executePlan).toHaveBeenCalledWith("run-1", "plan-1");
  });

  it("dismisses a plan without starting execution", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null,
      pendingPlan: { itemId: "plan-1" }, approvals: [], items: [{ id: "plan-1", type: "plan", text: "# 正式计划" }] } });
    fireEvent.click(await screen.findByRole("button", { name: "暂不执行" }));
    await waitFor(() => expect(dismissPlan).toHaveBeenCalledWith("run-1", "plan-1"));
    await waitFor(() => expect(screen.queryByRole("group", { name: "确认执行计划" })).toBeNull());
    expect(executePlan).not.toHaveBeenCalled();
  });

  it("renders a plan restored from history", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "计划会话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    resume.mockResolvedValueOnce({ threadId: "old-thread", mode: "default", busy: false, error: null,
      items: [{ id: "old-plan", type: "plan", text: "## 历史计划" }], approvals: [] });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "恢复前的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /计划会话/ }));
    expect(await screen.findByRole("heading", { name: "历史计划" })).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("switches mode, resumes history, and keeps selected files until sending", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    chooseFiles.mockResolvedValueOnce(["C:\\files\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Plan" }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("run-1", "plan"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /之前的任务/ }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("run-1", "old-thread"));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "", ["C:\\files\\notes.txt"]));
  });

  it("toggles Plan and Exec with Shift+Tab in the focused composer", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "保留草稿" } });
    input.focus();

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true, ctrlKey: true });
    expect(setMode).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(screen.getByPlaceholderText("向 Codex 发送消息").parentElement?.getAttribute("data-mode")).toBe("plan"));
    expect(setMode).toHaveBeenCalledWith("run-1", "plan");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("保留草稿");

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(screen.getByPlaceholderText("向 Codex 发送消息").parentElement?.getAttribute("data-mode")).toBe("default"));
    expect(setMode).toHaveBeenLastCalledWith("run-1", "default");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitemradio", { name: "Exec" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "历史会话" }));
    fireEvent.keyDown(screen.getByRole("menu", { name: "会话操作" }), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多操作" }));
    expect(input.value).toBe("保留草稿");

  });

  it("adds pasted images as removable attachments and sends them with text", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByText("capture.png")).toBeTruthy();
    fireEvent.change(input, { target: { value: "检查这张图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "检查这张图", ["C:\\project\\.pannel-handle-images\\capture.png"]));
    expect(discardImage).not.toHaveBeenCalled();
  });

  it("discards a pasted image when removed before sending", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    fireEvent.click(await screen.findByRole("button", { name: "移除 capture.png" }));
    await waitFor(() => expect(discardImage).toHaveBeenCalledWith("run-1", "C:\\project\\.pannel-handle-images\\capture.png"));
    await waitFor(() => expect(screen.queryByText("capture.png")).toBeNull());
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows an attachment preview before sending and in the user message", async () => {
    vi.mocked(window.codexAppServerApi.previewAttachment).mockResolvedValue({ kind: "text", text: "文件内容" });
    chooseFiles.mockResolvedValueOnce(["C:\\project\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "附加文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "预览 notes.txt" }));
    expect(await screen.findByRole("dialog", { name: "预览 notes.txt" })).toBeTruthy();
    expect(await screen.findByText("文件内容")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "user-1", type: "userMessage", text: "检查文件", attachments: [{ path: "C:\\project\\notes.txt", name: "notes.txt" }] }
    ] } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "预览 notes.txt" })).toHaveLength(2));
  });

  it("leaves text paste alone and reports a missing clipboard image", async () => {
    pasteImage.mockResolvedValueOnce({ status: "no_image" });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.paste(input, { clipboardData: { items: [{ type: "text/plain" }] } });
    expect(pasteImage).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "保留文字" } });
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "剪贴板中没有可用的图片。");
    expect(input.value).toBe("保留文字");
  });

  it("dismisses the current server error and shows a later error", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作" })).toHaveProperty("disabled", false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "服务出错", items: [], approvals: [] } }));
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "服务出错");
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "服务出错", items: [], approvals: [] } }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "新的错误", items: [], approvals: [] } }));
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "新的错误");
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: null, items: [], approvals: [] } }));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "新的错误", items: [], approvals: [] } }));
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "新的错误");
  });

  it("dismisses a local error without hiding the server error", async () => {
    pasteImage.mockResolvedValueOnce({ status: "no_image" }).mockResolvedValueOnce({ status: "no_image" });
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    act(() => changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false,
      error: "服务出错", items: [], approvals: [] } }));
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "剪贴板中没有可用的图片。");
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.paste(input, { clipboardData: { items: [{ type: "image/png" }] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "剪贴板中没有可用的图片。");
  });
});
