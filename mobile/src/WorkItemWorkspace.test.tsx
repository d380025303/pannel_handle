import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkItemWorkspace } from "./WorkItemWorkspace";
import type { WorkItem, WorkItemApi } from "../../src/vite-env";
afterEach(cleanup);
function fixture(status = "pending") {
  const item = { id: "task", taskName: "检查代码", owner: { name: "开发" }, template: { title: "项目" }, status, version: 2, output: "修复问题", summary: "修复问题", needsFollowUp: true, createdAt: 1 } as unknown as WorkItem;
  const api = { list: vi.fn(async () => ({ records: [item], total: 1, templates: [], owners: [] })), get: vi.fn(async () => item), preview: vi.fn(async () => ({ body: { prompt: item.output }, configuration: {} })), execute: vi.fn(async () => ({ ...item, sessionId: "new" })), setFollowUp: vi.fn(async () => item), void: vi.fn(async () => item), restore: vi.fn(async () => item), resolveUncertain: vi.fn(async () => item), listAttempts: vi.fn(async () => ({ records: [], total: 0 })), getAttempt: vi.fn(), onChanged: vi.fn(() => () => {}) } as unknown as WorkItemApi;
  const open = vi.fn(); render(<WorkItemWorkspace api={api} visible sessions={[]} onOpenSession={open} />);
  return { api, open };
}
it("filters tasks and submits edited input once before opening the new session", async () => {
  const f = fixture(); await screen.findByText("检查代码");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "问题" } });
  await waitFor(() => expect(f.api.list).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "问题", page: 0 })));
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  const input = await screen.findByRole("textbox", { name: "实际提示词" });
  expect((input as HTMLTextAreaElement).value).toBe("修复问题");
  fireEvent.change(input, { target: { value: "只修复这一项" } });
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(f.api.execute).toHaveBeenCalledExactlyOnceWith({ id: "task", version: 2, prompt: "只修复这一项" }));
  expect(f.open).toHaveBeenCalledWith("new");
});
it("keeps active tasks locked and offers result verification for uncertain tasks", async () => {
  const f = fixture("uncertain"); await screen.findByText("检查代码");
  expect((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "检查代码：更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "核对结果" }));
  await screen.findByText("检查代码 · 开发 · 项目 · 待核对");
  fireEvent.click(screen.getByRole("button", { name: "确认已结束，标记中断" }));
  await waitFor(() => expect(f.api.resolveUncertain).toHaveBeenCalledWith({ id: "task", version: 2 }));
});

it("supports follow-up changes, execution records and confirmed voiding", async () => {
  const f = fixture(); await screen.findByText("检查代码");
  const menu = () => fireEvent.click(screen.getByRole("button", { name: "检查代码：更多操作" }));
  menu(); fireEvent.click(screen.getByRole("menuitem", { name: "标记为不需要后续处理" }));
  await waitFor(() => expect(f.api.setFollowUp).toHaveBeenCalledWith({ id: "task", version: 2, needsFollowUp: false }));
  menu(); fireEvent.click(screen.getByRole("menuitem", { name: "执行记录" }));
  await screen.findByText("暂无执行记录。");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  menu(); fireEvent.click(screen.getByRole("menuitem", { name: "作废" }));
  const reason = await screen.findByRole("textbox", { name: "作废原因" });
  fireEvent.change(reason, { target: { value: "已不需要" } });
  fireEvent.click(screen.getByRole("button", { name: "确认作废" }));
  await waitFor(() => expect(f.api.void).toHaveBeenCalledWith({ id: "task", version: 2, reason: "已不需要" }));
});
it("restores voided tasks with the latest version", async () => {
  const f = fixture("void"); await screen.findByText("检查代码");
  fireEvent.click(screen.getByRole("button", { name: "检查代码：更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "恢复" }));
  await screen.findByText("恢复为待执行，保留原始回复及全部执行记录。");
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await waitFor(() => expect(f.api.restore).toHaveBeenCalledWith({ id: "task", version: 2 }));
});
