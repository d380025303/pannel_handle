// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleOwnerWorkspace } from "./ModuleOwnerWorkspace";
import type { ModuleOwnerApi, ModuleOwnerState, ModuleOwnerTask, SessionApi } from "../../vite-env";

const record = { id: "owner", name: "桌面", responsibilities: "桌面交互", recentActivity: "完成模块检查", directories: ["src"], version: 1, createdAt: 1, updatedAt: 1 };
const initial: ModuleOwnerState = { revision: 1, records: [record], settings: { mode: "plan", prompt: "分析模块" }, generation: null,
  history: [{ id: "initial", revision: 0, operation: "initial", source: "system", at: 1, records: [] }, { id: "added", revision: 1, operation: "add", source: "ai", at: 2, kind: "owner", ownerId: record.id, before: null, after: record }] };
let ownerApi: ModuleOwnerApi;
let changed: ((event: { templateId: string }) => void) | undefined;
beforeEach(() => {
  ownerApi = {
    listPromptTemplates: vi.fn().mockResolvedValue([]), savePromptTemplate: vi.fn(), deletePromptTemplate: vi.fn(), previewPromptPublish: vi.fn(), publishPromptTemplate: vi.fn(),
    listTaskRuns: vi.fn().mockResolvedValue({ records: [], total: 0 }), getTaskRun: vi.fn(), deleteTaskRun: vi.fn().mockResolvedValue(undefined),
    listHistory: vi.fn().mockResolvedValue({ revision: initial.revision, history: initial.history.filter(entry => entry.kind === "owner") }),
    copyTask: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue([]), listTasks: vi.fn().mockResolvedValue([]), saveTask: vi.fn().mockResolvedValue([]), deleteTask: vi.fn().mockResolvedValue([]),
    listTemplates: vi.fn().mockResolvedValue([{ templateId: "one", title: "项目一", cwd: "C:/repo", supported: true }, { templateId: "two", title: "项目二", cwd: "C:/other", supported: false }]),
    get: vi.fn().mockResolvedValue(structuredClone(initial)), preview: vi.fn().mockResolvedValue({ templateId: "one", tools: [{ name: "add_module_owner" }], toolCallback: { bearerToken: "<临时授权>" } }),
    mutate: vi.fn().mockResolvedValue(initial), configure: vi.fn().mockResolvedValue(initial), restore: vi.fn().mockResolvedValue({ ...initial, records: [] }),
    generate: vi.fn().mockResolvedValue({ result: { status: 201, method: "POST", url: "http://localhost/api/v1/session-instances", elapsedMs: 1, body: { sessionId: "run", status: "started" } }, state: { ...initial, generation: { status: "running", sessionId: "run", error: "", startedAt: 1 } } }),
    onChanged: vi.fn(callback => { changed = callback; return () => { changed = undefined; }; })
  };
  window.moduleOwnerApi = ownerApi;
  window.sessionApi = { get: vi.fn().mockResolvedValue({ running: true, url: "http://localhost", error: "" }), onChanged: vi.fn(() => () => {}), configure: vi.fn() } as unknown as SessionApi;
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("module owner workspace", () => {
  it("edits fields with the displayed version and refuses to hide conflict errors", async () => {
    render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 桌面" }));
    expect((screen.getByLabelText("近期行为") as HTMLTextAreaElement).value).toBe("完成模块检查");
    fireEvent.change(screen.getByLabelText("近期行为"), { target: { value: "修复问题\n验证完成" } });
    fireEvent.change(screen.getByLabelText("职责"), { target: { value: "新职责" } });
    vi.mocked(ownerApi.mutate).mockRejectedValueOnce(new Error("记录已修改，请重新读取"));
    fireEvent.click(screen.getByRole("button", { name: "保存负责人" }));
    await waitFor(() => expect(ownerApi.mutate).toHaveBeenCalledWith("one", { operation: "update", id: "owner", version: 1, name: "桌面", responsibilities: "新职责", recentActivity: "修复问题\n验证完成", directories: ["src"] }));
    expect((await screen.findByRole("alert")).textContent).toContain("重新读取");
    expect((screen.getByLabelText("职责") as HTMLTextAreaElement).value).toBe("新职责");
  });
  it("passes editable template, mode and prompt to generation and opens the running session", async () => {
    const open = vi.fn(); render(<ModuleOwnerWorkspace visible onOpenSession={open} />);
    await screen.findByRole("button", { name: "编辑 桌面" });
    fireEvent.click(screen.getByRole("button", { name: "AI 分析生成" }));
    fireEvent.change(screen.getByLabelText("会话模式"), { target: { value: "default" } });
    fireEvent.change(screen.getByLabelText("生成提示词"), { target: { value: "自定义分析" } });
    fireEvent.click(screen.getByRole("button", { name: "分析并生成负责人" }));
    await waitFor(() => expect(ownerApi.generate).toHaveBeenCalledWith("one", { mode: "default", prompt: "自定义分析" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开分析会话" }));
    expect(open).toHaveBeenCalledWith("run");
    expect((screen.getByRole("button", { name: "分析并生成负责人" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("defaults to latest owner history and restores only that owner", async () => {
    render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    await screen.findByRole("button", { name: "编辑 桌面" });
    fireEvent.click(screen.getByRole("button", { name: "历史记录" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复此负责人" }));
    expect(screen.getByText("操作前")).toBeTruthy();
    expect(screen.getByText("操作后")).toBeTruthy();
    expect(screen.getByRole("button", { name: /新增.*AI.*桌面/ }).getAttribute("aria-pressed")).toBe("true");
    expect(ownerApi.restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(ownerApi.restore).toHaveBeenCalledWith("one", { historyId: "added", revision: 1 }));
    await screen.findByText("暂无负责人，可手工新增或让 AI 分析生成。");
  });
  it("refreshes changed records while preserving an edit draft and restricts unsupported templates", async () => {
    render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 桌面" }));
    fireEvent.change(screen.getByLabelText("职责"), { target: { value: "未保存草稿" } });
    vi.mocked(ownerApi.get).mockResolvedValue({ ...initial, records: [{ ...record, version: 2, name: "AI 新模块" }] });
    changed?.({ templateId: "one" });
    await screen.findByRole("button", { name: "编辑 AI 新模块" });
    expect((screen.getByLabelText("职责") as HTMLTextAreaElement).value).toBe("未保存草稿");
    fireEvent.change(screen.getByLabelText("会话模板"), { target: { value: "two" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "AI 分析生成" }));
    await screen.findByText(/此模板仍可手工维护负责人表/);
    expect((screen.getByRole("button", { name: "分析并生成负责人" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps forms off the main page and adds a record only from its dialog", async () => {
    render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    await screen.findByRole("button", { name: "编辑 桌面" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("职责")).toBeNull();
    expect(screen.queryByLabelText("生成提示词")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新增负责人" }));
    const modal = within(screen.getByRole("dialog", { name: "新增负责人" }));
    fireEvent.change(modal.getByLabelText("负责模块名称"), { target: { value: "新模块" } });
    fireEvent.change(modal.getByLabelText("职责"), { target: { value: "新职责" } });
    fireEvent.change(modal.getByLabelText(/模块主要负责目录/), { target: { value: "src/new\n electron/new " } });
    fireEvent.click(modal.getByRole("button", { name: "保存负责人" }));
    await waitFor(() => expect(ownerApi.mutate).toHaveBeenCalledWith("one", { operation: "add", name: "新模块", responsibilities: "新职责", recentActivity: "", directories: ["src/new", "electron/new"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("requires explicit deletion confirmation and sends the displayed record version", async () => {
    render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    const trigger = await screen.findByRole("button", { name: "删除 桌面" });
    fireEvent.click(trigger);
    expect(ownerApi.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(ownerApi.mutate).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(ownerApi.mutate).toHaveBeenCalledWith("one", { operation: "delete", id: "owner", version: 1 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("traps keyboard focus, discards canceled edits and restores focus to the opener", async () => {
    render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    const trigger = await screen.findByRole("button", { name: "编辑 桌面" });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "保存负责人" }));
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭弹窗" }));
    fireEvent.change(screen.getByLabelText("职责"), { target: { value: "取消的草稿" } });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect((screen.getByLabelText("职责") as HTMLTextAreaElement).value).toBe("桌面交互");
  });
  it("keeps generation running after closing and prohibits restoring history", async () => {
    const { rerender } = render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    await screen.findByRole("button", { name: "编辑 桌面" });
    fireEvent.click(screen.getByRole("button", { name: "AI 分析生成" }));
    fireEvent.click(screen.getByRole("button", { name: "分析并生成负责人" }));
    await screen.findByRole("button", { name: "打开分析会话" });
    await waitFor(() => expect((screen.getByRole("button", { name: "关闭弹窗" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    fireEvent.click(screen.getByRole("button", { name: "AI 分析生成" }));
    expect(screen.getByRole("status").textContent).toContain("分析进行中");
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    fireEvent.click(screen.getByRole("button", { name: "历史记录" }));
    expect((screen.getByRole("button", { name: "恢复此负责人" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ModuleOwnerWorkspace visible={false} onOpenSession={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocks duplicate submissions and dismissals while saving", async () => {
    let finish!: (value: ModuleOwnerState) => void;
    vi.mocked(ownerApi.mutate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 桌面" }));
    const save = screen.getByRole("button", { name: "保存负责人" });
    fireEvent.click(save); fireEvent.click(save);
    expect(ownerApi.mutate).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "关闭弹窗" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    finish(initial);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

});

it("shows legacy snapshots as read-only", async () => {
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  await screen.findByRole("button", { name: "编辑 桌面" });
  fireEvent.click(screen.getByRole("button", { name: "历史记录" }));
  fireEvent.click(screen.getByRole("button", { name: /旧版整表快照/ }));
  expect(screen.getByText("旧版整表快照，仅供查看。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "恢复此负责人" })).toBeNull();
});

it("configures per-owner schedules and selected tools in the task dialog", async () => {
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  fireEvent.click(screen.getByRole("button", { name: "新增定时任务" }));
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "巡检" } });
  fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "检查模块" } });
  fireEvent.change(screen.getByLabelText("周期类型"), { target: { value: "interval" } });
  for (const tool of ["update_module_owner"]) {
    expect((screen.getByLabelText(tool) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText(tool));
  }
  fireEvent.click(screen.getByLabelText("启用任务"));
  expect((screen.getByLabelText("记录到历史记录") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText("记录到历史记录"));
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await waitFor(() => expect(ownerApi.saveTask).toHaveBeenCalledWith("one", { ownerId: "owner", name: "巡检", prompt: "检查模块", mode: "default", enabled: true, recordHistory: true,
    tools: ["update_module_owner"], schedule: { kind: "interval", minutes: 30, count: 10 } }));
  expect(screen.queryByRole("group", { name: "新增定时任务" })).toBeNull();
});

const task: ModuleOwnerTask = { id: "task", ownerId: "owner", name: "巡检", prompt: "检查模块", mode: "plan", enabled: true,
  tools: ["update_module_owner"], schedule: { kind: "interval", minutes: 15, count: 5 }, executedCount: 2, nextRunAt: 1000,
  lastRun: { status: "completed", sessionId: "task-session", error: "", startedAt: 1 } };

it("opens a list first, isolates nested editing and restores focus one level at a time", async () => {
  vi.mocked(ownerApi.listTasks).mockResolvedValue([task]);
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  const ownerTrigger = await screen.findByRole("button", { name: "定时任务 桌面" });
  ownerTrigger.focus(); fireEvent.click(ownerTrigger);
  const outer = screen.getByRole("dialog", { name: "桌面 · 定时任务" });
  expect(screen.queryByLabelText("任务名称")).toBeNull();
  const list = await screen.findByRole("table", { name: "定时任务列表" });
  expect(within(list).getAllByRole("columnheader")).toHaveLength(5);
  const row = within(list).getByRole("row", { name: /巡检/ });
  expect(within(row).getByText("已启用")).toBeTruthy();
  expect(within(row).getByText("已执行 2 次")).toBeTruthy();
  const edit = within(row).getByRole("button", { name: "编辑任务" });
  edit.focus(); fireEvent.click(edit);
  const inner = screen.getByRole("dialog", { name: "编辑定时任务" });
  expect(outer.inert).toBe(true);
  expect(outer.getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement).toBe(inner);
  expect((screen.getByLabelText("任务名称") as HTMLInputElement).value).toBe("巡检");
  expect((screen.getByLabelText("update_module_owner") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("list_module_owners") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("会话模式") as HTMLSelectElement).value).toBe("plan");
  expect((screen.getByLabelText("执行次数上限") as HTMLInputElement).value).toBe("5");
  fireEvent.keyDown(inner, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "保存任务" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭弹窗" }));
  fireEvent.keyDown(inner, { key: "Escape" });
  expect(outer.inert).toBe(false);
  expect(document.activeElement).toBe(edit);
  expect(ownerApi.saveTask).not.toHaveBeenCalled();
  fireEvent.keyDown(outer, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(ownerTrigger);
});

it("preserves a failed task draft during list refresh and returns to the updated list after saving", async () => {
  vi.mocked(ownerApi.listTasks).mockResolvedValue([task]);
  vi.mocked(ownerApi.saveTask).mockRejectedValueOnce(new Error("周期配置无效")).mockResolvedValueOnce([{ ...task, name: "新巡检" }]);
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑任务" }));
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "新巡检" } });
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  expect((await screen.findByRole("alert")).textContent).toContain("周期配置无效");
  vi.mocked(ownerApi.listTasks).mockResolvedValue([{ ...task, name: "后台更新" }]);
  changed?.({ templateId: "one" });
  await waitFor(() => expect(screen.getByText("后台更新")).toBeTruthy());
  expect((screen.getByLabelText("任务名称") as HTMLInputElement).value).toBe("新巡检");
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑定时任务" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "桌面 · 定时任务" })).toBeTruthy();
  expect(screen.getByText("新巡检")).toBeTruthy();
  expect(ownerApi.saveTask).toHaveBeenLastCalledWith("one", { id: "task", ownerId: "owner", name: "新巡检", prompt: "检查模块", mode: "plan", enabled: true, recordHistory: false, tools: ["update_module_owner"], schedule: task.schedule });
});

it("blocks duplicate task saves and dismissals while pending", async () => {
  let finish!: (tasks: ModuleOwnerTask[]) => void;
  vi.mocked(ownerApi.saveTask).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  await screen.findByText("暂无定时任务，点击上方按钮添加。");
  fireEvent.click(screen.getByRole("button", { name: "新增定时任务" }));
  expect(screen.queryByLabelText("search_module_owner_task_runs")).toBeNull();
  expect(screen.queryByLabelText("get_module_owner_task_run")).toBeNull();
  for (const name of ["list_module_owners", "update_module_owner"]) {
    expect((screen.getByLabelText(name) as HTMLInputElement).checked).toBe(false);
  }
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "巡检" } });
  fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "检查模块" } });
  const inner = screen.getByRole("dialog", { name: "新增定时任务" });
  const form = inner.querySelector("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(ownerApi.saveTask).toHaveBeenCalledTimes(1);
  expect(ownerApi.saveTask).toHaveBeenLastCalledWith("one", expect.objectContaining({ tools: [] }));
  expect((screen.getByRole("button", { name: "关闭弹窗" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(inner, { key: "Escape" });
  fireEvent.mouseDown(inner.parentElement!);
  expect(screen.getByRole("dialog", { name: "新增定时任务" })).toBeTruthy();
  finish([task]);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新增定时任务" })).toBeNull());
  expect(screen.getByText("巡检")).toBeTruthy();
});

it("cancels nested forms with buttons and backdrop, and keeps task row actions working", async () => {
  vi.mocked(ownerApi.listTasks).mockResolvedValue([task]);
  vi.mocked(ownerApi.saveTask).mockResolvedValue([{ ...task, enabled: false }]);
  const open = vi.fn();
  render(<ModuleOwnerWorkspace visible onOpenSession={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  fireEvent.click(screen.getByRole("button", { name: "新增定时任务" }));
  fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
  expect(screen.queryByLabelText("任务名称")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "编辑任务" }));
  fireEvent.mouseDown(screen.getByRole("dialog", { name: "编辑定时任务" }).parentElement!);
  expect(screen.queryByLabelText("任务名称")).toBeNull();
  expect(ownerApi.saveTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开会话" }));
  expect(open).toHaveBeenCalledWith("task-session");
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  await screen.findByText("已停用");
  fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
  const confirmation = screen.getByRole("button", { name: "确认删除任务" }).closest("tr")!;
  expect(confirmation.querySelector("td")?.colSpan).toBe(5);
  expect(ownerApi.deleteTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认删除任务" }));
  await screen.findByText("暂无定时任务，点击上方按钮添加。");
  expect(ownerApi.deleteTask).toHaveBeenCalledWith("one", { id: "task" });
});


it("loads only the row owner history, restores with the query revision and keeps the overview", async () => {
  vi.mocked(ownerApi.listHistory).mockResolvedValue({ revision: 8, history: [initial.history[1]] });
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "历史记录 桌面" }));
  const modal = within(screen.getByRole("dialog", { name: "桌面 · 历史记录" }));
  await modal.findByText("操作后");
  expect(ownerApi.listHistory).toHaveBeenCalledWith("one", { ownerId: "owner" });
  expect(modal.queryByRole("button", { name: /旧版整表快照/ })).toBeNull();
  expect(modal.getByRole("button", { name: /新增.*AI.*桌面/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(modal.getByRole("button", { name: "恢复此负责人" }));
  fireEvent.click(modal.getByRole("button", { name: "确认恢复" }));
  await waitFor(() => expect(ownerApi.restore).toHaveBeenCalledWith("one", { historyId: "added", revision: 8 }));
  await waitFor(() => expect(ownerApi.listHistory).toHaveBeenCalledTimes(2));
  fireEvent.click(modal.getByRole("button", { name: "关闭弹窗" }));
  fireEvent.click(screen.getByRole("button", { name: "历史记录" }));
  expect(screen.getByRole("button", { name: /旧版整表快照/ })).toBeTruthy();
});

it("shows empty history and retries failed queries", async () => {
  vi.mocked(ownerApi.listHistory).mockRejectedValueOnce(new Error("查询失败")).mockResolvedValue({ revision: 1, history: [] });
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "历史记录 桌面" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "查询失败");
  fireEvent.click(screen.getByRole("button", { name: "重试查询" }));
  await screen.findByText("此负责人暂无历史记录。");
  expect(screen.queryByRole("button", { name: "恢复此负责人" })).toBeNull();
});

it("discards late row history responses after closing or changing templates", async () => {
  let finish!: (value: { revision: number; history: ModuleOwnerState["history"] }) => void;
  vi.mocked(ownerApi.listHistory).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "历史记录 桌面" }));
  await screen.findByRole("status");
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
  finish({ revision: 7, history: [] });
  fireEvent.click(screen.getByRole("button", { name: "历史记录" }));
  expect(screen.getByText("操作后")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
  fireEvent.click(screen.getByRole("button", { name: "历史记录 桌面" }));
  await screen.findByRole("status");
  fireEvent.change(screen.getByLabelText("会话模板"), { target: { value: "two" } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  finish({ revision: 7, history: [] });
  fireEvent.click(await screen.findByRole("button", { name: "历史记录 桌面" }));
  await waitFor(() => expect(ownerApi.listHistory).toHaveBeenLastCalledWith("two", { ownerId: "owner" }));
  expect(screen.queryByText("此负责人暂无历史记录。")).toBeNull();
});

it("reloads row history when owners change and disables restores during generation", async () => {
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "历史记录 桌面" }));
  await screen.findByText("操作后");
  vi.mocked(ownerApi.get).mockResolvedValue({ ...initial, records: [{ ...record, name: "新名称" }], generation: { status: "running", sessionId: "run", error: "", startedAt: 1 } });
  changed?.({ templateId: "one" });
  await screen.findByRole("dialog", { name: "新名称 · 历史记录" });
  await waitFor(() => expect(ownerApi.listHistory).toHaveBeenCalledTimes(2));
  await screen.findByText("操作后");
  expect((screen.getByRole("button", { name: "恢复此负责人" }) as HTMLButtonElement).disabled).toBe(true);
});

it("opens scheduled call history and displays persisted input and final output", async () => {
  vi.mocked(ownerApi.listTasks).mockResolvedValue([task]);
  vi.mocked(ownerApi.listTaskRuns).mockResolvedValue({ records: [{ id: "run", templateId: "one", ownerId: "owner", taskId: "task", taskName: "巡检", calledAt: 1, status: "completed", error: "" }], total: 1 });
  vi.mocked(ownerApi.getTaskRun).mockResolvedValue({ id: "run", templateId: "one", ownerId: "owner", taskId: "task", taskName: "巡检", calledAt: 1, status: "completed", error: "", input: { prompt: "实际输入" }, output: "最终回复文本" });
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  const tasksDialog = await screen.findByRole("dialog", { name: "桌面 · 定时任务" });
  fireEvent.click(await within(tasksDialog).findByRole("button", { name: "历史记录" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(await screen.findByText("最终回复文本")).toBeTruthy();
  expect(screen.getByText(/实际输入/)).toBeTruthy();
  expect(ownerApi.getTaskRun).toHaveBeenCalledWith("one", { taskId: "task", id: "run" });
});

it("copies one task to multiple other owners and preserves selection on failure", async () => {
  vi.mocked(ownerApi.get).mockResolvedValue({ ...initial, records: [record, { ...record, id: "second", name: "移动" }, { ...record, id: "third", name: "服务" }] });
  const task: ModuleOwnerTask = { id: "task", ownerId: "owner", name: "巡检", prompt: "检查", mode: "default", enabled: true, tools: [], schedule: { kind: "cron", cron: "0 * * * *" }, executedCount: 4, nextRunAt: 1000 };
  vi.mocked(ownerApi.listTasks).mockResolvedValue([task]);
  vi.mocked(ownerApi.copyTask).mockRejectedValueOnce(new Error("目标负责人不存在")).mockResolvedValueOnce([task]);
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  fireEvent.click(await screen.findByRole("button", { name: "复制到其它负责人" }));
  const dialog = screen.getByRole("dialog", { name: "复制到其它负责人" });
  expect(within(dialog).queryByLabelText("桌面")).toBeNull();
  expect((within(dialog).getByRole("button", { name: "复制配置" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog).getByLabelText("移动"));
  fireEvent.click(within(dialog).getByLabelText("全选"));
  fireEvent.click(within(dialog).getByRole("button", { name: "复制配置" }));
  await within(dialog).findByRole("alert");
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("目标负责人不存在"));
  expect((within(dialog).getByLabelText("移动") as HTMLInputElement).checked).toBe(true);
  expect((within(dialog).getByLabelText("服务") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "复制配置" }));
  await screen.findByText("已复制到 2 个负责人，新任务均已停用。");
  expect(ownerApi.copyTask).toHaveBeenLastCalledWith("one", { taskId: "task", targetOwnerIds: ["second", "third"] });
  expect(screen.queryByRole("dialog", { name: "复制到其它负责人" })).toBeNull();
});

it("shows an empty copy target list without permitting submission", async () => {
  vi.mocked(ownerApi.listTasks).mockResolvedValue([{ id: "task", ownerId: "owner", name: "巡检", prompt: "检查", mode: "default", enabled: false, tools: [], schedule: { kind: "interval", minutes: 1, count: 2 }, executedCount: 0, nextRunAt: null }]);
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  fireEvent.click(await screen.findByRole("button", { name: "复制到其它负责人" }));
  expect(screen.getByText("当前模板没有其它负责人。")).toBeTruthy();
  expect((screen.getByRole("button", { name: "复制配置" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(ownerApi.copyTask).not.toHaveBeenCalled();
});


it("references a prompt template, permits independent edits and preserves text on detach", async () => {
  vi.mocked(ownerApi.listPromptTemplates).mockResolvedValue([{ id: "shared", name: "共享巡检", prompt: "模板提示词", version: 1, createdAt: 1, updatedAt: 1, referenceCount: 0 }]);
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  fireEvent.click(await screen.findByRole("button", { name: "新增定时任务" }));
  const selector = await screen.findByLabelText("提示词模板");
  await screen.findByRole("option", { name: "共享巡检 · v1" });
  fireEvent.change(selector, { target: { value: "shared" } });
  const prompt = screen.getByLabelText("提示词") as HTMLTextAreaElement;
  expect(prompt.value).toBe("模板提示词");
  fireEvent.change(prompt, { target: { value: "独立修改" } });
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "新任务" } });
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await waitFor(() => expect(ownerApi.saveTask).toHaveBeenCalledWith("one", expect.objectContaining({ promptTemplateId: "shared", prompt: "独立修改" })));
  fireEvent.click(screen.getByRole("button", { name: "新增定时任务" }));
  fireEvent.change(screen.getByLabelText("提示词模板"), { target: { value: "shared" } });
  fireEvent.change(screen.getByLabelText("提示词模板"), { target: { value: "" } });
  expect((screen.getByLabelText("提示词") as HTMLTextAreaElement).value).toBe("模板提示词");
});

it("manually runs a disabled scheduled task and displays launch errors", async () => {
  const task = { id: "task", ownerId: "owner", name: "巡检", prompt: "检查", mode: "default" as const, enabled: false, tools: [], schedule: { kind: "interval" as const, minutes: 1, count: 2 }, executedCount: 0, nextRunAt: null };
  vi.mocked(ownerApi.listTasks).mockResolvedValue([task]);
  vi.mocked(ownerApi.runTask).mockRejectedValueOnce(new Error("请先开启 HTTP 接口服务。")).mockResolvedValueOnce([task]);
  render(<ModuleOwnerWorkspace visible onOpenSession={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "定时任务 桌面" }));
  fireEvent.click(await screen.findByRole("button", { name: "手动执行" }));
  await screen.findByText("请先开启 HTTP 接口服务。");
  fireEvent.click(screen.getByRole("button", { name: "手动执行" }));
  await screen.findByText("已手动执行“巡检”。");
  expect(ownerApi.runTask).toHaveBeenLastCalledWith("one", { id: "task" });
});
