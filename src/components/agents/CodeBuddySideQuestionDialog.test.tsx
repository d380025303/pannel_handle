// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBuddySideQuestionDialog } from "./CodeBuddySideQuestionDialog";
import type { CodexAppServerSnapshot } from "../../vite-env";

const base: CodexAppServerSnapshot = { provider: "codebuddy", threadId: "thread", mode: "default",
  executionPermission: "askApproval", busy: true, error: null, pendingPlan: null, items: [], approvals: [] };
const running: CodexAppServerSnapshot = { ...base, sideQuestion: { requestId: "request", threadId: "thread",
  question: "目前进展？", status: "running", answer: "", error: null, truncated: false } };
afterEach(cleanup);

describe("CodeBuddy side question dialog", () => {
  it("supports modified Enter, ignores composition, and blocks duplicate submissions", async () => {
    const askSideQuestion = vi.fn(() => new Promise<CodexAppServerSnapshot>(() => {}));
    Object.assign(window, { codexAppServerApi: { askSideQuestion, cancelSideQuestion: vi.fn().mockResolvedValue(base) } });
    render(<CodeBuddySideQuestionDialog sessionId="run" snapshot={base} onClose={vi.fn()} onUpdated={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "旁问问题" });
    expect((screen.getByRole("button", { name: "发送旁问" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "解释当前进展" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(askSideQuestion).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(askSideQuestion).toHaveBeenCalledTimes(1);
    expect(askSideQuestion).toHaveBeenCalledWith("run", "解释当前进展");
    expect(screen.getByRole("status").textContent).toContain("关闭弹窗将取消");
  });

  it("traps focus, closes with Escape, and restores the trigger", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger); trigger.focus();
    Object.assign(window, { codexAppServerApi: { askSideQuestion: vi.fn(), cancelSideQuestion: vi.fn().mockResolvedValue(base) } });
    const onClose = vi.fn();
    const view = render(<CodeBuddySideQuestionDialog sessionId="run" snapshot={base} onClose={onClose} onUpdated={vi.fn()} />);
    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭旁问" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount(); expect(document.activeElement).toBe(trigger); trigger.remove();
  });

  it("cancels explicitly and reports clipboard failure", async () => {
    const cancelSideQuestion = vi.fn().mockResolvedValue(base);
    Object.assign(window, { codexAppServerApi: { askSideQuestion: vi.fn(), cancelSideQuestion } });
    const onUpdated = vi.fn();
    const view = render(<CodeBuddySideQuestionDialog sessionId="run" snapshot={running} onClose={vi.fn()} onUpdated={onUpdated} copyText={async () => false} />);
    fireEvent.click(screen.getByRole("button", { name: "取消旁问" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(base));
    expect(cancelSideQuestion).toHaveBeenCalledWith("run", "request");
    view.rerender(<CodeBuddySideQuestionDialog sessionId="run" snapshot={{ ...base, sideQuestion: { ...running.sideQuestion!, status: "completed", answer: "answer" } }} onClose={vi.fn()} onUpdated={onUpdated} copyText={async () => false} />);
    fireEvent.click(screen.getByRole("button", { name: "复制答案" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("复制失败，请重试。"));
  });

  it("automatically sends the slash question while the main turn remains busy, then renders a separate answer", async () => {
    const askSideQuestion = vi.fn().mockResolvedValue(running);
    const cancelSideQuestion = vi.fn().mockResolvedValue(base);
    Object.assign(window, { codexAppServerApi: { askSideQuestion, cancelSideQuestion } });
    const onUpdated = vi.fn();
    const view = render(<CodeBuddySideQuestionDialog sessionId="run" snapshot={base} initialQuestion="目前进展？" onClose={vi.fn()} onUpdated={onUpdated} />);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(running));
    expect(askSideQuestion).toHaveBeenCalledTimes(1);
    expect(askSideQuestion).toHaveBeenCalledWith("run", "目前进展？");
    view.rerender(<CodeBuddySideQuestionDialog sessionId="run" snapshot={{ ...running, sideQuestion: { ...running.sideQuestion!, status: "completed", answer: "**继续执行中**" } }} onClose={vi.fn()} onUpdated={onUpdated} />);
    expect(screen.getByLabelText("旁问答案").textContent).toContain("继续执行中");
    expect(cancelSideQuestion).not.toHaveBeenCalled();
  });

  it("cancels the active request when the panel unmounts", () => {
    const cancelSideQuestion = vi.fn().mockResolvedValue(base);
    Object.assign(window, { codexAppServerApi: { askSideQuestion: vi.fn(), cancelSideQuestion } });
    const view = render(<CodeBuddySideQuestionDialog sessionId="run" snapshot={running} onClose={vi.fn()} onUpdated={vi.fn()} />);
    view.unmount(); expect(cancelSideQuestion).toHaveBeenCalledWith("run", "request");
  });

  it("cancels a request whose IPC response arrives after closing", async () => {
    let resolve!: (value: CodexAppServerSnapshot) => void;
    const askSideQuestion = vi.fn(() => new Promise<CodexAppServerSnapshot>(done => { resolve = done; }));
    const cancelSideQuestion = vi.fn().mockResolvedValue(base);
    Object.assign(window, { codexAppServerApi: { askSideQuestion, cancelSideQuestion } });
    const onUpdated = vi.fn();
    const view = render(<CodeBuddySideQuestionDialog sessionId="run" snapshot={base} initialQuestion="目前进展？" onClose={vi.fn()} onUpdated={onUpdated} />);
    view.unmount(); resolve(running);
    await waitFor(() => expect(cancelSideQuestion).toHaveBeenCalledWith("run", "request"));
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("shows failures and retries without involving the main submit API", async () => {
    const askSideQuestion = vi.fn().mockResolvedValue(running);
    Object.assign(window, { codexAppServerApi: { askSideQuestion, cancelSideQuestion: vi.fn().mockResolvedValue(base) } });
    render(<CodeBuddySideQuestionDialog sessionId="run" snapshot={{ ...running, sideQuestion: { ...running.sideQuestion!, status: "failed", error: "服务暂不可用", truncated: true } }} onClose={vi.fn()} onUpdated={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("服务暂不可用");
    expect(screen.getByText("上下文较长，仅使用最近的可见内容。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试旁问" }));
    await waitFor(() => expect(askSideQuestion).toHaveBeenCalledWith("run", "目前进展？"));
  });
});
