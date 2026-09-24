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
  const resume = vi.fn().mockResolvedValue({ threadId: "old-thread", mode: "default", busy: false, error: null, items: [], approvals: [] });
  const setMode = vi.fn().mockImplementation(async (_id, mode) => ({ threadId: "thread-1", mode, busy: false, error: null, items: [], approvals: [] }));
  const chooseFiles = vi.fn().mockResolvedValue([]);

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    submit.mockClear(); resolveApproval.mockClear(); listHistory.mockClear(); resume.mockClear(); setMode.mockClear(); chooseFiles.mockClear();
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: {
      snapshot: vi.fn().mockResolvedValue({ threadId: "thread-1", mode: "default", busy: false, error: null, items: [], approvals: [] }),
      submit, interrupt: vi.fn(), resolveApproval, listHistory,
      resume, newThread: vi.fn(), setMode, chooseFiles,
      onChanged: (callback: typeof changed) => { changed = callback; return () => {}; }
    } });
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
});
