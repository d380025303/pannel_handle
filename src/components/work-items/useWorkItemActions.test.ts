// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkItem, WorkItemApi } from "../../vite-env";
import { useWorkItemActions } from "./useWorkItemActions";

afterEach(cleanup);
function setup() {
  const item = { id: "task", version: 2, needsFollowUp: true } as WorkItem;
  const api = { execute: vi.fn<WorkItemApi["execute"]>(async () => ({ ...item, sessionId: "new" })), setFollowUp: vi.fn(async () => ({ ...item, version: 3, needsFollowUp: false })) };
  const options = { api: api as unknown as WorkItemApi, item, dialog: { id: item.id }, prompt: "执行", reason: "", setItem: vi.fn(), setError: vi.fn(), setDialogError: vi.fn(), refresh: vi.fn(), onSuccess: vi.fn() };
  const hook = renderHook(() => useWorkItemActions(options));
  return { ...hook, api, options, item };
}
it("shares a synchronous lock across execution and follow-up and passes the created session to the success callback", async () => {
  const f = setup();
  let finish!: (item: WorkItem) => void;
  f.api.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => {
    pending = f.result.current.perform("execute");
    void f.result.current.perform("execute");
    void f.result.current.toggleFollowUp(f.item);
  });
  expect(f.result.current.busy).toBe(true);
  expect(f.api.execute).toHaveBeenCalledExactlyOnceWith({ id: "task", version: 2, prompt: "执行" });
  expect(f.api.setFollowUp).not.toHaveBeenCalled();
  const created = { ...f.item, sessionId: "new" };
  await act(async () => { finish(created); await pending; });
  expect(f.options.onSuccess).toHaveBeenCalledExactlyOnceWith(created, "execute");
  expect(f.options.refresh).toHaveBeenCalledTimes(1);
  expect(f.result.current.busy).toBe(false);
});
it("reports a version conflict, refreshes and releases the lock for retry", async () => {
  const f = setup();
  f.api.execute.mockRejectedValueOnce(new Error("任务已变更，请刷新后重试。"));
  await act(() => f.result.current.perform("execute"));
  expect(f.options.setDialogError).toHaveBeenLastCalledWith("Error: 任务已变更，请刷新后重试。");
  expect(f.options.onSuccess).not.toHaveBeenCalled();
  expect(f.options.refresh).toHaveBeenCalledTimes(1);
  expect(f.result.current.busy).toBe(false);
  await act(() => f.result.current.perform("execute"));
  expect(f.api.execute).toHaveBeenCalledTimes(2);
  expect(f.options.onSuccess).toHaveBeenCalledTimes(1);
});
it("releases the follow-up lock after failure and updates the open item and list after retry", async () => {
  const f = setup();
  f.api.setFollowUp.mockRejectedValueOnce(new Error("版本冲突"));
  await act(() => f.result.current.toggleFollowUp(f.item));
  expect(f.options.setDialogError).toHaveBeenLastCalledWith("Error: 版本冲突");
  expect(f.options.refresh).not.toHaveBeenCalled();
  await act(() => f.result.current.toggleFollowUp(f.item));
  expect(f.api.setFollowUp).toHaveBeenLastCalledWith({ id: "task", version: 2, needsFollowUp: false });
  expect(f.options.setItem).toHaveBeenCalledWith({ ...f.item, version: 3, needsFollowUp: false });
  expect(f.options.refresh).toHaveBeenCalledTimes(1);
  expect(f.result.current.busy).toBe(false);
});
