// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexReviewDialog } from "./CodexReviewDialog";

describe("CodexReviewDialog", () => {
  const startReview = vi.fn();
  afterEach(cleanup);
  beforeEach(() => {
    startReview.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { startReview } });
  });
  it.each([
    ["uncommittedChanges", null, "", { type: "uncommittedChanges" }],
    ["baseBranch", "基准分支", " main ", { type: "baseBranch", branch: "main" }],
    ["commit", "提交 SHA", " abcdef1 ", { type: "commit", sha: "abcdef1" }],
    ["custom", "审查要求", " 检查边界条件 ", { type: "custom", instructions: "检查边界条件" }]
  ])("submits %s in the current session", async (type, label, value, target) => {
    const onClose = vi.fn();
    render(<CodexReviewDialog sessionId="run-1" disabled={false} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("审查目标"), { target: { value: type } });
    if (label) {
      expect(screen.getByRole("button", { name: "开始审查" })).toHaveProperty("disabled", true);
      fireEvent.change(screen.getByLabelText(label as string), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "开始审查" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(startReview).toHaveBeenCalledExactlyOnceWith("run-1", target);
  });
  it("keeps inputs after failure and blocks duplicate requests", async () => {
    let reject!: (error: Error) => void;
    startReview.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const onClose = vi.fn();
    render(<CodexReviewDialog sessionId="run-1" disabled={false} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("审查目标"), { target: { value: "baseBranch" } });
    fireEvent.change(screen.getByLabelText("基准分支"), { target: { value: "topic" } });
    fireEvent.click(screen.getByRole("button", { name: "开始审查" }));
    fireEvent.submit(screen.getByRole("button", { name: "正在启动…" }).closest("form")!);
    expect(startReview).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("分支不存在")));
    expect(screen.getByRole("alert").textContent).toBe("分支不存在");
    expect(screen.getByLabelText("基准分支")).toHaveProperty("value", "topic");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("cancels without a request and respects session readiness", () => {
    const onClose = vi.fn();
    render(<CodexReviewDialog sessionId="run-1" disabled onClose={onClose} />);
    expect(screen.getByRole("button", { name: "开始审查" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(startReview).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
