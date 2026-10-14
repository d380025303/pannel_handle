// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerDelta, CodexAppServerSnapshot } from "../../vite-env";
import { subscribeGraphicalSession } from "./graphicalSessionSubscription";

describe("graphical session subscription", () => {
  const initial = { threadId: "thread-1", streamId: "stream-1", revision: 1, items: [],
    approvals: [], mode: "default", executionPermission: "askApproval", busy: false,
    error: null, pendingPlan: null } as CodexAppServerSnapshot;
  const gap = { id: "run-1", streamId: "stream-1", threadId: "thread-1", baseRevision: 2,
    revision: 3, items: [], textDeltas: [], turnDiffs: [] } as CodexAppServerDelta;
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  function install(snapshot: ReturnType<typeof vi.fn>) {
    let onDelta: ((value: CodexAppServerDelta) => void) | undefined;
    const offChanged = vi.fn();
    const offDelta = vi.fn(() => { onDelta = undefined; });
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { snapshot,
      onChanged: () => offChanged,
      onDelta: (listener: typeof onDelta) => { onDelta = listener; return offDelta; } } });
    return { emit: (delta = gap) => onDelta?.(delta), offChanged, offDelta };
  }

  it("stops after a failed gap reload and retries only on a new event", async () => {
    const error = new Error("Session not found");
    const snapshot = vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(error);
    const api = install(snapshot);
    const onError = vi.fn();
    const onSnapshot = vi.fn();
    const off = subscribeGraphicalSession("run-1", { onSnapshot, onError });
    try {
      await flush();
      // Bound the pre-fix loop so this regression test fails without hanging.
      onError.mockImplementation(() => { if (onError.mock.calls.length >= 10) off(); });
      api.emit();
      await flush();
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      await flush();
      expect(snapshot).toHaveBeenCalledTimes(2);
      api.emit();
      await flush();
      expect(snapshot).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledTimes(2);
      snapshot.mockResolvedValue({ ...initial, revision: 3 });
      api.emit();
      await flush();
      expect(snapshot).toHaveBeenCalledTimes(4);
      expect(onSnapshot.mock.calls.at(-1)?.[0].revision).toBe(3);
    } finally { off(); }
  });

  it("continues catching up after a successful snapshot below the missed revision", async () => {
    const snapshot = vi.fn().mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, revision: 2 }).mockResolvedValue({ ...initial, revision: 3 });
    const api = install(snapshot);
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const off = subscribeGraphicalSession("run-1", { onSnapshot, onError });
    try {
      await flush();
      api.emit();
      await flush();
      expect(snapshot).toHaveBeenCalledTimes(3);
      expect(onSnapshot.mock.calls.map(([value]) => value.revision)).toEqual([1, 2, 3]);
      expect(onError).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it.each(["resolve", "reject"])("ignores a pending reload that settles with %s after unsubscribe", async outcome => {
    let resolve!: (value: CodexAppServerSnapshot) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<CodexAppServerSnapshot>((res, rej) => { resolve = res; reject = rej; });
    const snapshot = vi.fn().mockResolvedValueOnce(initial).mockReturnValue(pending);
    const api = install(snapshot);
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const off = subscribeGraphicalSession("run-1", { onSnapshot, onError });
    await flush();
    api.emit();
    off();
    if (outcome === "resolve") resolve({ ...initial, revision: 2 });
    else reject(new Error("Session not found"));
    await flush();
    api.emit();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(api.offChanged).toHaveBeenCalledTimes(1);
    expect(api.offDelta).toHaveBeenCalledTimes(1);
  });

  it("applies ordered deltas and reloads after a gap", async () => {
    let changed: ((value: { id: string; snapshot: CodexAppServerSnapshot }) => void) | undefined;
    let onDelta: ((value: CodexAppServerDelta) => void) | undefined;
    const initial = { threadId: "thread-1", streamId: "stream-1", revision: 1, items: [
      { id: "old", type: "reasoning", text: "keep", summary: ["first", "second"] }, { id: "new", type: "agentMessage", text: "" }
    ], approvals: [], mode: "default", executionPermission: "askApproval", busy: true,
    error: null, pendingPlan: null, team: { name: "team", isAutoTeam: false, hasLiveMembers: true, members: [
      { name: "a", status: "running", items: [{ id: "new", type: "agentMessage", text: "A" }] },
      { name: "b", status: "running", items: [{ id: "new", type: "agentMessage", text: "B" }] }] }, subAgents: { expanded: true, selectedThreadId: "child",
      loading: false, error: null, warning: null, members: [{ threadId: "child", parentThreadId: "thread-1", name: "Child", role: "", task: "",
        status: "running", createdAt: 0, loading: false, error: null, items: [{ id: "child-msg", type: "agentMessage", text: "history" }] }] } } as CodexAppServerSnapshot;
    const snapshot = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, revision: 4,
      items: [initial.items[0], { ...initial.items[1], text: "reloaded" }] });
    Object.defineProperty(window, "codexAppServerApi", { configurable: true, value: { snapshot,
      onChanged: (listener: typeof changed) => { changed = listener; return () => { changed = undefined; }; },
      onDelta: (listener: typeof onDelta) => { onDelta = listener; return () => { onDelta = undefined; }; } } });
    const seen: CodexAppServerSnapshot[] = [];
    const off = subscribeGraphicalSession("run-1", { onSnapshot: value => seen.push(value), onError: vi.fn() });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    onDelta?.({ id: "run-1", streamId: "stream-1", threadId: "thread-1", baseRevision: 1,
      revision: 2, items: [], summaryDeltas: [{ itemId: "old", summaryIndex: 0, delta: " appended" }, { itemId: "old", summaryIndex: 1, delta: " chapter" }], textDeltas: [{ itemId: "new", delta: "hello" }, { memberName: "a", itemId: "new", delta: "1" }, { memberName: "b", itemId: "new", delta: "2" }], turnDiffs: [],
      subAgentTextDeltas: [{ threadId: "child", itemId: "child-msg", field: "text", delta: " new" }] });
    expect(seen.at(-1)?.items[0].summary).toEqual(["first appended", "second chapter"]);
    expect(initial.items[0].summary).toEqual(["first", "second"]);
    expect(seen.at(-1)?.subAgents?.members[0].items[0].text).toBe("history new");
    expect(seen.at(-1)?.team?.members.map(member => member.items[0].text)).toEqual(["A1", "B2"]);
    expect(initial.team?.members[0].items[0].text).toBe("A");
    expect(initial.subAgents?.members[0].items[0].text).toBe("history");
    expect(seen.at(-1)?.items.map(item => item.text)).toEqual(["keep", "hello"]);
    onDelta?.({ id: "run-1", streamId: "stream-1", threadId: "thread-1", baseRevision: 3,
      revision: 4, items: [], summaryDeltas: [{ itemId: "old", summaryIndex: 0, delta: "lost" }], textDeltas: [], turnDiffs: [] });
    await vi.waitFor(() => expect(seen.at(-1)?.revision).toBe(4));
    expect(seen.at(-1)?.items[1].text).toBe("reloaded");
    expect(seen.at(-1)?.items[0].summary).toEqual(["first", "second"]);
    changed?.({ id: "run-1", snapshot: { ...initial, revision: 5 } });
    onDelta?.({ id: "run-1", streamId: "stream-1", threadId: "thread-1", baseRevision: 5,
      revision: 6, items: [{ ...initial.items[0], summary: ["final"] }], summaryDeltas: [{ itemId: "old", summaryIndex: 0, delta: "pending" }], turnDiffs: [], textDeltas: [{ memberName: "b", itemId: "new", delta: "3" }] });
    expect(seen.at(-1)?.revision).toBe(6);
    expect(seen.at(-1)?.items[0].summary).toEqual(["final"]);
    expect(seen.at(-1)?.team?.members.map(member => member.items[0].text)).toEqual(["A", "B3"]);
    changed?.({ id: "run-1", snapshot: { ...initial, streamId: "stream-2", revision: 0 } });
    expect(seen.at(-1)?.streamId).toBe("stream-2");
    off();
    expect(onDelta).toBeUndefined();
  });
});
