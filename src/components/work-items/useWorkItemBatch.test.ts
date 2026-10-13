// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkItem, WorkItemApi } from "../../vite-env";
import { batchSkip, useWorkItemBatch } from "./useWorkItemBatch";

afterEach(cleanup);
const item = (id: string, status: WorkItem["status"] = "pending") => ({ id, taskName: id, status, version: 3, needsFollowUp: true }) as WorkItem;
function setup(values: WorkItem[]) {
  const api = { get: vi.fn(async ({ id }: { id: string }) => values.find(value => value.id === id)!), markCompleted: vi.fn(async () => values[0]), void: vi.fn(async () => values[0]), restore: vi.fn(async () => values[0]), setFollowUp: vi.fn(async () => values[0]) };
  const refresh = vi.fn();
  const hook = renderHook(() => useWorkItemBatch(api as unknown as WorkItemApi, refresh));
  act(() => hook.result.current.toggle(values, true));
  return { ...hook, api, refresh };
}
it("selects across pages, deselects only supplied records and clears", () => {
  const f = setup([item("a")]);
  act(() => f.result.current.toggle([item("b")], true));
  expect([...f.result.current.selected.keys()]).toEqual(["a", "b"]);
  act(() => f.result.current.toggle([item("b")], false));
  expect([...f.result.current.selected.keys()]).toEqual(["a"]);
  act(() => f.result.current.clear());
  expect(f.result.current.selected.size).toBe(0);
});
it("uses fresh versions, continues after conflict, skips invalid states and retains unsuccessful selections", async () => {
  const f = setup([item("a"), item("b", "running"), item("c")]);
  f.api.markCompleted.mockRejectedValueOnce(new Error("版本冲突"));
  await act(() => f.result.current.open("markCompleted"));
  expect(f.result.current.entries.map(value => value.state)).toEqual(["ready", "skipped", "ready"]);
  await act(async () => { await Promise.all([f.result.current.submit(), f.result.current.submit()]); });
  expect(f.api.markCompleted.mock.calls).toEqual([[{ id: "a", version: 3 }], [{ id: "c", version: 3 }]]);
  expect(f.result.current.entries.map(value => value.state)).toEqual(["failed", "skipped", "success"]);
  expect([...f.result.current.selected.keys()]).toEqual(["a", "b"]);
  expect(f.refresh).toHaveBeenCalledTimes(1);
});
it("reports lookup failures and applies a shared void reason", async () => {
  const f = setup([item("a"), item("b")]);
  f.api.get.mockRejectedValueOnce(new Error("任务不存在"));
  await act(() => f.result.current.open("void"));
  act(() => f.result.current.setReason("无需处理"));
  await act(() => f.result.current.submit());
  expect(f.api.void).toHaveBeenCalledExactlyOnceWith({ id: "b", version: 3, reason: "无需处理" });
  expect(f.result.current.entries[0].reason).toContain("任务不存在");
});
it("skips unchanged follow-up flags and preserves status restrictions", async () => {
  expect(batchSkip(item("a", "void"), "restore")).toBe("");
  expect(batchSkip(item("a", "uncertain"), "void")).not.toBe("");
  const f = setup([item("a"), { ...item("b", "running"), needsFollowUp: false }]);
  await act(() => f.result.current.open("followUp"));
  await act(() => f.result.current.submit());
  expect(f.api.setFollowUp).toHaveBeenCalledExactlyOnceWith({ id: "b", version: 3, needsFollowUp: true });
  expect(f.result.current.entries[0].state).toBe("skipped");
});
it("locks selection and closing during a pending mutation", async () => {
  const f = setup([item("a")]);
  await act(() => f.result.current.open("restore"));
  act(() => f.result.current.close());
  await act(() => f.result.current.open("void"));
  let finish!: (value: WorkItem) => void;
  f.api.void.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = f.result.current.submit(); });
  act(() => { f.result.current.clear(); f.result.current.close(); });
  expect(f.result.current.operation).toBe("void");
  expect(f.result.current.selected.size).toBe(1);
  await act(async () => { finish(item("a")); await pending; });
  expect(f.result.current.done).toBe(true);
});
