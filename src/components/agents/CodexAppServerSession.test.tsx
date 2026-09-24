// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "./CodexAppServerSession";

describe("CodexAppServerSession", () => {
  afterEach(cleanup);
  let changed: (payload: any) => void;
  const submit = vi.fn().mockResolvedValue(undefined);
  const resolveApproval = vi.fn().mockResolvedValue(undefined);
  const listHistory = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  const newThread = vi.fn().mockResolvedValue({ threadId: "thread-2", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const resume = vi.fn().mockResolvedValue({ threadId: "old-thread", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const setMode = vi.fn().mockImplementation(async (_id, mode) => ({ threadId: "thread-1", mode, busy: false, error: null, items: [], approvals: [] }));
  const chooseFiles = vi.fn().mockResolvedValue([]);
  const pasteImage = vi.fn().mockResolvedValue({ status: "saved", path: "C:\\project\\.pannel-handle-images\\capture.png", size: 3 });
  const discardImage = vi.fn().mockResolvedValue(undefined);
  const executePlan = vi.fn().mockResolvedValue(undefined);
  const dismissPlan = vi.fn().mockImplementation(async () => ({ threadId: "thread-1", mode: "plan", busy: false,
    error: null, pendingPlan: null, items: [{ id: "plan-1", type: "plan", text: "# 正式计划" }], approvals: [] }));

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    submit.mockClear(); resolveApproval.mockClear(); listHistory.mockClear(); newThread.mockClear(); resume.mockClear(); setMode.mockClear(); chooseFiles.mockClear(); pasteImage.mockClear(); discardImage.mockClear(); executePlan.mockClear(); dismissPlan.mockClear();
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
      snapshot: vi.fn().mockResolvedValue({ threadId: "thread-1", mode: "default", busy: false, error: null, items: [], approvals: [] }),
      submit, interrupt: vi.fn(), resolveApproval, listHistory,
      resume, newThread, setMode, chooseFiles, pasteImage, discardImage, executePlan, dismissPlan,
      onChanged: (callback: typeof changed) => { changed = callback; return () => {}; }
    } });
  });

  it("keeps session controls and history inside the composer without a toolbar", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    const { container } = render(<CodexAppServerSession sessionId="run-1" />);
    const composer = container.querySelector(".codex-app-server-composer")!;
    await waitFor(() => expect(screen.getByRole("button", { name: "新对话" })).toHaveProperty("disabled", false));
    expect(container.querySelector(".codex-app-server-toolbar")).toBeNull();
    for (const name of ["新对话", "历史会话", "附加文件", "发送"]) {
      expect(composer.contains(screen.getByRole("button", { name }))).toBe(true);
    }
    expect(composer.contains(screen.getByLabelText("模式"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    expect(composer.contains(await screen.findByRole("button", { name: /之前的任务/ }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await waitFor(() => expect(newThread).toHaveBeenCalledWith("run-1"));
    await waitFor(() => expect(screen.queryByLabelText("历史会话", { selector: "div" })).toBeNull());
  });

  it("sends messages and displays a command approval", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    const input = await screen.findByPlaceholderText("向 Codex 发送消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "检查项目" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("run-1", "检查项目", []));
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, items: [],
      approvals: [{ requestId: 9, method: "item/commandExecution/requestApproval", params: { command: "pnpm test", cwd: "C:\\repo" } }] } });
    expect(await screen.findByText("pnpm test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批准一次" }));
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledWith("run-1", 9, true));
  });

  it("renders plan Markdown and keeps completed command details collapsed", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "plan", busy: false, error: null, approvals: [], items: [
      { id: "plan-1", type: "plan", text: "# 正式计划\n\n- 检查代码" },
      { id: "cmd-1", type: "commandExecution", command: "pnpm build", output: "构建成功", status: "completed" }
    ] } });
    expect(await screen.findByRole("heading", { name: "正式计划" })).toBeTruthy();
    expect(screen.getByText("检查代码")).toBeTruthy();
    const summary = screen.getByText("执行命令").closest("summary")!;
    const details = summary.parentElement as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(summary.textContent).toContain("已完成");
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText("pnpm build")).toBeTruthy();
    expect(screen.getByText("构建成功")).toBeTruthy();
  });

  it("groups adjacent commands and keeps the group open during output updates", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    const first = { id: "cmd-1", type: "commandExecution", command: "pnpm build", output: "构建成功", status: "completed" };
    const second = { id: "cmd-2", type: "commandExecution", command: "pnpm test", output: "正在测试", status: "inProgress" };
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: true, error: null, approvals: [], items: [first, second] } });
    const summary = (await screen.findByText("执行 2 条命令")).closest("summary")!;
    const details = summary.parentElement as HTMLDetailsElement;
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(1);
    expect(summary.textContent).toContain("进行中");
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(screen.getByText("pnpm build")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("构建成功")).toBeTruthy();

    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      first, { ...second, output: "测试完成", status: "completed" }
    ] } });
    expect(await screen.findByText("测试完成")).toBeTruthy();
    expect(details.open).toBe(true);
    expect(summary.textContent).toContain("已完成");
  });

  it("starts a new command group after another message", async () => {
    render(<CodexAppServerSession sessionId="run-1" />);
    await screen.findByPlaceholderText("向 Codex 发送消息");
    changed({ id: "run-1", snapshot: { threadId: "thread-1", mode: "default", busy: false, error: null, approvals: [], items: [
      { id: "cmd-1", type: "commandExecution", command: "pwd", status: "completed" },
      { id: "cmd-2", type: "commandExecution", command: "dir", status: "failed" },
      { id: "msg-1", type: "agentMessage", text: "检查结果" },
      { id: "cmd-3", type: "commandExecution", command: "pnpm test", status: "completed" }
    ] } });
    const summaries = await screen.findAllByText(/执行(?: 2 条)?命令/);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].closest("summary")?.textContent).toContain("有失败");
    expect(summaries[1].closest("summary")?.textContent).toContain("已完成");
    expect(document.querySelectorAll(".codex-app-server-event")).toHaveLength(2);
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
    await screen.findByPlaceholderText("向 Codex 发送消息");
    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /计划会话/ }));
    expect(await screen.findByRole("heading", { name: "历史计划" })).toBeTruthy();
  });

  it("switches mode, resumes history, and keeps selected files until sending", async () => {
    listHistory.mockResolvedValueOnce({ data: [{ id: "old-thread", title: "之前的任务", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: null });
    chooseFiles.mockResolvedValueOnce(["C:\\files\\notes.txt"]);
    render(<CodexAppServerSession sessionId="run-1" />);
    await waitFor(() => expect((screen.getByLabelText("模式") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("模式"), { target: { value: "plan" } });
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("run-1", "plan"));
    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /之前的任务/ }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("run-1", "old-thread"));
    fireEvent.click(screen.getByRole("button", { name: "附加文件" }));
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
    await waitFor(() => expect(screen.getByLabelText("模式")).toHaveProperty("value", "plan"));
    expect(setMode).toHaveBeenCalledWith("run-1", "plan");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("保留草稿");

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(screen.getByLabelText("模式")).toHaveProperty("value", "default"));
    expect(setMode).toHaveBeenLastCalledWith("run-1", "default");
    expect(screen.getByRole("option", { name: "Exec" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
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
});
