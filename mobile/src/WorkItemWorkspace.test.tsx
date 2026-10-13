import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkItemWorkspace } from "./WorkItemWorkspace";
import type { WorkItem, WorkItemApi } from "../../src/vite-env";
const filterStorageKey = "pannel-handle-mobile-work-item-filters";
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it("saves filters and restores them for the first query after reentering", async () => {
  const saved = { templateId: "template", ownerId: "owner", followUp: "false", statuses: ["failed", "void"], keyword: "检查" };
  localStorage.setItem(filterStorageKey, JSON.stringify({ ...saved, page: 4 }));
  const f = fixture();
  expect(f.api.list).toHaveBeenNthCalledWith(1, { templateId: "template", ownerId: "owner", needsFollowUp: false, statuses: saved.statuses, keyword: "检查", page: 0 });
  await screen.findByText("检查代码");
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("检查");
  vi.mocked(f.api.list).mockResolvedValue({ records: [], total: 0, templates: [{ id: "template", name: "模板一" }, { id: "other", name: "模板二" }], owners: [{ id: "owner", templateId: "template", name: "负责人一" }] });
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByText("没有符合筛选条件的任务");
  fireEvent.click(screen.getByRole("button", { name: "筛选 · 4 ▾" }));
  expect((screen.getByRole("combobox", { name: "模板" }) as HTMLSelectElement).value).toBe("template");
  expect((screen.getByRole("combobox", { name: "负责人" }) as HTMLSelectElement).value).toBe("owner");
  expect((screen.getByRole("combobox", { name: "后续处理" }) as HTMLSelectElement).value).toBe("false");
  expect((screen.getByRole("checkbox", { name: "失败" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "模板" }), { target: { value: "other" } });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "新关键词" } });
  expect(JSON.parse(localStorage.getItem(filterStorageKey)!)).toEqual({ ...saved, templateId: "other", ownerId: "", keyword: "新关键词" });
  cleanup();
  const next = fixture();
  expect(next.api.list).toHaveBeenNthCalledWith(1, { templateId: "other", needsFollowUp: false, statuses: saved.statuses, keyword: "新关键词", page: 0 });
});

