// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkItemApi, WorkItemAutomationRule } from "../../vite-env";
import { WorkItemAutomation } from "./WorkItemAutomation";
import { WorkItemAutomationNotice } from "./WorkItemAutomationNotice";
afterEach(cleanup);
it("edits nested AND/OR rules, previews output and persists enabled configuration", async () => {
  const save = vi.fn(async input => ({ ...input, revision: 1 })); const preview = vi.fn(async () => ({ total: 1, samples: [{ id: "item", taskName: "巡检", prompt: "处理全文" }] }));
  window.workItemApi = { getAutomation: async () => ({ revision: 0, rules: [] }), saveAutomation: save, previewAutomation: preview } as unknown as WorkItemApi;
  render(<WorkItemAutomation data={{ records: [], total: 0, templates: [{ id: "t", name: "工程" }], owners: [] }} onClose={vi.fn()} />);
  await waitFor(() => expect((screen.getByText("新增规则") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("新增规则"));
  fireEvent.change(screen.getByLabelText("条件值"), { target: { value: "修复" } });
  fireEvent.click(screen.getByText("添加条件组"));
  fireEvent.change(screen.getAllByLabelText("条件值")[1], { target: { value: "问题" } });
  fireEvent.click(screen.getByLabelText("启用规则"));
  fireEvent.click(screen.getByText("插入 output"));
  fireEvent.click(screen.getByText("预览匹配"));
  await screen.findByText(/匹配 1 条/);
  fireEvent.click(screen.getByText("保存配置"));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const rule = save.mock.calls[0][0].rules[0] as WorkItemAutomationRule;
  expect(rule.enabled).toBe(true); expect(rule.prompt).toBe("{{output}}");
  expect(rule.condition).toMatchObject({ operator: "and", children: [{ value: "修复" }, { operator: "or", children: [{ value: "问题" }] }] });
});
it("shows errors even without the task list open and opens the affected session", () => {
  let receive: Parameters<WorkItemApi["onAutomationError"]>[0] = () => {};
  window.workItemApi = { onAutomationError: (callback: typeof receive) => { receive = callback; return () => {}; } } as unknown as WorkItemApi;
  const open = vi.fn(); render(<WorkItemAutomationNotice onOpenSession={open} />);
  // Delivery is synchronous at the IPC boundary.
  act(() => receive({ taskName: "巡检", sessionId: "session", error: "网络错误" }));
  return waitFor(() => { expect(screen.getByRole("alert").textContent).toContain("网络错误"); fireEvent.click(screen.getByText("查看会话")); expect(open).toHaveBeenCalledWith("session"); });
});
