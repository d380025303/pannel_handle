// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskRunHistory } from "./TaskRunHistory";
import type { ModuleOwnerApi, ModuleOwnerTask } from "../../vite-env";
const task = { id: "task", name: "巡检" } as ModuleOwnerTask;
const record = { id: "run", taskId: "task", status: "completed", calledAt: 1, taskName: "巡检", input: {}, output: "最终回复" };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(status = "completed", total = 1) {
  let records = [{ ...record, status }];
  const api = {
    listTaskRuns: vi.fn(async (_id: string, input: { page: number }) => ({ records: input.page === 0 ? records : records.slice(20), total: records.length ? total : 0 })),
    getTaskRun: vi.fn(async () => records[0]),
    deleteTaskRun: vi.fn(async () => { records = []; })
  };
  window.moduleOwnerApi = api as unknown as ModuleOwnerApi;
  render(<TaskRunHistory templateId="one" task={task} onClose={() => {}} />);
  return api;
}
it("confirms or cancels deletion and clears selected detail", async () => {
  const api = setup();
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  await screen.findByText("最终回复", { selector: "pre" });
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(api.deleteTaskRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除记录" }));
  await waitFor(() => expect(api.deleteTaskRun).toHaveBeenCalledWith("one", { taskId: "task", id: "run" }));
  await screen.findByText(/暂无调用历史/);
  expect(screen.queryByText("最终回复", { selector: "pre" })).toBeNull();
});
it.each(["creating", "running", "uncertain"])("disables deletion for %s", async status => {
  setup(status);
  expect((await screen.findByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
});
it("keeps records and displays deletion errors", async () => {
  const api = setup(); api.deleteTaskRun.mockRejectedValueOnce(new Error("写入失败"));
  fireEvent.click(await screen.findByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除记录" }));
  expect((await screen.findByRole("alert")).textContent).toContain("写入失败");
  expect(screen.getByRole("button", { name: "查看详情" })).toBeTruthy();
});

it("returns to the previous page after deleting the last row", async () => {
  const api = setup("completed", 21);
  api.listTaskRuns.mockImplementation(async (_id, input) => ({ records: [record], total: 21 }));
  await screen.findByRole("button", { name: "删除" });
  await waitFor(() => expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(api.listTaskRuns).toHaveBeenCalledWith("one", { taskId: "task", page: 1 }));
  api.deleteTaskRun.mockImplementationOnce(async () => {
    api.listTaskRuns.mockImplementation(async (_id, input) => ({ records: input.page === 0 ? [record] : [], total: 20 }));
  });
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除记录" }));
  await screen.findByText("第 1 页 · 共 20 条");
});
it("ignores a poll response that arrives after deletion", async () => {
  let poll: (() => void) | undefined;
  vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => { if (delay === 2000) poll = callback as () => void; return 1 as unknown as ReturnType<typeof window.setInterval>; });
  vi.spyOn(window, "clearInterval").mockImplementation(() => {});
  const api = setup(); await screen.findByRole("button", { name: "删除" });
  let resolve!: (value: { records: typeof record[]; total: number }) => void;
  api.listTaskRuns.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  expect(poll).toBeDefined();
  poll?.();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除记录" }));
  await screen.findByText(/暂无调用历史/);
  resolve({ records: [record], total: 1 });
  await waitFor(() => expect(screen.queryByRole("button", { name: "查看详情" })).toBeNull());
});