it("clears saved filters on reset and reenters with defaults", async () => {
  localStorage.setItem(filterStorageKey, JSON.stringify({ keyword: "保存" }));
  fixture(); await screen.findByText("检查代码");
  fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
  expect(localStorage.getItem(filterStorageKey)).toBeNull();
  cleanup();
  const f = fixture();
  expect(f.api.list).toHaveBeenNthCalledWith(1, { statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"], keyword: "", page: 0 });
});

it.each(["broken JSON", JSON.stringify({ templateId: 1, ownerId: [], keyword: false, followUp: "invalid", statuses: ["unknown"] })])("uses defaults for invalid stored filters: %s", saved => {
  localStorage.setItem(filterStorageKey, saved);
  const f = fixture();
  expect(f.api.list).toHaveBeenNthCalledWith(1, { statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"], keyword: "", page: 0 });
});

it("preserves an empty status selection and valid fields alongside invalid fields", () => {
  localStorage.setItem(filterStorageKey, JSON.stringify({ statuses: [], keyword: "保留", ownerId: 123 }));
  const f = fixture();
  expect(f.api.list).toHaveBeenNthCalledWith(1, { statuses: [], keyword: "保留", page: 0 });
});

it("continues querying when storage reads and writes fail", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("unavailable"); });
  const f = fixture(); await screen.findByText("检查代码");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "仍可查询" } });
  await waitFor(() => expect(f.api.list).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "仍可查询", page: 0 })));
});
it("keeps advanced filters collapsed, preserves selections and resets them", async () => {
  const f = fixture();
  await screen.findByText("检查代码");
  expect(screen.queryByRole("combobox", { name: "模板" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "筛选 ▾" }));
  fireEvent.change(screen.getByRole("combobox", { name: "后续处理" }), { target: { value: "true" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "待执行" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "已作废" }));
  await waitFor(() => expect(f.api.list).toHaveBeenLastCalledWith(expect.objectContaining({ needsFollowUp: true, statuses: expect.arrayContaining(["void", "running"]), page: 0 })));
  expect(vi.mocked(f.api.list).mock.calls.at(-1)?.[0]?.statuses).not.toContain("pending");
  fireEvent.click(screen.getByRole("button", { name: "筛选 · 2 ▴" }));
  expect(screen.queryByRole("checkbox", { name: "已作废" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "筛选 · 2 ▾" }));
  expect((screen.getByRole("checkbox", { name: "已作废" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("combobox", { name: "后续处理" }) as HTMLSelectElement).value).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
  await waitFor(() => expect(f.api.list).toHaveBeenLastCalledWith({ statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"], keyword: "", page: 0 }));
});
function fixture(status = "pending") {
  const item = { id: "task", taskName: "检查代码", owner: { name: "开发" }, template: { title: "项目" }, status, version: 2, output: "修复问题", summary: "修复问题", needsFollowUp: true, createdAt: 1 } as unknown as WorkItem;
  const api = { listQuickPrompts: vi.fn(async () => []), mutateQuickPrompt: vi.fn(async () => []), list: vi.fn(async () => ({ records: [item], total: 1, templates: [], owners: [] })), get: vi.fn(async () => item), preview: vi.fn(async () => ({ body: { prompt: item.output }, configuration: {} })), execute: vi.fn(async () => ({ ...item, sessionId: "new" })), markCompleted: vi.fn(async () => ({ ...item, status: "completed" as const })), setFollowUp: vi.fn(async () => item), void: vi.fn(async () => item), restore: vi.fn(async () => item), resolveUncertain: vi.fn(async () => item), listAttempts: vi.fn(async () => ({ records: [], total: 0 })), getAttempt: vi.fn(), onChanged: vi.fn(() => () => {}) } as unknown as WorkItemApi;
  const open = vi.fn(); render(<WorkItemWorkspace api={api} visible sessions={[]} onOpenSession={open} />);
  return { api, open };
}
it("filters tasks and submits edited input once before closing the dialog without opening the new session", async () => {
  const f = fixture(); await screen.findByText("检查代码");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "问题" } });
  await waitFor(() => expect(f.api.list).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "问题", page: 0 })));
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const input = await screen.findByRole("textbox", { name: "实际提示词" });
  expect((input as HTMLTextAreaElement).value).toBe("修复问题");
  fireEvent.change(input, { target: { value: "只修复这一项" } });
  vi.mocked(f.api.list).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(f.api.execute).toHaveBeenCalledExactlyOnceWith({ id: "task", version: 2, prompt: "只修复这一项" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "执行任务" })).toBeNull());
  expect(f.open).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "任务列表" })).toBeTruthy();
  await waitFor(() => expect(f.api.list).toHaveBeenCalledWith(expect.objectContaining({ keyword: "问题", page: 0 })));
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

