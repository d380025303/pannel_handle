// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MascotNotificationActions, MascotNotificationLabel } from "./MascotNotification";
import type { DesktopMascotNotification } from "../../vite-env";

const base: DesktopMascotNotification = { id: "notice", sessionId: "one", sessionTitle: "后台会话", status: "pending", summary: "", timestamp: 1,
  agentStatus: { id: "one", provider: "codex", status: "completed", eventName: "AppServerPlanPending", timestamp: 1 } };
afterEach(() => { cleanup(); delete window.desktopMascotApi; });
function setup(notification: DesktopMascotNotification) {
  const processNotification = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, { desktopMascotApi: { processNotification } });
  render(<MascotNotificationActions notification={notification} />);
  return processNotification;
}
describe("mascot graphical interactions", () => {
  it("uses the sidebar labels in both locales", () => {
    const { rerender } = render(<MascotNotificationLabel notification={base} locale="zh-CN" />);
    expect(screen.getByText("Codex 等待确认计划")).toBeTruthy();
    rerender(<MascotNotificationLabel notification={base} locale="en-US" />);
    expect(screen.queryByText("Task completed")).toBeNull();
    expect(screen.getByText(/Codex/).textContent).toMatch(/plan/i);
    rerender(<MascotNotificationLabel notification={{ ...base, agentStatus: { ...base.agentStatus!, status: "e_prompt", eventName: "AppServerQuestion" } }} locale="zh-CN" />);
    expect(screen.getByText("Codex 等待回答")).toBeTruthy();
  });
  it("shows full plans, retains errors for retry and disables duplicate submissions", async () => {
    const process = setup({ ...base, action: { kind: "plan", key: "plan", requestId: "plan", text: "计划详情".repeat(100) } });
    process.mockRejectedValueOnce(new Error("发送失败"));
    fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
    expect((screen.getByRole("button", { name: "正在提交…" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole("alert");
    expect(screen.getByText("计划详情".repeat(100))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "执行计划" }));
    await waitFor(() => expect(process).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "取消计划" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "取消计划" }));
    expect(process).toHaveBeenLastCalledWith("notice", { type: "dismiss" });
  });
  it("exposes only the provider's available authorization decisions", async () => {
    const process = setup({ ...base, action: { kind: "approval", key: "approval", requestId: 9, items: [], request: {
      requestId: 9, method: "item/commandExecution/requestApproval", params: { command: "pnpm test", availableDecisions: ["accept", "decline"] }
    } } });
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "本会话允许" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "批准一次" }));
    await waitFor(() => expect(process).toHaveBeenCalledWith("notice", { type: "approve", decision: "accept" }));
  });
  it("uses OpenCode custom answer formatting through the mascot API", async () => {
    const process = setup({ ...base, agentStatus: { ...base.agentStatus!, provider: "opencode" }, action: {
      kind: "question", key: "question", requestId: "q", request: { requestId: "q", submitting: false, params: { threadId: "thread", turnId: "turn", questions: [
        { id: "choice", header: "方案", question: "选择方案", isOther: true, options: [{ label: "A", description: "方案 A" }] }
      ] } }
    } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "自定义方案" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(process).toHaveBeenCalledWith("notice", { type: "answer", answers: { choice: { answers: ["自定义方案"], customAnswer: "自定义方案" } } }));
  });
});
