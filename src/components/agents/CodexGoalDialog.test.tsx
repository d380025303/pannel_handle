// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerSnapshot } from "../../vite-env";
import { CodexGoalDialog } from "./CodexGoalDialog";

const snapshot: CodexAppServerSnapshot = {
  threadId: "thread-1", mode: "default", executionPermission: "askApproval", busy: false,
  error: null, pendingPlan: null, items: [], approvals: [],
  goal: { threadId: "thread-1", objective: "完成迁移", status: "active", tokenBudget: 2000 }
};

afterEach(cleanup);

describe("CodexGoalDialog keyboard focus", () => {
  it("focuses inside on open and keeps forward and reverse traversal inside, skipping disabled save", async () => {
    const user = userEvent.setup();
    render(<><CodexGoalDialog sessionId="run-1" snapshot={snapshot} onClose={vi.fn()} onUpdated={vi.fn()} />
      <button>pnpm test</button></>);
    const close = screen.getByRole("button", { name: "关闭目标管理" });
    const controls = [close, screen.getByLabelText("目标内容"), screen.getByLabelText("Token 预算（可选）"),
      screen.getByRole("button", { name: "暂停" }), screen.getByRole("button", { name: "清除目标" })];
    expect(document.activeElement).toBe(close);
    expect(screen.getByRole("button", { name: "保存更改" })).toHaveProperty("disabled", true);
    for (const control of [...controls.slice(1), close]) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
    for (const control of [...controls.slice(1).reverse(), close]) {
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(control);
    }
  });

  it("cycles through an enabled save button after editing", async () => {
    const user = userEvent.setup();
    render(<CodexGoalDialog sessionId="run-1" snapshot={snapshot} onClose={vi.fn()} onUpdated={vi.fn()} />);
    await user.type(screen.getByLabelText("目标内容"), "并验证");
    const save = screen.getByRole("button", { name: "保存更改" });
    const close = screen.getByRole("button", { name: "关闭目标管理" });
    save.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);
  });

  it("keeps initial focus inside while the form is loading", async () => {
    const user = userEvent.setup();
    render(<CodexGoalDialog sessionId="run-1" snapshot={{ ...snapshot, goal: null, goalLoading: true }} onClose={vi.fn()} onUpdated={vi.fn()} />);
    const close = screen.getByRole("button", { name: "关闭目标管理" });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
  });
});
