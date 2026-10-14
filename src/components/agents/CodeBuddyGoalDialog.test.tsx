// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodeBuddyGoalDialog } from "./CodeBuddyGoalDialog";
import userEvent from "@testing-library/user-event";
import type { CodexAppServerSnapshot } from "../../vite-env";

const base = { threadId: "thread", provider: "codebuddy" as const, mode: "default" as const,
  executionPermission: "askApproval" as const, busy: false, error: null, pendingPlan: null,
  items: [], approvals: [] };
afterEach(cleanup);

describe("CodeBuddy goal panel", () => {
  it("focuses close on open and cycles in both directions, including after enabling create", async () => {
    const user = userEvent.setup();
    render(<><CodeBuddyGoalDialog sessionId="run" snapshot={base} onClose={vi.fn()} onUpdated={vi.fn()} />
      <button>pnpm test</button></>);
    const close = screen.getByRole("button", { name: "关闭目标管理" });
    const condition = screen.getByLabelText("完成条件");
    const refresh = screen.getByRole("button", { name: "刷新状态" });
    const create = screen.getByRole("button", { name: "创建目标" });
    expect(document.activeElement).toBe(close);
    expect(create).toHaveProperty("disabled", true);
    for (const control of [condition, refresh, close]) {
      await user.tab(); expect(document.activeElement).toBe(control);
    }
    for (const control of [refresh, condition, close]) {
      await user.tab({ shift: true }); expect(document.activeElement).toBe(control);
    }
    await user.type(condition, "完成并验证修复");
    create.focus();
    for (let index = 0; index < 3; index += 1) {
      for (const control of [close, condition, refresh, create]) {
        await user.tab(); expect(document.activeElement).toBe(control);
      }
      for (const control of [refresh, condition, close, create]) {
        await user.tab({ shift: true }); expect(document.activeElement).toBe(control);
      }
    }
  });

  it("shows official goal usage and confirms replacement and clearing", async () => {
    const setGoal = vi.fn().mockResolvedValue(base);
    const clearGoal = vi.fn().mockResolvedValue(base);
    const refreshGoal = vi.fn().mockResolvedValue(base);
    Object.assign(window, { codexAppServerApi: { setGoal, clearGoal, refreshGoal } });
    const snapshot: CodexAppServerSnapshot = { ...base, busy: true, codeBuddyGoal: { available: true,
      active: { condition: "旧目标", paused: false, durationMs: 5000, turnCount: 2, tokenDelta: 120,
        reason: "还需构建" }, latest: null, pendingAction: null, error: null, updatedAt: Date.now() } };
    render(<CodeBuddyGoalDialog sessionId="run" snapshot={snapshot} onClose={vi.fn()} onUpdated={vi.fn()} />);
    expect(screen.getByText("已评估 2 轮")).toBeTruthy();
    expect(screen.getByText("消耗 120 Token")).toBeTruthy();
    expect(screen.getByText("最近评估：还需构建")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("写下可验证的完成条件"), { target: { value: "新目标" } });
    fireEvent.click(screen.getByRole("button", { name: "替换目标" }));
    expect(setGoal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await waitFor(() => expect(setGoal).toHaveBeenCalledWith("run", { objective: "新目标", status: "active" }));
    fireEvent.click(screen.getByRole("button", { name: "清除目标" }));
    expect(clearGoal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));
    await waitFor(() => expect(clearGoal).toHaveBeenCalledWith("run"));
  });

  it("explains missing status and exposes refresh only while idle", () => {
    Object.assign(window, { codexAppServerApi: { setGoal: vi.fn(), clearGoal: vi.fn(), refreshGoal: vi.fn() } });
    render(<CodeBuddyGoalDialog sessionId="run" snapshot={{ ...base, busy: true,
      codeBuddyGoal: { available: false, active: null, latest: null, pendingAction: null, error: null, updatedAt: 0 } }}
      onClose={vi.fn()} onUpdated={vi.fn()} />);
    expect(screen.getByText("当前 CLI 尚未提供目标状态。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新状态" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "创建目标" })).toHaveProperty("disabled", true);
  });
});