it("appends quick prompts to edited input and resets when reopening", async () => {
  const f = fixture();
  vi.mocked(f.api.listQuickPrompts).mockResolvedValue([{ id: "quick", version: 1, name: "补充验证", prompt: "运行测试" }]);
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  const quick = await screen.findByRole("button", { name: "补充验证" });

  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const input = await screen.findByRole("textbox", { name: "实际提示词" });
  fireEvent.change(input, { target: { value: "手动修改" } });
  fireEvent.click(quick); fireEvent.click(quick);
  expect((input as HTMLTextAreaElement).value).toBe("手动修改\n\n运行测试\n\n运行测试");
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  await screen.findByRole("button", { name: "补充验证" });

  expect(screen.queryByRole("textbox", { name: "实际提示词" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect((screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("修复问题");
  fireEvent.click(screen.getByRole("button", { name: "补充验证" }));
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(f.api.execute).toHaveBeenCalledWith({ id: "task", version: 2, prompt: "修复问题\n\n运行测试" }));
});

it.each(["pending", "failed", "stopped"] as const)("manually completes %s without executing", async status => {
  const f = fixture(status);
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  const button = await screen.findByRole("button", { name: "标记完成" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(f.api.markCompleted).toHaveBeenCalledExactlyOnceWith({ id: "task", version: 2 }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "执行任务" })).toBeNull());
  expect(f.api.execute).not.toHaveBeenCalled();
});
it("allows manual completion when execution preview fails", async () => {
  const status = "pending" as const; const f = fixture(status);
  vi.mocked(f.api.preview).mockRejectedValueOnce(new Error("来源模板已删除"));
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await screen.findByText("Error: 来源模板已删除");
  const button = screen.getByRole("button", { name: "标记完成" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(f.api.markCompleted).toHaveBeenCalledWith({ id: "task", version: 2 }));
});
it("hides manual completion for completed tasks", async () => {
  const status = "completed" as const; fixture(status);
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await screen.findByRole("dialog", { name: "执行任务" });
  expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
});

it("keeps edited prompt on manual completion conflict", async () => {
  const f = fixture();
  vi.mocked(f.api.markCompleted).mockRejectedValueOnce(new Error("任务已变更，请刷新后重试。"));
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));

  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const input = await screen.findByRole("textbox", { name: "实际提示词" });
  fireEvent.change(input, { target: { value: "保留编辑" } });
  const button = screen.getByRole("button", { name: "标记完成" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByText("Error: 任务已变更，请刷新后重试。");
  expect((screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("保留编辑");
  expect(screen.getByRole("dialog", { name: "执行任务" })).toBeTruthy();
});

it("previews markdown, folds configuration and preserves edits across modes", async () => {
  const f = fixture();
  const item = await f.api.get({ id: "task" });
  vi.mocked(f.api.get).mockResolvedValue({ ...item, output: "## 执行建议\n\n**验证结果**\n\n- 运行测试" });
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  const dialog = within(await screen.findByRole("dialog", { name: "执行任务" }));
  expect(await dialog.findByRole("heading", { name: "执行建议" })).toBeTruthy();
  expect(dialog.queryByRole("textbox", { name: "实际提示词" })).toBeNull();
  const config = dialog.getByText("执行配置").closest("details")!;
  expect(config.open).toBe(false);
  fireEvent.click(dialog.getByRole("button", { name: "编辑" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "实际提示词" }), { target: { value: "## 修改后" } });
  fireEvent.click(dialog.getByRole("button", { name: "预览" }));
  expect(dialog.getByRole("heading", { name: "修改后" })).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "编辑" }));
  expect((dialog.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("## 修改后");
  fireEvent.change(dialog.getByRole("textbox", { name: "实际提示词" }), { target: { value: "   " } });
  expect((dialog.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(true);
});

it("appends quick prompts in preview and preserves input after execution failure", async () => {
  const f = fixture();
  vi.mocked(f.api.listQuickPrompts).mockResolvedValue([{ id: "quick", version: 1, name: "补充验证", prompt: "## 运行测试" }]);
  vi.mocked(f.api.execute).mockRejectedValueOnce(new Error("创建失败"));
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  fireEvent.click(await screen.findByRole("button", { name: "补充验证" }));
  expect(screen.getByRole("heading", { name: "运行测试" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await screen.findByText("Error: 创建失败");
  await waitFor(() => expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect((screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("修复问题\n\n## 运行测试");
});

it("initializes persistent prompts once, permits removal and reloads defaults on reopen", async () => {
  const { api } = fixture();
  vi.mocked(api.listQuickPrompts).mockResolvedValue([
    { id: "a", version: 1, name: "常驻一", prompt: "测试", persistent: true },
    { id: "b", version: 1, name: "手动", prompt: "不追加" },
    { id: "c", version: 1, name: "常驻二", prompt: "构建", persistent: true },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const input = screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement;
  expect(input.value).toBe("修复问题\n\n测试\n\n构建");
  expect(api.preview).toHaveBeenCalledWith(expect.objectContaining({ prompt: input.value }));
  fireEvent.change(input, { target: { value: "本次移除常驻" } });
  await act(async () => { vi.mocked(api.onChanged).mock.calls[0][0](); });
  await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
  expect(input.value).toBe("本次移除常驻");
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
  vi.mocked(api.listQuickPrompts).mockResolvedValue([{ id: "a", version: 2, name: "常驻一", prompt: "新配置", persistent: true }]);
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect((screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("修复问题\n\n新配置");
  fireEvent.change(screen.getByRole("textbox", { name: "实际提示词" }), { target: { value: "最终输入" } });
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ prompt: "最终输入" })));
});
it("blocks execution when persistent prompt loading fails and allows retry", async () => {
  const { api } = fixture();
  vi.mocked(api.listQuickPrompts).mockRejectedValue(new Error("常驻加载失败"));
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await screen.findByRole("button", { name: "重新查询" });
  expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.listQuickPrompts).mockResolvedValue([{ id: "a", version: 1, name: "常驻", prompt: "恢复", persistent: true }]);
  fireEvent.click(screen.getByRole("button", { name: "重新查询" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.preview).toHaveBeenCalledWith(expect.objectContaining({ prompt: "修复问题\n\n恢复" }));
});
