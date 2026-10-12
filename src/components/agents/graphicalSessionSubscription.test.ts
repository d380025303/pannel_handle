// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerDelta, CodexAppServerSnapshot } from "../../vite-env";
import { subscribeGraphicalSession } from "./graphicalSessionSubscription";

describe("graphical session subscription", () => {
  it("applies ordered deltas and reloads after a gap", async () => {
    let changed: ((value: { id: string; snapshot: CodexAppServerSnapshot }) => void) | undefined;
    let onDelta: ((value: CodexAppServerDelta) => void) | undefined;
    const initial = { threadId: "thread-1", streamId: "stream-1", revision: 1, items: [
      { id: "old", type: "agentMessage", text: "keep" }, { id: "new", type: "agentMessage", text: "" }
    ], approvals: [], mode: "default", executionPermission: "askApproval", busy: true,
    error: null, pendingPlan: null, subAgents: { expanded: true, selectedThreadId: "child",
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
      revision: 2, items: [], textDeltas: [{ itemId: "new", delta: "hello" }], turnDiffs: [],
      subAgentTextDeltas: [{ threadId: "child", itemId: "child-msg", field: "text", delta: " new" }] });
    expect(seen.at(-1)?.subAgents?.members[0].items[0].text).toBe("history new");
    expect(initial.subAgents?.members[0].items[0].text).toBe("history");
    expect(seen.at(-1)?.items.map(item => item.text)).toEqual(["keep", "hello"]);
    onDelta?.({ id: "run-1", streamId: "stream-1", threadId: "thread-1", baseRevision: 3,
      revision: 4, items: [], textDeltas: [], turnDiffs: [] });
    await vi.waitFor(() => expect(seen.at(-1)?.revision).toBe(4));
    expect(seen.at(-1)?.items[1].text).toBe("reloaded");
    changed?.({ id: "run-1", snapshot: { ...initial, streamId: "stream-2", revision: 0 } });
    expect(seen.at(-1)?.streamId).toBe("stream-2");
    off();
    expect(onDelta).toBeUndefined();
  });
});
