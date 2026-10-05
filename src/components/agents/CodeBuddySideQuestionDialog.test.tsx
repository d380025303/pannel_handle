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
