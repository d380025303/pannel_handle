// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodeBuddyScheduledTasksDialog } from "./CodeBuddyScheduledTasksDialog";
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(rows: unknown[] = []) {
  const api = { listScheduledTasks: vi.fn().mockResolvedValue(rows), createScheduledTask: vi.fn().mockResolvedValue(undefined), deleteScheduledTask: vi.fn().mockResolvedValue(undefined) };
  Object.assign(window, { codexAppServerApi: api });
  return api;
}
it("creates a one-time durable task and confirms deletion", async () => {
  const api = setup([{ id: "one", prompt: "Check", cron: "* * * * *", recurring: true, durable: false, enabled: true }]);
  render(<CodeBuddyScheduledTasksDialog sessionId="run" threadId="thread" onClose={vi.fn()} />);
  await screen.findByText("Check");
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "Build" } });
  fireEvent.click(screen.getByLabelText("重复执行")); fireEvent.click(screen.getByLabelText("重启后保留"));
  fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
  await waitFor(() => expect(api.createScheduledTask).toHaveBeenCalledWith("run", "thread", { prompt: "Build", cron: "*/5 * * * *", recurring: false, durable: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "删除任务 Check" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "删除任务 Check" }));
  expect(api.deleteScheduledTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(api.deleteScheduledTask).toHaveBeenCalledWith("run", "thread", "one"));
});
it("preserves failed input and does not label failed loading as empty", async () => {
  const api = setup();
  render(<CodeBuddyScheduledTasksDialog sessionId="run" threadId="thread" onClose={vi.fn()} />);
  await screen.findByText("当前对话没有定时任务。");
  api.createScheduledTask.mockRejectedValue(new Error("调度被禁用"));
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
  await screen.findByText("调度被禁用");
  expect(screen.getByLabelText("任务内容")).toHaveProperty("value", "Keep me");
  api.listScheduledTasks.mockRejectedValue(new Error("HTTP 404"));
  fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
  await screen.findByText("HTTP 404");
  expect(screen.queryByText("当前对话没有定时任务。")).toBeNull();
});
it("ignores old responses after switching conversations and clears the draft", async () => {
  const api = setup(); let resolve!: (value: unknown[]) => void;
  api.listScheduledTasks.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<CodeBuddyScheduledTasksDialog sessionId="run" threadId="old" onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "Old draft" } });
  view.rerender(<CodeBuddyScheduledTasksDialog sessionId="run" threadId="new" onClose={vi.fn()} />);
  await screen.findByText("当前对话没有定时任务。");
  resolve([{ id: "old", prompt: "Old result", cron: "* * * * *" }]);
  await waitFor(() => expect(screen.queryByText("Old result")).toBeNull());
  expect(screen.getByLabelText("任务内容")).toHaveProperty("value", "");
  expect(api.listScheduledTasks).toHaveBeenLastCalledWith("run", "new");
});
it("polls only while mounted", async () => {
  vi.useFakeTimers();
  const api = setup();
  const view = render(<CodeBuddyScheduledTasksDialog sessionId="run" threadId="thread" onClose={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(api.listScheduledTasks).toHaveBeenCalledTimes(2);
  view.unmount(); await vi.advanceTimersByTimeAsync(20000);
  expect(api.listScheduledTasks).toHaveBeenCalledTimes(2);
});
