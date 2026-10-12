// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItem, WorkItemApi } from "../../vite-env";
import { WorkItemWorkspace } from "./WorkItemWorkspace";

const item: WorkItem = { id: "item", sourceRunId: "source", taskId: "timer", ownerId: "owner", templateId: "template", taskName: "模块巡检", output: "最终执行方案",
  owner: { id: "owner", version: 1, name: "模块", responsibilities: "职责", directories: ["src"], createdAt: 1, updatedAt: 1 }, template: { title: "工程", cwd: "C:\\repo" },
  tools: [], status: "pending", version: 1, createdAt: 1, updatedAt: 1, unavailable: "" };
function setup(overrides: Partial<WorkItem> = {}) {
  let value = { ...item, ...overrides };
  let changed = () => {};
  const api = { list: vi.fn(async () => ({ records: [{ ...value, summary: value.output }], total: 1, templates: [{ id: "template", name: "工程" }], owners: [{ id: "owner", name: "模块", templateId: "template" }] })),
    get: vi.fn(async () => value), preview: vi.fn(async () => ({ body: { prompt: value.output }, configuration: { cwd: "C:\\repo", codexAppServerModel: "model" } })),
    execute: vi.fn(async () => { value = { ...value, status: "running", version: 2 }; return value; }),
    void: vi.fn(async () => ({ ...value, status: "void" as const })), restore: vi.fn(async () => value), resolveUncertain: vi.fn(async () => value),
    listAttempts: vi.fn(async () => ({ records: [{ id: "attempt", workItemId: item.id, status: "completed" as const, startedAt: 1, sessionId: "session", error: "" }], total: 1 })),
    getAttempt: vi.fn(async () => ({ id: "attempt", workItemId: item.id, status: "completed" as const, startedAt: 1, sessionId: "session", input: { prompt: "实际输入" }, configuration: {}, output: "执行回复", error: "" })),
    onChanged: vi.fn(callback => { changed = callback; return () => {}; }) };
  window.workItemApi = api as WorkItemApi;
  window.moduleOwnerApi = { onChanged: () => () => {} } as unknown as typeof window.moduleOwnerApi;
  window.terminalApi = { listSessions: vi.fn(async () => [{ id: "session" }]) } as unknown as typeof window.terminalApi;
  const onOpenSession = vi.fn();
  render(<WorkItemWorkspace visible onOpenSession={onOpenSession} />);
  return { api, onOpenSession, changed: () => changed() };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("manual task list", () => {
  it("previews raw output/config before execution and submits only once", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));
    const dialog = await screen.findByRole("dialog", { name: "执行任务" });
    const prompt = await within(dialog).findByRole("textbox", { name: "实际提示词" });
    expect((prompt as HTMLTextAreaElement).value).toBe(item.output);
    fireEvent.change(prompt, { target: { value: "编辑后的方案" } });
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
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "打开最近会话" }));
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
