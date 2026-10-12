import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubAgentObserver } from "./sub-agent-observer.cjs";

const spawn = (id, parent = "root", extra = {}) => ({ type: "collabAgentToolCall", id: `spawn-${id}`,
  tool: "spawnAgent", senderThreadId: parent, receiverThreadIds: [id], prompt: `task ${id}`, agentsStates: { [id]: { status: "running" } }, ...extra });
const itemEvent = (observer, threadId, item) => observer.observe("item/completed", { threadId, turnId: "turn", item });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const observers = [];
function fixture(implementation = async () => ({})) {
  const request = vi.fn(implementation), changed = vi.fn();
  const observer = createSubAgentObserver({ request, changed }); observers.push(observer);
  return { observer, request, changed };
}
afterEach(() => { for (const observer of observers.splice(0)) observer.dispose(); vi.useRealTimers(); });

describe("Codex read-only sub-agent observer", () => {
  it("discovers activity-only members, preserves interaction status and restores nested history", async () => {
    const activity = (id, kind = "started") => ({ id: `${id}:${kind}`, type: "subAgentActivity", agentThreadId: id, agentPath: `/root/${id}`, kind });
    const { observer } = fixture();
    observer.reset("root", [activity("a"), activity("b"), activity("c")]); await settle();
    itemEvent(observer, "root", activity("a"));
    itemEvent(observer, "a", activity("nested"));
    itemEvent(observer, "root", activity("b", "completed"));
    itemEvent(observer, "root", activity("b", "interacted"));
    itemEvent(observer, "root", activity("c", "interrupted"));
    expect(observer.snapshot().members).toHaveLength(4);
    expect(observer.snapshot().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "a", name: "/root/a", status: "running" }),
      expect.objectContaining({ threadId: "b", status: "completed" }),
      expect.objectContaining({ threadId: "c", status: "interrupted" }),
      expect.objectContaining({ threadId: "nested", parentThreadId: "a" })
    ]));
    observer.reset("other"); await settle();
    expect(observer.snapshot().members).toEqual([]);
    expect(itemEvent(observer, "a", activity("foreign"))).toBe(false);
  });
  it("discovers paginated nested descendants, rejects unrelated records and reads selected history without resuming", async () => {
    const { observer, request } = fixture(async (method, params) => method === "thread/list" ? params.cursor
      ? { data: [{ id: "child", parentThreadId: "root", agentNickname: "Scout", createdAt: 1 }], nextCursor: null }
      : { data: [{ id: "nested", parentThreadId: "child", createdAt: 2 }, { id: "foreign", parentThreadId: "other" }], nextCursor: "page2" }
      : { thread: { id: params.threadId, parentThreadId: "root", status: { type: "active", activeFlags: ["waitingOnApproval"] },
        turns: [{ id: "t", items: [{ id: "reply", type: "agentMessage", text: "hello" }] }] } });
    observer.reset("root"); await settle();
    expect(observer.snapshot()).toMatchObject({ expanded: true, selectedThreadId: "child", members: [
      { threadId: "child", name: "Scout", status: "waitingOnApproval", items: [{ text: "hello" }] }, { threadId: "nested", parentThreadId: "child" }
    ] });
    expect(request.mock.calls.every(([method]) => ["thread/list", "thread/read"].includes(method))).toBe(true);
    expect(() => observer.setView(true, "foreign")).toThrow("不属于");
  });
  it("supports both collab formats and isolates live child items and deltas", async () => {
    const { observer } = fixture(); observer.reset("root"); await settle();
    itemEvent(observer, "root", spawn("a"));
    itemEvent(observer, "a", spawn("b", "a"));
    itemEvent(observer, "root", { type: "collabToolCall", tool: "spawn_agent", newThreadId: "legacy", prompt: "old" });
    itemEvent(observer, "a", { id: "msg", type: "agentMessage", text: "start" });
    observer.observe("item/agentMessage/delta", { threadId: "a", itemId: "msg", delta: " end" });
    observer.observe("turn/completed", { threadId: "a", turn: { status: "completed" } });
    expect(observer.observe("item/agentMessage/delta", { threadId: "foreign", itemId: "msg", delta: "bad" })).toBe(false);
    expect(observer.snapshot().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "a", task: "task a", status: "completed", items: expect.arrayContaining([expect.objectContaining({ text: "start end" })]) }),
      expect.objectContaining({ threadId: "b", parentThreadId: "a" }), expect.objectContaining({ threadId: "legacy", task: "old" })
    ]));
  });
  it("preserves streamed prefixes until persisted in-progress history catches up", async () => {
    const { observer } = fixture(async (method, params) => method === "thread/read"
      ? { thread: { id: params.threadId, turns: [{ id: "turn", status: "inProgress", items: [{ id: "msg", type: "agentMessage", text: "prefix" }] }] } } : {});
    observer.reset("root", [spawn("a")]); await settle();
    itemEvent(observer, "a", { id: "msg", type: "agentMessage", text: "prefix streamed suffix" });
    await observer.refresh();
    expect(observer.snapshot().members[0].items.find(item => item.id === "msg").text).toBe("prefix streamed suffix");
    observer.setView(false);
    itemEvent(observer, "root", spawn("b"));
    expect(observer.snapshot().expanded).toBe(false);
  });
  it("retains streamed command output across incomplete history polls and accepts final output", async () => {
    let status = "inProgress", aggregatedOutput = "prefix";
    const { observer } = fixture(async (method, params) => method === "thread/read"
      ? { thread: { id: params.threadId, turns: [{ id: "turn", status, items: [
        { id: "cmd", type: "commandExecution", status, aggregatedOutput }
      ] }] } } : {});
    observer.reset("root", [spawn("a")]); await settle();
    const output = () => observer.snapshot().members[0].items.find(item => item.id === "cmd").output;
    const delta = value => observer.observe("item/commandExecution/outputDelta", { threadId: "a", itemId: "cmd", delta: value });
    delta(" streamed suffix");
    expect(output()).toBe("prefix streamed suffix");
    await observer.refresh();
    expect(output()).toBe("prefix streamed suffix");
    delta(" next");
    expect(output()).toBe("prefix streamed suffix next");
    await observer.refresh();
    expect(output()).toBe("prefix streamed suffix next");
    aggregatedOutput = "replacement";
    await observer.refresh();
    expect(output()).toBe("replacement");
    aggregatedOutput = "replacement caught up";
    await observer.refresh();
    expect(output()).toBe("replacement caught up");
    delta(" pending");
    status = "completed"; aggregatedOutput = "replacement";
    await observer.refresh();
    expect(output()).toBe("replacement");
  });
  it("falls back on unsupported lists, retains history on read errors and retries", async () => {
    let fail = false;
    const { observer } = fixture(async (method, params) => {
      if (method === "thread/list") throw new Error("ancestorThreadId unsupported");
      if (fail) throw new Error("read failed");
      return { thread: { id: params.threadId, turns: [{ items: [{ id: "msg", type: "agentMessage", text: "cached" }] }] } };
    });
    observer.reset("root", [spawn("a")]); await settle();
    expect(observer.snapshot().warning).toContain("不完整");
    fail = true; await observer.refresh();
    expect(observer.snapshot().members[0]).toMatchObject({ error: "read failed", items: [{ text: "cached" }] });
    fail = false; await observer.refresh(); expect(observer.snapshot().members[0].error).toBeNull();
  });
  it("polls only while expanded, refreshes immediately on selection and cleans up", async () => {
    vi.useFakeTimers();
    const { observer, request } = fixture(async (method, params) => method === "thread/read" ? { thread: { id: params.threadId, turns: [] } } : {});
    observer.reset("root", [spawn("a"), spawn("b")]); await settle();
    request.mockClear(); await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledWith("thread/read", { threadId: "a", includeTurns: true });
    observer.setView(false); request.mockClear(); await vi.advanceTimersByTimeAsync(6000); expect(request).not.toHaveBeenCalled();
    observer.setView(true, "b"); await settle(); expect(request).toHaveBeenCalledWith("thread/read", { threadId: "b", includeTurns: true });
    observer.dispose(); request.mockClear(); await vi.advanceTimersByTimeAsync(6000); expect(request).not.toHaveBeenCalled();
  });
  it("limits outstanding child reads to two even across rapid root switches", async () => {
    const pending = new Map();
    const { observer, request } = fixture(async (method, params) => method === "thread/read"
      ? new Promise(resolve => pending.set(params.threadId, resolve)) : {});
    observer.reset("root1", [spawn("a")]); await settle();
    observer.reset("root2", [spawn("b")]); await settle();
    observer.reset("root3", [spawn("c")]); await settle();
    expect(request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(2);
    pending.get("a")({ thread: { id: "a", turns: [] } }); await settle();
    expect(pending.has("c")).toBe(true);
    pending.get("b")({ thread: { id: "b", turns: [] } });
    pending.get("c")({ thread: { id: "c", turns: [] } }); await settle();
    expect(observer.snapshot().members.map(member => member.threadId)).toEqual(["c"]);
  });
  it("discards responses from prior roots and keeps newer streamed output over stale history", async () => {
    let resolveRead;
    const { observer } = fixture(async (method, params) => method === "thread/read"
      ? new Promise(resolve => { resolveRead = resolve; }) : {});
    observer.reset("root", [spawn("a")]); await settle();
    itemEvent(observer, "a", { id: "msg", type: "agentMessage", text: "newer" });
    resolveRead({ thread: { id: "a", turns: [{ items: [{ id: "msg", type: "agentMessage", text: "older" }] }] } }); await settle();
    expect(observer.snapshot().members[0].items[0].text).toBe("newer");
    const promise = observer.refresh(); await settle(); observer.reset("next");
    resolveRead({ thread: { id: "a", turns: [{ items: [{ id: "msg", type: "agentMessage", text: "late" }] }] } }); await promise; await settle();
    expect(observer.snapshot().members).toEqual([]);
  });
});
