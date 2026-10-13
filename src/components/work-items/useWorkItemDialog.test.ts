// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkItem, WorkItemApi, WorkItemAttempt } from "../../vite-env";
import { useWorkItemDialog } from "./useWorkItemDialog";

afterEach(cleanup);
const item = (id: string) => ({ id, version: 1, status: "pending", output: `output ${id}` } as WorkItem);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const api = {
    get: vi.fn<WorkItemApi["get"]>(async ({ id }) => item(id)),
    listQuickPrompts: vi.fn(async () => [{ prompt: "persistent", persistent: true }, { prompt: "optional", persistent: false }]),
    preview: vi.fn(async () => ({ body: {}, configuration: {} })),
    listAttempts: vi.fn(async ({ page }: { page?: number }) => ({ records: [{ id: `attempt-${page}` }], total: 21 })),
    getAttempt: vi.fn(async ({ attemptId }: { attemptId: string }) => ({ id: attemptId, output: "attempt output" } as WorkItemAttempt)),
  };
  const hook = renderHook(({ visible, reload }) => useWorkItemDialog(api as unknown as WorkItemApi, visible, reload), { initialProps: { visible: true, reload: 0 } });
  return { ...hook, api };
}
it("ignores an older task response after switching and resets dialog state", async () => {
  const f = setup(); const old = deferred<WorkItem>();
  f.api.get.mockReturnValueOnce(old.promise);
  act(() => f.result.current.open("old", "execute"));
  act(() => f.result.current.open("new", "execute"));
  await waitFor(() => expect(f.result.current.prompt).toBe("output new\n\npersistent"));
  await act(async () => old.resolve(item("old")));
  expect(f.result.current.item?.id).toBe("new");
  expect(f.api.preview).toHaveBeenCalledTimes(1);
  act(() => { f.result.current.setPromptMode("edit"); f.result.current.setReason("reason"); f.result.current.setDialogError("error"); });
  act(() => f.result.current.open("third", "detail"));
  expect(f.result.current.prompt).toBe("");
  expect(f.result.current.promptMode).toBe("preview");
  expect(f.result.current.reason).toBe("");
  expect(f.result.current.dialogError).toBe("");
  expect(f.result.current.preview).toBeNull();
  await waitFor(() => expect(f.result.current.dialogLoading).toBe(false));
});
it("initializes persistent prompts once and preserves edits when preview refreshes", async () => {
  const f = setup();
  act(() => f.result.current.open("task", "execute"));
  await waitFor(() => expect(f.result.current.dialogLoading).toBe(false));
  expect(f.api.preview).toHaveBeenLastCalledWith({ id: "task", version: 1, prompt: "output task\n\npersistent" });
  act(() => f.result.current.setPrompt("edited"));
  f.rerender({ visible: true, reload: 1 });
  await waitFor(() => expect(f.api.preview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(f.result.current.dialogLoading).toBe(false));
  expect(f.result.current.prompt).toBe("edited");
  expect(f.api.listQuickPrompts).toHaveBeenCalledTimes(1);
});
it("loads execution pages and selected attempt details and discards stale details", async () => {
  const f = setup();
  act(() => f.result.current.open("task", "attempts"));
  await waitFor(() => expect(f.result.current.attempts?.total).toBe(21));
  act(() => f.result.current.setAttemptPage(1));
  await waitFor(() => expect(f.api.listAttempts).toHaveBeenLastCalledWith({ id: "task", page: 1 }));
  await waitFor(() => expect(f.result.current.dialogLoading).toBe(false));
  const old = deferred<WorkItemAttempt>(); f.api.getAttempt.mockReturnValueOnce(old.promise);
  act(() => f.result.current.setSelectedAttemptId("old"));
  await waitFor(() => expect(f.api.getAttempt).toHaveBeenCalledWith({ id: "task", attemptId: "old" }));
  act(() => f.result.current.setSelectedAttemptId("attempt-1"));
  await waitFor(() => expect(f.result.current.attempt?.output).toBe("attempt output"));
  await act(async () => old.resolve({ id: "old", output: "stale" } as WorkItemAttempt));
  expect(f.result.current.attempt?.id).toBe("attempt-1");
});
it.each(["close", "hide"])("ignores pending preview responses on %s", async mode => {
  const f = setup(); const pending = deferred<Awaited<ReturnType<typeof f.api.preview>>>();
  f.api.preview.mockReturnValueOnce(pending.promise);
  act(() => f.result.current.open("task", "execute"));
  await waitFor(() => expect(f.api.preview).toHaveBeenCalledTimes(1));
  if (mode === "close") act(() => f.result.current.setDialog(null));
  else f.rerender({ visible: false, reload: 0 });
  await act(async () => pending.resolve({ body: {}, configuration: {} }));
  expect(f.result.current.preview).toBeNull();
  expect(f.result.current.prompt).toBe("");
});
it("ignores errors from a closed dialog", async () => {
  const f = setup(); const pending = deferred<WorkItem>();
  f.api.get.mockReturnValueOnce(pending.promise);
  act(() => f.result.current.open("task", "detail"));
  act(() => f.result.current.setDialog(null));
  await act(async () => pending.reject(new Error("late error")));
  expect(f.result.current.item).toBeNull();
  expect(f.result.current.dialogError).toBe("");
});
