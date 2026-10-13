import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createMascotNotifications, cleanSummary, MAX_RESULT_NOTIFICATIONS } = require("./mascot-notifications.cjs");

describe("mascot task notifications", () => {
  let manager, sessions, items, turn, readText, graphical, pending;
  beforeEach(() => {
    vi.useFakeTimers();
    sessions = new Map(["a", "b"].map(id => [id, { id, title: `会话 ${id}`, runtimeMode: "app-server" }]));
    items = []; turn = null; readText = vi.fn().mockResolvedValue("");
    pending = {};
    graphical = { snapshot: () => ({ items, provider: "codex", threadId: "thread-1", ...pending }) };
    manager = createMascotNotifications({ terminalManager: { getSession: id => sessions.get(id) },
      graphicalService: graphical, conversationManager: { getTurn: () => turn },
      stateHub: { getText: readText }, onChanged: vi.fn() });
  });
  afterEach(() => { manager.shutdown(); vi.useRealTimers(); });
  const status = (id, value, extra = {}) => manager.handleDesktopEvent("agent:status", { id, status: value, provider: "codex", timestamp: Date.now(), ...extra });
  const settle = () => vi.advanceTimersByTimeAsync(200);
  const head = () => manager.snapshot().notification;
  it.each(["plan", "approval", "question", "elicitation"])("deduplicates long unchanged %s requests without serializing content", kind => {
    const text = "x".repeat(1000000);
    const item = { id: "item", type: kind === "plan" ? "plan" : "commandExecution", text };
    const request = { requestId: 7, method: "approval", params: { itemId: "item", text }, submitting: false };
    const send = () => manager.handleDesktopEvent("codex-app-server:changed", { id: "a", snapshot: {
      threadId: "thread-1", items: [item], ...(kind === "plan" ? { pendingPlan: { itemId: "item" } }
        : { [kind === "approval" ? "approvals" : kind === "question" ? "questions" : "elicitations"]: [{ ...request }] }),
    } });
    send();
    const revision = manager.snapshot().revision;
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (let index = 0; index < 100; index++) send();
      expect(manager.snapshot().revision).toBe(revision);
      expect(stringify.mock.calls.every(([value]) => Array.isArray(value) && value.length === 3)).toBe(true);
    } finally { stringify.mockRestore(); }
    if (kind === "plan") item.text += "changed";
    else request.params = { ...request.params, text: "changed" };
    send();
    expect(manager.snapshot().revision).toBe(revision + 1);
    if (kind === "plan") expect(head().action.text).toBe(item.text);
    else expect(head().action.request.params.text).toBe("changed");
    if (kind === "approval") {
      item.text = "updated command";
      send();
      expect(manager.snapshot().revision).toBe(revision + 2);
      expect(head().action.items[0].text).toBe(item.text);
    } else if (kind !== "plan") {
      request.submitting = true;
      send();
      expect(head().action.request.submitting).toBe(true);
      expect(manager.snapshot().revision).toBe(revision + 2);
    }
  });
  it("reuses full event snapshots without copying long history again", () => {
    const history = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), type: "agentMessage", text: "history" }));
    graphical.snapshot = vi.fn(() => ({ items: [...history], provider: "codex", threadId: "thread-1" }));
    const snapshot = { items: history, provider: "codex", threadId: "thread-1" };
    for (let index = 0; index < 100; index++) manager.handleDesktopEvent("codex-app-server:changed", { id: "a", snapshot });
    expect(graphical.snapshot).not.toHaveBeenCalled();
    expect(manager.snapshot().pendingCount).toBe(0);
  });
  it.each(["approval", "question", "plan"])("adds, updates and removes %s notifications using event snapshots", kind => {
    graphical.snapshot = vi.fn(() => { throw new Error("event must supply snapshot"); });
    const snapshotFor = text => ({ provider: "codex", threadId: "thread-1",
      items: [{ id: "item", type: kind === "plan" ? "plan" : "commandExecution", text }],
      ...(kind === "plan" ? { pendingPlan: { itemId: "item" } }
        : kind === "approval" ? { approvals: [{ requestId: 7, params: { itemId: "item", title: text } }] }
          : { questions: [{ requestId: 8, params: { questions: [{ id: "q", question: text }] } }] }) });
    const send = snapshot => manager.handleDesktopEvent("codex-app-server:changed", { id: "a", snapshot });
    send(snapshotFor("initial"));
    const id = head().id;
    expect(manager.snapshot().pendingCount).toBe(1);
    expect(head().action.kind).toBe(kind);
    send(snapshotFor("updated"));
    expect(manager.snapshot().pendingCount).toBe(1);
    expect(head().id).toBe(id);
    if (kind === "plan") expect(head().action.text).toBe("updated");
    else if (kind === "approval") {
      expect(head().action.request.params.title).toBe("updated");
      expect(head().action.items[0].text).toBe("updated");
    } else expect(head().action.request.params.questions[0].question).toBe("updated");
    send({ provider: "codex", threadId: "thread-1", items: [] });
    expect(head()).toBeNull();
    expect(manager.snapshot().pendingCount).toBe(0);
    send(snapshotFor("new request"));
    expect(head().action.kind).toBe(kind);
    expect(head().id).not.toBe(id);
    expect(graphical.snapshot).not.toHaveBeenCalled();
  });
  it("reads a fresh snapshot when the event does not supply one", () => {
    graphical.snapshot = vi.fn(() => ({ items: [], threadId: "thread-1", questions: [{ requestId: 8, params: { questions: [] } }] }));
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
    expect(graphical.snapshot).toHaveBeenCalledExactlyOnceWith("a");
    expect(head().action.kind).toBe("question");
  });
  it("ignores initial historical completion and non-result statuses", async () => {
    status("a", "completed"); status("b", "failed"); status("a", "e_prompt"); status("a", "exited");
    await settle(); expect(head()).toBeNull();
  });
  it("queues all sessions in arrival order, deduplicates and dismisses one result at a time", async () => {
    status("a", "running"); status("b", "running");
    status("a", "completed", { activitySummary: "完成 a" });
    status("a", "completed", { activitySummary: "最新 a" });
    status("b", "failed", { message: "失败原因 b" });
    await settle();
    expect(manager.snapshot()).toMatchObject({ pendingCount: 2, notification: { sessionId: "a", summary: "最新 a", status: "completed" } });
    manager.dismiss("wrong"); expect(manager.snapshot().pendingCount).toBe(2);
    manager.dismiss(head().id);
    expect(head()).toMatchObject({ sessionId: "b", summary: "失败原因 b", status: "failed" });
  });
  it("counts 60 seconds of visible time, pauses hover/focus and waits for next bubble presentation", async () => {
    status("a", "running"); status("b", "running"); status("a", "completed"); status("b", "completed"); await settle();
    await vi.advanceTimersByTimeAsync(30000); expect(head().sessionId).toBe("a");
    const id = head().id;
    manager.setPresentation(id, false); await vi.advanceTimersByTimeAsync(5000);
    manager.setPresentation(id, true); await vi.advanceTimersByTimeAsync(30000);
    expect(head().id).toBe(id);
    manager.setPresentation(id, false); await vi.advanceTimersByTimeAsync(54999); expect(head().id).toBe(id);
    await vi.advanceTimersByTimeAsync(1); expect(head().sessionId).toBe("b");
    await vi.advanceTimersByTimeAsync(30000); expect(head().sessionId).toBe("b");
    manager.setPresentation(head().id, false); await vi.advanceTimersByTimeAsync(60000); expect(head()).toBeNull();
  });
  it("preserves full Markdown in completed graphical output", async () => {
    status("a", "running");
    const text = "## 结果\n\n- 完成\n\n```js\nconst result = true;\n```\n\n" + "内容".repeat(200);
    items.push({ id: "final", type: "agentMessage", text });
    status("a", "completed");
    await settle(); expect(head().summary).toBe(text);
    expect(cleanSummary("a\r\nb\r\nc\u0000")).toBe("a\nb\nc");
  });
  it("uses new final graphical output rather than previous-turn messages or tool activity", async () => {
    items = [{ id: "old", type: "agentMessage", text: "旧结果" }]; status("a", "running");
    status("a", "completed", { activitySummary: "读取文件" });
    items.push({ id: "new", type: "agentMessage", text: "已修复并通过测试" });
    await settle(); expect(head().summary).toBe("已修复并通过测试");
  });
  it("keeps a result when another turn starts during settling, without borrowing its text", async () => {
    status("a", "running"); status("a", "completed", { activitySummary: "第一轮完成" });
    status("a", "running"); items.push({ id: "next", type: "agentMessage", text: "下一轮内容" });
    await settle(); expect(head().summary).toBe("第一轮完成");
    manager.setPresentation(head().id, false);
    status("a", "failed", { message: "第二轮失败" }); await settle();
    manager.dismiss(head().id); expect(head().summary).toBe("第二轮失败");
  });
  it("does not notify or read output for terminal sessions", async () => {
    sessions.get("a").runtimeMode = "terminal";
    status("a", "running"); status("a", "completed"); status("a", "waiting_for_permission");
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
    await settle(); expect(head()).toBeNull(); expect(readText).not.toHaveBeenCalled();
  });
  it("shows the full pending plan without a completion bubble, deduplicates and clears external handling", async () => {
    status("a", "running");
    const text = "计划内容".repeat(100);
    items.push({ id: "plan", type: "plan", text }); pending.pendingPlan = { itemId: "plan" };
    status("a", "completed", { eventName: "AppServerPlanPending" });
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" }); await settle();
    expect(manager.snapshot().pendingCount).toBe(1);
    expect(head()).toMatchObject({ status: "pending", agentStatus: { eventName: "AppServerPlanPending" }, action: { kind: "plan", text } });
    manager.dismiss(head().id); manager.handleDesktopEvent("codex-app-server:changed", { id: "a" }); expect(head()).toBeNull();
    pending.pendingPlan = null; status("a", "running"); status("a", "completed"); await settle();
    expect(head().status).toBe("completed");
  });
  it("cleans pending requests handled in another window and rejects stale actions", async () => {
    pending.questions = [{ requestId: 42, params: { questions: [] } }];
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" }); const id = head().id;
    pending.questions = [];
    await expect(manager.processAction(id, { type: "answer", answers: {} })).rejects.toThrow("已失效");
    expect(head()).toBeNull();
  });
  it("handles plans, authorization and answers with retries and a per-request submission lock", async () => {
    pending.pendingPlan = { itemId: "plan" };
    graphical.executePlan = vi.fn().mockRejectedValueOnce(new Error("发送失败")).mockImplementationOnce(async () => { pending.pendingPlan = null; });
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" }); const id = head().id;
    await expect(manager.processAction(id, { type: "execute" })).rejects.toThrow("发送失败");
    expect(head().id).toBe(id); await manager.processAction(id, { type: "execute" });
    expect(graphical.executePlan).toHaveBeenCalledWith("a", "plan"); expect(head()).toBeNull();
    pending.approvals = [{ requestId: 7, method: "item/commandExecution/requestApproval", params: { availableDecisions: ["accept"] } }];
    pending.questions = [{ requestId: 8, params: { questions: [] } }];
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
    expect(manager.snapshot().pendingCount).toBe(2);
    await expect(manager.processAction(head().id, { type: "approve", decision: "acceptForSession" })).rejects.toThrow("已失效");
    let finish;
    graphical.resolveApproval = vi.fn(() => new Promise(resolve => { finish = () => { pending.approvals = []; resolve(); }; }));
    const first = manager.processAction(head().id, { type: "approve", decision: "accept" });
    await expect(manager.processAction(head().id, { type: "approve", decision: "accept" })).rejects.toThrow("正在提交");
    finish(); await first; expect(head().action.kind).toBe("question");
    graphical.answerQuestion = vi.fn(async () => { pending.questions = []; });
    await manager.processAction(head().id, { type: "answer", answers: { q: { answers: ["A"] } } });
    expect(graphical.answerQuestion).toHaveBeenCalledWith("a", 8, { q: { answers: ["A"] } }); expect(head()).toBeNull();
  });
  it.each(["codex", undefined])("accepts equivalent boolean and string approvals for provider %s", async provider => {
    pending.provider = provider;
    for (const decision of [true, "accept", false, "decline"]) {
      pending.approvals = [{ requestId: 7, method: "item/commandExecution/requestApproval",
        params: { availableDecisions: ["accept", "decline"], choices: [{ id: "accept" }, { id: "decline" }] } }];
      graphical.resolveApproval = vi.fn(async () => { pending.approvals = []; });
      manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
      await manager.processAction(head().id, { type: "approve", decision });
      expect(graphical.resolveApproval).toHaveBeenCalledWith("a", 7, decision);
      expect(head()).toBeNull();
    }
  });
  it("retains only the latest unseen result across 1,000 paused turns", async () => {
    for (let index = 0; index < 1000; index++) {
      status("a", "running");
      status("a", index % 2 ? "failed" : "completed", { activitySummary: `${index}:` + "x".repeat(10240) });
      await settle();
      manager.setPresentation(head().id, true);
      expect(manager.snapshot().pendingCount).toBe(1);
    }
    expect(head().summary).toBe("999:" + "x".repeat(10240));
    manager.setPresentation(head().id, false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(head()).toBeNull();
  });
  it("bounds results across sessions and keeps authorization and questions actionable", async () => {
    pending.approvals = [{ requestId: 7, params: {} }];
    pending.questions = [{ requestId: 8, params: { questions: [] } }];
    // Other sessions have no pending requests.
    graphical.snapshot = id => ({ items, provider: "codex", threadId: id, ...(id === "a" ? pending : {}) });
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
    for (let index = 0; index < 1000; index++) {
      const id = `session-${index}`;
      sessions.set(id, { id, runtimeMode: "app-server" });
      status(id, "running"); status(id, "completed", { activitySummary: `${index}:` + "x".repeat(10240) });
      expect(manager.snapshot().pendingCount).toBeLessThanOrEqual(MAX_RESULT_NOTIFICATIONS + 2);
    }
    expect(vi.getTimerCount()).toBe(MAX_RESULT_NOTIFICATIONS);
    await settle();
    graphical.resolveApproval = vi.fn(async () => { pending.approvals = []; });
    await manager.processAction(head().id, { type: "approve", decision: "accept" });
    graphical.answerQuestion = vi.fn(async () => { pending.questions = []; });
    await manager.processAction(head().id, { type: "answer", answers: {} });
    const summaries = [];
    while (head()) { summaries.push(head().summary); manager.dismiss(head().id); }
    expect(summaries).toEqual(Array.from({ length: MAX_RESULT_NOTIFICATIONS }, (_, index) => `${1000 - MAX_RESULT_NOTIFICATIONS + index}:` + "x".repeat(10240)));
    expect(summaries.join("").length).toBeLessThan(MAX_RESULT_NOTIFICATIONS * 10250);
  });
  it.each([[true, "decline"], [false, "accept"], ["accept", "decline"], ["decline", "accept"]])(
    "rejects approval %s when only %s is allowed", async (decision, allowed) => {
      pending.approvals = [{ requestId: 7, method: "item/commandExecution/requestApproval",
        params: { availableDecisions: [allowed] } }];
      graphical.resolveApproval = vi.fn();
      manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
      const id = head().id;
      await expect(manager.processAction(id, { type: "approve", decision })).rejects.toThrow("授权选择已失效");
      expect(graphical.resolveApproval).not.toHaveBeenCalled();
      expect(head().id).toBe(id);
    });
  it.each([true, false, "allow-once"])("preserves other providers' approval decision %s", async decision => {
    pending.provider = "codebuddy";
    pending.approvals = [{ requestId: 7, params: { choices: [{ id: decision }] } }];
    graphical.resolveApproval = vi.fn(async () => { pending.approvals = []; });
    manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
    await manager.processAction(head().id, { type: "approve", decision });
    expect(graphical.resolveApproval).toHaveBeenCalledWith("a", 7, decision);
    expect(head()).toBeNull();
  });
  it("clears result and pending notifications when sessions close or clear", async () => {
    status("a", "running"); status("a", "completed"); await settle();
    status("a", "cleared"); expect(head()).toBeNull();
    pending.pendingPlan = { itemId: "plan" }; manager.handleDesktopEvent("codex-app-server:changed", { id: "a" });
    manager.handleDesktopEvent("sessions:changed", [sessions.get("b")]); expect(head()).toBeNull();
  });
  it("preserves remaining time across window recreation and cancels all work on shutdown", async () => {
    status("a", "running"); status("a", "completed"); await settle();
    manager.setPresentation(head().id, false); await vi.advanceTimersByTimeAsync(6000); manager.suspend();
    await vi.advanceTimersByTimeAsync(20000); expect(head()).toBeTruthy();
    manager.setPresentation(head().id, false); await vi.advanceTimersByTimeAsync(54000); expect(head()).toBeNull();
    status("a", "running"); status("a", "failed"); manager.shutdown();
    expect(vi.getTimerCount()).toBe(0); status("b", "running"); status("b", "completed");
    expect(manager.snapshot().pendingCount).toBe(0);
  });
  it("cleans control sequences and limits summary length", () => {
    expect(cleanSummary("\u001b[31m完成\u001b[0m\n\t 摘要")).toBe("完成\n\t 摘要");
    expect(cleanSummary("字".repeat(200))).toHaveLength(200);
  });
});
