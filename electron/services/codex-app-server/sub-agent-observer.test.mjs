import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubAgentObserver } from "./sub-agent-observer.cjs";

const spawn = (id, parent = "root", extra = {}) => ({ type: "collabAgentToolCall", id: `spawn-${id}`,
  tool: "spawnAgent", senderThreadId: parent, receiverThreadIds: [id], prompt: `task ${id}`, agentsStates: { [id]: { status: "running" } }, ...extra });
const itemEvent = (observer, threadId, item) => observer.observe("item/completed", { threadId, turnId: "turn", item });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const observers = [];
function fixture(implementation = async () => ({})) {
  const request = vi.fn(implementation), changed = vi.fn(), deltaChanged = vi.fn();
  const observer = createSubAgentObserver({ request, changed, deltaChanged }); observers.push(observer);
  return { observer, request, changed, deltaChanged };
}
afterEach(() => { for (const observer of observers.splice(0)) observer.dispose(); vi.useRealTimers(); });

describe("Codex read-only sub-agent observer", () => {
  it("keeps completed 1MiB history silent across polls while retaining refresh, events and discovery", async () => {
    vi.useFakeTimers();
    let status = "completed", descendants = [];
    const thread = () => ({ id: "a", parentThreadId: "root", status: { type: status === "inProgress" ? "active" : "idle" },
      turns: [{ id: "turn", status, items: [{ id: "msg", type: "agentMessage", text: "x".repeat(1024 * 1024) }] }] });
    const { observer, request, changed } = fixture(async (method, params) => method === "thread/list"
      ? { data: [thread(), ...descendants] }
      : { thread: params.threadId === "a" ? thread() : { id: params.threadId, turns: [] } });
    const reads = () => request.mock.calls.filter(([method]) => method === "thread/read").length;
    observer.reset("root"); await settle(); await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toBe(1);
    changed.mockClear(); request.mockClear();
    await vi.advanceTimersByTimeAsync(4500);
    expect(request.mock.calls.filter(([method]) => method === "thread/list")).toHaveLength(2);
    expect(reads()).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(observer.snapshot().members[0].status).toBe("completed");
    await observer.refresh(); await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toBe(1);
    status = "inProgress";
    observer.observe("turn/started", { threadId: "a" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads()).toBe(2);
    expect(observer.snapshot().members[0].status).toBe("running");
    status = "completed";
    observer.observe("turn/completed", { threadId: "a", turn: { status } });
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads()).toBe(3);
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(4500);
    expect(reads()).toBe(3);
    expect(changed).not.toHaveBeenCalled();
    descendants = [{ id: "nested", parentThreadId: "a" }];
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads()).toBe(3);
    expect(observer.snapshot().members.map(member => member.threadId)).toEqual(["a", "nested"]);
    expect(changed).toHaveBeenCalledTimes(1);
    observer.setView(true, "nested"); await settle();
    observer.setView(true, "a"); await settle();
    expect(reads()).toBe(5);
    observer.observe("item/completed", { threadId: "root", item: { type: "subAgentActivity", agentThreadId: "a", kind: "completed" } });
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads()).toBe(6);
  });

  it("does not publish unchanged running history on automatic polls", async () => {
    vi.useFakeTimers();
    const { observer, request, changed } = fixture(async method => method === "thread/list" ? { data: [] }
      : { thread: { id: "a", status: { type: "active" }, turns: [{ id: "turn", status: "inProgress", items: [] }] } });
    observer.reset("root", [spawn("a")]); await settle(); await vi.advanceTimersByTimeAsync(100);
    changed.mockClear(); request.mockClear();
    await vi.advanceTimersByTimeAsync(4500);
    expect(request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(2);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps collapsed 1MiB streams silent and emits only new text when expanded", async () => {
    vi.useFakeTimers();
    const { observer, changed, deltaChanged } = fixture();
    observer.reset("root", [spawn("a")]); await settle();
    const history = "x".repeat(1024 * 1024);
    itemEvent(observer, "a", { id: "msg", type: "agentMessage", text: history });
    observer.setView(false);
    await vi.advanceTimersByTimeAsync(100); changed.mockClear(); deltaChanged.mockClear();
    for (let i = 0; i < 10; i++) {
      observer.observe("item/agentMessage/delta", { threadId: "a", itemId: "msg", delta: "z" });
      await vi.advanceTimersByTimeAsync(90);
    }
    expect(changed).not.toHaveBeenCalled();
    expect(deltaChanged).not.toHaveBeenCalled();
    expect(observer.takeTextDeltas()).toEqual([]);
    observer.setView(true); await settle(); await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(observer.snapshot().members[0].items[0].text).toBe(history + "z".repeat(10));
    changed.mockClear(); deltaChanged.mockClear();
    for (let i = 0; i < 10; i++) {
      observer.observe("item/agentMessage/delta", { threadId: "a", itemId: "msg", delta: "y" });
      await vi.advanceTimersByTimeAsync(90);
    }
    const deltas = observer.takeTextDeltas();
    expect(changed).not.toHaveBeenCalled();
    expect(deltas.map(value => value.delta).join("")).toBe("y".repeat(10));
    expect(JSON.stringify(deltas).length).toBeLessThan(2000);
    observer.setView(false); await vi.advanceTimersByTimeAsync(100); changed.mockClear();
    observer.observe("thread/status/changed", { threadId: "a", status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    await vi.advanceTimersByTimeAsync(90);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(observer.snapshot().members[0].status).toBe("waitingOnApproval");
    observer.observe("turn/completed", { threadId: "a", turn: { status: "completed" } });
    await vi.advanceTimersByTimeAsync(90);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(observer.snapshot().members[0].status).toBe("completed");
  });
  it.each(["completed", "interrupted"])("retains %s across inactive polls and switches to a new running turn", async resultStatus => {
    let threadStatus = { type: "idle" }, turnStatus = resultStatus;
    const thread = () => ({ id: "a", parentThreadId: "root", status: threadStatus,
      turns: [{ id: "turn", status: turnStatus, items: [] }] });
    const { observer } = fixture(async method => method === "thread/list"
      ? { data: [thread()] } : { thread: thread() });
    observer.reset("root"); await settle();
    observer.observe("turn/completed", { threadId: "a", turn: { status: resultStatus } });
    expect(observer.snapshot().members[0].status).toBe(resultStatus);
    for (const type of ["idle", "notLoaded"]) {
      threadStatus = { type };
      for (let i = 0; i < 2; i++) {
        await observer.refresh();
        expect(observer.snapshot().members[0].status).toBe(resultStatus);
      }
    }
    observer.observe("turn/started", { threadId: "a" });
    expect(observer.snapshot().members[0].status).toBe("running");
    turnStatus = "inProgress";
    await observer.refresh();
    expect(observer.snapshot().members[0].status).toBe("running");
  });
  it.each(["completed", "interrupted"])("preserves active thread status over a stale %s turn", async turnStatus => {
    let activeFlags = [];
    const thread = () => ({ id: "a", parentThreadId: "root", status: { type: "active", activeFlags },
      turns: [{ id: "turn", status: turnStatus, items: [] }] });
    const { observer } = fixture(async method => method === "thread/list"
      ? { data: [thread()] } : { thread: thread() });
    observer.reset("root"); await settle();
    for (const status of ["running", "waitingOnApproval", "waitingOnUserInput"]) {
      activeFlags = status === "running" ? [] : [status];
      await observer.refresh();
      expect(observer.snapshot().members[0].status).toBe(status);
    }
  });
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
  it("indexes appended history items and protects only in-progress turns", async () => {
    const turns = [
      { id: "done", status: "completed", items: [
        { id: "final", type: "agentMessage", text: "old" },
        { id: "new", type: "agentMessage", text: "first" },
        { id: "new", type: "agentMessage", text: "updated" }
      ] },
      { id: "active", status: "inProgress", items: [{ id: "live", type: "agentMessage", text: "prefix" }] }
    ];
    let history = [];
    const { observer } = fixture(async (method, params) => method === "thread/read"
      ? { thread: { id: params.threadId, turns: history } } : {});
    observer.reset("root", [spawn("a")]); await settle();
    itemEvent(observer, "a", { id: "live", type: "agentMessage", text: "prefix streamed" });
    itemEvent(observer, "a", { id: "final", type: "agentMessage", text: "old final text" });
    itemEvent(observer, "a", { id: "pending", type: "agentMessage", text: "not persisted" });
    history = turns;
    for (let i = 0; i < 2; i++) {
      await observer.refresh();
      expect(observer.snapshot().members[0].items.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "live", text: "prefix streamed" }, { id: "final", text: "old" },
        { id: "pending", text: "not persisted" }, { id: "new", text: "updated" }
      ]);
    }
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
