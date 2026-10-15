// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItem, WorkItemApi } from "../../vite-env";
import { WorkItemWorkspace } from "./WorkItemWorkspace";

const item: WorkItem = { id: "item", sourceRunId: "source", taskId: "timer", ownerId: "owner", templateId: "template", taskName: "模块巡检", output: "最终执行方案",
  owner: { id: "owner", version: 1, name: "模块", responsibilities: "职责", directories: ["src"], createdAt: 1, updatedAt: 1 }, template: { title: "工程", cwd: "C:\\repo" },
  tools: [], needsFollowUp: true, status: "pending", version: 1, createdAt: 1, updatedAt: 1, unavailable: "" };
function setup(overrides: Partial<WorkItem> = {}) {
  let value = { ...item, ...overrides };
  let changed = () => {};
  const api = { listQuickPrompts: vi.fn<WorkItemApi["listQuickPrompts"]>(async () => []), mutateQuickPrompt: vi.fn(async () => []), list: vi.fn(async (_input?: Parameters<WorkItemApi["list"]>[0]) => ({ records: [{ ...value, summary: value.output }], total: 1, templates: [{ id: "template", name: "工程" }], owners: [{ id: "owner", name: "模块", templateId: "template" }] })),
    get: vi.fn(async () => value), preview: vi.fn(async () => ({ body: { prompt: value.output }, configuration: { cwd: "C:\\repo", codexAppServerModel: "model" } })),
    execute: vi.fn(async () => { value = { ...value, status: "running", version: 2 }; return value; }),
    markCompleted: vi.fn(async () => ({ ...value, status: "completed" as const })), setFollowUp: vi.fn(async (input: { needsFollowUp: boolean }) => { value = { ...value, needsFollowUp: input.needsFollowUp, version: value.version + 1 }; return value; }),
    void: vi.fn(async () => ({ ...value, status: "void" as const })), restore: vi.fn(async () => value), resolveUncertain: vi.fn(async () => value),
    listAttempts: vi.fn(async () => ({ records: [{ id: "attempt", workItemId: item.id, status: "completed" as const, startedAt: 1, sessionId: "session", error: "" }], total: 1 })),
    getAttempt: vi.fn(async () => ({ id: "attempt", workItemId: item.id, status: "completed" as const, startedAt: 1, sessionId: "session", input: { prompt: "实际输入" }, configuration: {}, output: "执行回复", error: "" })),
    onChanged: vi.fn(callback => { changed = callback; return () => {}; }) };
  window.workItemApi = { ...api, getAutomation: vi.fn(async () => ({ revision: 0, rules: [] })), saveAutomation: vi.fn(async input => input), previewAutomation: vi.fn(async () => ({ total: 0, samples: [] })), onAutomationError: vi.fn(() => () => {}) } as WorkItemApi;
  window.moduleOwnerApi = { onChanged: () => () => {} } as unknown as typeof window.moduleOwnerApi;
  window.terminalApi = { listSessions: vi.fn(async () => [{ id: "session" }]) } as unknown as typeof window.terminalApi;
  const onOpenSession = vi.fn();
  render(<WorkItemWorkspace visible onOpenSession={onOpenSession} />);
  return { api, onOpenSession, changed: () => changed() };
}
const filterStorageKey = "pannel-handle.work-item-filters.v1";
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });
describe("manual task list", () => {
  it("supports page selection, half selection, refresh retention and filter clearing", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "执行" });
    api.list.mockResolvedValue({ records: [{ ...item, summary: item.output }, { ...item, id: "other", taskName: "其他任务", summary: item.output }], total: 40, templates: [], owners: [] });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("checkbox", { name: "选择任务：其他任务" });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择任务：模块巡检" }));
    expect((screen.getByRole("checkbox", { name: "全选当前页" }) as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前页" }));
    expect(screen.getByText("已选 2 条")).toBeTruthy();
    api.list.mockResolvedValue({ records: [{ ...item, id: "third", taskName: "下一页任务", summary: item.output }], total: 40, templates: [], owners: [] });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByRole("checkbox", { name: "选择任务：下一页任务" });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择任务：下一页任务" }));
    expect(screen.getByText("已选 3 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy());
    expect(screen.getByText("已选 3 条")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "搜索" } });
    expect(screen.queryByRole("group", { name: "批量操作" })).toBeNull();
  });
  it("shows a batch confirmation and result without opening a single-item dialog", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "执行" });
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前页" }));
    fireEvent.click(screen.getByRole("button", { name: "批量作废" }));
    const dialog = await screen.findByRole("dialog", { name: "批量作废" });
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "确认批量操作" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "批量作废原因" }), { target: { value: "重复任务" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认批量操作" }));
    await waitFor(() => expect(within(dialog).getByText(/成功 1 条/)).toBeTruthy());
    expect(api.void).toHaveBeenCalledWith({ id: "item", version: 1, reason: "重复任务" });
    expect(within(dialog).queryByRole("button", { name: "确认批量操作" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("group", { name: "批量操作" })).toBeNull();
  });
  it("persists every filter and restores the first query on page zero", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "执行" });
    fireEvent.change(screen.getByRole("combobox", { name: "模板" }), { target: { value: "template" } });
    fireEvent.change(screen.getByRole("combobox", { name: "负责人" }), { target: { value: "owner" } });
    fireEvent.change(screen.getByRole("combobox", { name: "后续处理" }), { target: { value: "false" } });
    for (const name of ["创建中", "执行中", "待核对", "已完成", "失败", "中断"]) fireEvent.click(screen.getByRole("checkbox", { name }));
    await screen.findByRole("button", { name: "刷新" });
    api.list.mockResolvedValue({ records: [{ ...item, summary: item.output }], total: 40, templates: [{ id: "template", name: "工程" }], owners: [{ id: "owner", name: "模块", templateId: "template" }] });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 })));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索任务" }), { target: { value: "巡检" } });
    expect(JSON.parse(localStorage.getItem(filterStorageKey)!)).toEqual({ templateId: "template", ownerId: "owner", followUp: "false", statuses: ["pending"], keyword: "巡检" });
    cleanup();
    const restored = setup();
    expect(restored.api.list.mock.calls[0][0]).toEqual({ templateId: "template", ownerId: "owner", needsFollowUp: false, statuses: ["pending"], keyword: "巡检", page: 0 });
    expect((screen.getByRole("searchbox", { name: "搜索任务" }) as HTMLInputElement).value).toBe("巡检");
    await screen.findByRole("button", { name: "执行" });
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    cleanup();
    const reset = setup();
    expect(reset.api.list.mock.calls[0][0]).toEqual({ statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"], keyword: "", page: 0 });
  });
  it("restores an explicitly empty status selection", () => {
    localStorage.setItem(filterStorageKey, JSON.stringify({ statuses: [] }));
    const { api } = setup();
    expect(api.list.mock.calls[0][0]?.statuses).toEqual([]);
    expect(screen.getAllByRole("checkbox").every(input => !(input as HTMLInputElement).checked)).toBe(true);
  });
  it.each(["broken JSON", "null", "[]", JSON.stringify({ templateId: 42, ownerId: {}, keyword: [], followUp: "invalid", statuses: ["unknown"] })])("falls back to defaults for invalid saved filters: %s", saved => {
    localStorage.setItem(filterStorageKey, saved);
    const { api } = setup();
    expect(api.list.mock.calls[0][0]).toEqual({ statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"], keyword: "", page: 0 });
  });
  it("keeps valid fields when another saved field is invalid", () => {
    localStorage.setItem(filterStorageKey, JSON.stringify({ keyword: "巡检", followUp: "true", statuses: ["unknown"] }));
    const { api } = setup();
    expect(api.list.mock.calls[0][0]).toEqual(expect.objectContaining({ keyword: "巡检", needsFollowUp: true, statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"] }));
  });
  it("continues querying when preference storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    const { api } = setup();
    await screen.findByRole("button", { name: "执行" });
    fireEvent.change(screen.getByRole("combobox", { name: "后续处理" }), { target: { value: "true" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ needsFollowUp: true })));
  });
  it("debounces consecutive search input and resets pagination with the final query", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "执行" });
    api.list.mockResolvedValue({ records: [{ ...item, summary: item.output }], total: 40, templates: [], owners: [] });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 })));
    vi.useFakeTimers();
    api.list.mockClear();
    api.list.mockResolvedValue({ records: [], total: 0, templates: [], owners: [] });
    const input = screen.getByRole("searchbox", { name: "搜索任务" }) as HTMLInputElement;
    for (const keyword of ["不存在", "不存在的", "不存在的关键词"]) {
      fireEvent.change(input, { target: { value: keyword } });
      expect(input.value).toBe(keyword);
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(api.list).not.toHaveBeenCalled();
    }
    await act(async () => { vi.advanceTimersByTime(199); });
    expect(api.list).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "不存在的关键词", page: 0 }));
    expect(screen.getByText("没有符合筛选条件的任务")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "", page: 0 }));
  });
  it("cancels pending search when hidden or unmounted", async () => {
    const { api } = setup();
    await screen.findByRole("button", { name: "执行" });
    vi.useFakeTimers();
    api.list.mockClear();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索任务" }), { target: { value: "未提交" } });
    cleanup();
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(api.list).not.toHaveBeenCalled();
    const view = render(<WorkItemWorkspace visible onOpenSession={() => {}} />);
    await act(async () => {});
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "未提交", page: 0 }));
    api.list.mockClear();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索任务" }), { target: { value: "隐藏前输入" } });
    view.rerender(<WorkItemWorkspace visible={false} onOpenSession={() => {}} />);
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(api.list).not.toHaveBeenCalled();
  });
  it("defaults to Markdown preview, keeps edits across modes and resets configuration on reopen", async () => {
    const f = setup({ output: "## 修复建议\n\n**检查统计基线**\n\n- 保留累计值\n\n```js\nclear();\n```" });
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));
    let dialog = await screen.findByRole("dialog", { name: "执行任务" });
    await within(dialog).findByRole("heading", { name: "修复建议" });
    expect(within(dialog).queryByRole("textbox", { name: "实际提示词" })).toBeNull();
    const config = within(dialog).getByText("执行配置").closest("details")!;
    expect(config.open).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
    const editor = within(dialog).getByRole("textbox", { name: "实际提示词" });
    fireEvent.change(editor, { target: { value: "## 编辑后的建议\n\n**保留原文**" } });
    config.open = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "预览" }));
    expect(within(dialog).getByRole("heading", { name: "编辑后的建议" })).toBeTruthy();
    await act(async () => f.changed());
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
    expect(config.open).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
    expect((within(dialog).getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("## 编辑后的建议\n\n**保留原文**");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "执行" }));
    dialog = await screen.findByRole("dialog", { name: "执行任务" });
    await within(dialog).findByRole("heading", { name: "修复建议" });
    expect(within(dialog).getByText("执行配置").closest("details")!.open).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(f.api.execute).toHaveBeenCalledWith({ id: "item", version: 1, prompt: "## 修复建议\n\n**检查统计基线**\n\n- 保留累计值\n\n```js\nclear();\n```" }));
  });
  it("filters follow-up and resets to all", async () => {
    const { api } = setup();
    await screen.findByRole("columnheader", { name: "后续处理" });
    fireEvent.change(screen.getByRole("combobox", { name: "后续处理" }), { target: { value: "false" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ needsFollowUp: false, page: 0 })));
    fireEvent.change(screen.getByRole("combobox", { name: "后续处理" }), { target: { value: "true" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ needsFollowUp: true, page: 0 })));
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    await waitFor(() => expect(api.list.mock.calls.at(-1)?.[0]).not.toHaveProperty("needsFollowUp"));
  });
  it("marks from the execute dialog without losing edits and executes the latest version", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const prompt = await screen.findByRole("textbox", { name: "实际提示词" });
    fireEvent.change(prompt, { target: { value: "保留编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "标记为不需要后续处理" }));
    await screen.findByRole("button", { name: "标记为需要后续处理" });
    await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
    expect((prompt as HTMLTextAreaElement).value).toBe("保留编辑");
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith({ id: "item", version: 2, prompt: "保留编辑" }));
  });
  it("toggles both ways from more even when void and reports failures", async () => {
    const { api } = setup({ status: "void", unavailable: "来源已删除" });
    fireEvent.click(await screen.findByRole("button", { name: "模块巡检：更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标记为不需要后续处理" }));
    await waitFor(() => expect(api.setFollowUp).toHaveBeenCalledWith({ id: "item", version: 1, needsFollowUp: false }));
    await screen.findByText("不需要", { selector: "td" });
    fireEvent.click(screen.getByRole("button", { name: "模块巡检：更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标记为需要后续处理" }));
    await screen.findByText("需要", { selector: "td" });
    api.setFollowUp.mockRejectedValueOnce(new Error("任务已变更，请刷新后重试。"));
    fireEvent.click(screen.getByRole("button", { name: "模块巡检：更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标记为不需要后续处理" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("任务已变更");
  });
  it("previews raw output/config before execution and submits only once", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));
    const dialog = await screen.findByRole("dialog", { name: "执行任务" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "编辑" }));
    const prompt = await within(dialog).findByRole("textbox", { name: "实际提示词" });
    expect((prompt as HTMLTextAreaElement).value).toBe(item.output);
    fireEvent.change(prompt, { target: { value: "编辑后的方案" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "预览" }));
    expect(within(dialog).getByText("编辑后的方案")).toBeTruthy();
    expect(api.execute).not.toHaveBeenCalled();
    const confirm = within(dialog).getByRole("button", { name: "确认执行" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
    expect(api.execute).toHaveBeenCalledWith({ id: "item", version: 1, prompt: "编辑后的方案" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findByRole("button", { name: "执行" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("rejects blank text, preserves edits on refresh/failure and resets when reopened", async () => {
    const f = setup();
    f.api.execute.mockRejectedValueOnce(new Error("创建失败"));
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    let prompt = await screen.findByRole("textbox", { name: "实际提示词" });
    fireEvent.change(prompt, { target: { value: " \n " } });
    expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(prompt, { target: { value: "本次编辑" } });
    await act(async () => f.changed());
    await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
    expect((prompt as HTMLTextAreaElement).value).toBe("本次编辑");
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await screen.findByText(/创建失败/);
    await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
    expect((prompt as HTMLTextAreaElement).value).toBe("本次编辑");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "执行" }));
    expect((await screen.findByRole("button", { name: "预览" })).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    prompt = await screen.findByRole("textbox", { name: "实际提示词" });
    expect((prompt as HTMLTextAreaElement).value).toBe(item.output);
  });
  it("passes filters and displays source errors without enabling execution", async () => {
    const { api } = setup({ unavailable: "来源负责人已删除。" });
    await screen.findByText("来源负责人已删除。");
    expect((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled).toBe(true);
    const filters = within(screen.getByRole("group", { name: "状态" }));
    expect((filters.getByRole("checkbox", { name: "已作废" }) as HTMLInputElement).checked).toBe(false);
    expect(api.list).toHaveBeenLastCalledWith({ statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"], keyword: "", page: 0 });
    for (const name of ["待执行", "创建中", "执行中", "待核对", "失败", "中断"]) fireEvent.click(filters.getByRole("checkbox", { name }));
    fireEvent.click(filters.getByRole("checkbox", { name: "已作废" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索任务" }), { target: { value: "检查" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ statuses: ["completed", "void"], keyword: "检查", page: 0 }));
    fireEvent.click(filters.getByRole("checkbox", { name: "已完成" }));
    fireEvent.click(filters.getByRole("checkbox", { name: "已作废" }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ statuses: [], keyword: "检查", page: 0 }));
  });
  it("opens full attempt output and its session separately from the original reply", async () => {
    const { api, onOpenSession } = setup({ status: "completed", latestAttemptId: "attempt" });
    fireEvent.click(await screen.findByRole("button", { name: "模块巡检：更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "执行记录" }));
    const dialog = await screen.findByRole("dialog", { name: "执行记录" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /已完成.*session/ }));
    await within(dialog).findByText("执行回复");
    expect(api.getAttempt).toHaveBeenCalledWith({ id: "item", attemptId: "attempt" });
    fireEvent.click(within(dialog).getByRole("button", { name: "打开会话" }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("session"));
  });
  it("confirms void reason and keeps original output read-only", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "模块巡检：更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "作废" }));
    const dialog = await screen.findByRole("dialog", { name: "作废任务" });
    fireEvent.change(within(dialog).getByLabelText("作废原因"), { target: { value: "没有待处理问题" } });
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "确认作废" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认作废" }));
    await waitFor(() => expect(api.void).toHaveBeenCalledWith({ id: "item", version: 1, reason: "没有待处理问题" }));
  });
  it("refreshes on backend changes and offers reconciliation instead of another execution", async () => {
    const f = setup({ status: "uncertain", latestAttemptId: "attempt" });
    const execute = await screen.findByRole("button", { name: "再次执行" });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    await act(async () => f.changed());
    expect(f.api.list.mock.calls.length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "模块巡检：更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "核对结果" }));
    const dialog = await screen.findByRole("dialog", { name: "核对执行结果" });
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "确认已结束，标记中断" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认已结束，标记中断" }));
    await waitFor(() => expect(f.api.resolveUncertain).toHaveBeenCalledWith({ id: "item", version: 1 }));
  });
  it("navigates the portal menu and restores focus on Escape", async () => {
    setup({ latestAttemptId: "attempt", sessionId: "session" });
    const trigger = await screen.findByRole("button", { name: "模块巡检：更多操作" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "执行记录" }));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "作废" }));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "标记为不需要后续处理" }));
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("renders Markdown without images or raw link destinations and resets filters", async () => {
    const { api } = setup({ output: "**问题位置**：[服务文件](file:///C:/repo/server.cjs) `decodeURIComponent` ![图片](https://example.com/a.png)" });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("问题位置").tagName).toBe("STRONG");
    expect(within(table).getByText("decodeURIComponent").tagName).toBe("CODE");
    expect(table.querySelector("img")).toBeNull();
    expect(table.textContent).not.toContain("file:///");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "查找" } });
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ statuses: ["pending", "creating", "running", "uncertain", "completed", "failed", "stopped"], keyword: "", page: 0 }));
  });

  it.each(["creating", "running", "uncertain", "void"] as const)("keeps execution locked for %s", async status => {
    setup({ status });
    expect((await screen.findByRole("button", { name: "执行" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "模块巡检：更多操作" }));
    if (status === "void") expect(screen.getByRole("menuitem", { name: "恢复" })).toBeTruthy();
    else expect((screen.getByRole("menuitem", { name: "作废" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("distinguishes an empty list from an empty filtered result", async () => {
    const { api } = setup();
    await screen.findByRole("table");
    api.list.mockResolvedValue({ records: [], total: 0, templates: [], owners: [] });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "不存在" } });
    await screen.findByText("没有符合筛选条件的任务");
    fireEvent.click(within(screen.getByText("没有符合筛选条件的任务").parentElement!).getByRole("button", { name: "重置筛选" }));
    await screen.findByText("暂无任务");
  });

});

it("appends quick prompts to edited input and resets when reopening", async () => {
  const f = setup();
  vi.mocked(f.api.listQuickPrompts).mockResolvedValue([{ id: "quick", version: 1, name: "补充验证", prompt: "运行测试" }]);
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  const quick = await screen.findByRole("button", { name: "补充验证" });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const input = await screen.findByRole("textbox", { name: "实际提示词" });
  fireEvent.change(input, { target: { value: "手动修改" } });
  fireEvent.click(quick); fireEvent.click(quick);
  expect((input as HTMLTextAreaElement).value).toBe("手动修改\n\n运行测试\n\n运行测试");
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  await screen.findByRole("button", { name: "补充验证" });
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect((screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("最终执行方案");
  fireEvent.click(screen.getByRole("button", { name: "补充验证" }));
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(f.api.execute).toHaveBeenCalledWith({ id: "item", version: 1, prompt: "最终执行方案\n\n运行测试" }));
});

it.each(["pending", "failed", "stopped"] as const)("manually completes %s without executing", async status => {
  const f = setup({ status });
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  const button = await screen.findByRole("button", { name: "标记完成" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(f.api.markCompleted).toHaveBeenCalledExactlyOnceWith({ id: "item", version: 1 }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "执行任务" })).toBeNull());
  expect(f.api.execute).not.toHaveBeenCalled();
});
it("allows manual completion when execution preview fails", async () => {
  const status = "pending" as const; const f = setup({ status });
  vi.mocked(f.api.preview).mockRejectedValueOnce(new Error("来源模板已删除"));
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await screen.findByText("Error: 来源模板已删除");
  const button = screen.getByRole("button", { name: "标记完成" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(f.api.markCompleted).toHaveBeenCalledWith({ id: "item", version: 1 }));
});
it("hides manual completion for completed tasks", async () => {
  const status = "completed" as const; setup({ status });
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await screen.findByRole("dialog", { name: "执行任务" });
  expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
});

it("keeps edited prompt on manual completion conflict", async () => {
  const f = setup();
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

it("initializes persistent prompts once, permits removal and reloads defaults on reopen", async () => {
  const { api } = setup();
  vi.mocked(api.listQuickPrompts).mockResolvedValue([
    { id: "a", version: 1, name: "常驻一", prompt: "测试", persistent: true },
    { id: "b", version: 1, name: "手动", prompt: "不追加" },
    { id: "c", version: 1, name: "常驻二", prompt: "构建", persistent: true },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const input = screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement;
  expect(input.value).toBe("最终执行方案\n\n测试\n\n构建");
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
  expect((screen.getByRole("textbox", { name: "实际提示词" }) as HTMLTextAreaElement).value).toBe("最终执行方案\n\n新配置");
  fireEvent.change(screen.getByRole("textbox", { name: "实际提示词" }), { target: { value: "最终输入" } });
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ prompt: "最终输入" })));
});
it("blocks execution when persistent prompt loading fails and allows retry", async () => {
  const { api } = setup();
  vi.mocked(api.listQuickPrompts).mockRejectedValue(new Error("常驻加载失败"));
  fireEvent.click(await screen.findByRole("button", { name: "执行" }));
  await screen.findByRole("button", { name: "重新查询" });
  expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.listQuickPrompts).mockResolvedValue([{ id: "a", version: 1, name: "常驻", prompt: "恢复", persistent: true }]);
  fireEvent.click(screen.getByRole("button", { name: "重新查询" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.preview).toHaveBeenCalledWith(expect.objectContaining({ prompt: "最终执行方案\n\n恢复" }));
});
