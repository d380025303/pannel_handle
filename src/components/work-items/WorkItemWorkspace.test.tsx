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
    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "completed" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索任务" }), { target: { value: "检查" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ status: "completed", keyword: "检查", page: 0 }));
  });
  it("opens full attempt output and its session separately from the original reply", async () => {
    const { api, onOpenSession } = setup({ status: "completed", latestAttemptId: "attempt" });
    fireEvent.click(await screen.findByRole("button", { name: "执行记录" }));
    const dialog = await screen.findByRole("dialog", { name: "执行记录" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /已完成.*session/ }));
    await within(dialog).findByText("执行回复");
    expect(api.getAttempt).toHaveBeenCalledWith({ id: "item", attemptId: "attempt" });
    fireEvent.click(within(dialog).getByRole("button", { name: "打开会话" }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("session"));
  });
  it("confirms void reason and keeps original output read-only", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "作废" }));
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
    fireEvent.click(screen.getByRole("button", { name: "核对结果" }));
    const dialog = await screen.findByRole("dialog", { name: "核对执行结果" });
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "确认已结束，标记中断" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认已结束，标记中断" }));
    await waitFor(() => expect(f.api.resolveUncertain).toHaveBeenCalledWith({ id: "item", version: 1 }));
  });
});
