import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
const { createWorkItemAutomation, matches, validateRule, expandPrompt } = require("./work-item-automation.cjs");
const leaf = (field, value, operator = "equals") => ({ kind: "condition", field, value, operator });
const rule = (patch = {}) => ({ id: "rule", name: "修复", enabled: true, condition: { kind: "group", operator: "and", children: [leaf("output", "修复", "contains")] }, prompt: "处理 {{output}}", ...patch });
const fixtures = [];
function fixture() {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-automation-"));
  const db = createBusinessDataStore({ userData }).open();
  const sessions = new Map(); let errorListener;
  const close = vi.fn(id => sessions.delete(id)); const notify = vi.fn();
  const graphical = { snapshot: id => sessions.get(id), getInjectedToolState: id => sessions.get(id), onTaskError: callback => { errorListener = callback; return () => {}; } };
  const execute = vi.fn(async (input, rule, progress) => {
    const item = db.getWorkItem(input.id);
    const attempt = db.startWorkItemAttempt(item.id, item.version, { prompt: input.prompt }, {}, rule);
    progress(attempt);
    sessions.set(attempt.id, { id: attempt.id, runtimeMode: "app-server", agentStatus: "running", threadId: "thread", turnId: "turn", busy: true });
    db.updateWorkItemAttempt(item.id, attempt.id, { status: "running", sessionId: attempt.id, threadId: "thread", turnId: "turn" });
    progress(attempt, { sessionId: attempt.id });
  });
  const automation = createWorkItemAutomation({ dataStore: db, workItems: { executeAutomation: execute }, busy: () => false, terminalManager: { getSession: id => sessions.get(id) }, graphicalService: graphical,
    getSessionApi: () => ({ status: () => ({ running: true }) }), broadcast: vi.fn(), notify, closeSession: close });
  function add(sourceRunId = "source", ownerId = "owner") {
    return db.insertWorkItem({ sourceRunId, taskId: "timer", ownerId, templateId: "template", taskName: sourceRunId, output: "修复问题", owner: { name: "负责人" }, template: { title: "项目" }, tools: [] });
  }
  function finish(item, patch = {}) {
    const current = db.getWorkItem(item.id); const id = current.latestAttemptId;
    const state = sessions.get(id);
    Object.assign(state, { agentStatus: "completed", busy: false, completedTurnId: "turn", turnId: null }, patch);
    db.updateWorkItemAttempt(item.id, id, { status: "completed", output: "修复完成", endedAt: Date.now() });
    return id;
  }
  const f = { db, automation, execute, close, notify, add, finish, sessions, error: event => errorListener?.(event), userData };
  fixtures.push(f); return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.automation.shutdown(); f.db.close(); rmSync(f.userData, { recursive: true, force: true }); } });

describe("automation rules", () => {
  it("combines AND and nested OR against full output and expands literal variables", () => {
    const condition = { kind: "group", operator: "and", children: [leaf("templateId", "t"), { kind: "group", operator: "or", children: [leaf("output", "X", "contains"), leaf("output", "Y", "contains")] }] };
    expect(matches(condition, { templateId: "t", output: "long reply Y" })).toBe(true);
    expect(matches(condition, { templateId: "other", output: "Y" })).toBe(false);
    expect(matches(leaf("needsFollowUp", "false"), { needsFollowUp: false })).toBe(true);
    expect(expandPrompt(rule(), { output: "$& {{taskName}}", taskName: "task", owner: { name: "o" }, template: { title: "t" } })).toBe("处理 $& {{taskName}}");
  });
  it("rejects empty groups, excessive nesting and unsupported variables", () => {
    expect(() => validateRule(rule({ condition: { kind: "group", operator: "and", children: [] } }))).toThrow();
    let condition = leaf("output", "X"); for (let i = 0; i < 5; i++) condition = { kind: "group", operator: "and", children: [condition] };
    expect(() => validateRule(rule({ condition }))).toThrow("5 层");
    expect(() => validateRule(rule({ prompt: "{{secret}}" }))).toThrow("变量");
  });
  it("executes historical tasks once, serially, using the first matching rule and persists output before closing", async () => {
    const f = fixture(); const a = f.add("a"); const b = f.add("b", "other");
    f.automation.saveAutomation({ revision: 0, rules: [rule(), rule({ id: "second", prompt: "wrong" })] });
    f.automation.start(); await f.automation.tick();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    expect(f.execute.mock.calls[0][1].id).toBe("rule");
    await f.automation.tick(); expect(f.execute).toHaveBeenCalledTimes(1);
    const id = f.finish(a); await f.automation.tick();
    expect(f.close).toHaveBeenCalledWith(id);
    expect(f.db.getWorkItemAttempt(a.id, id)).toMatchObject({ output: "修复完成", closeResult: "已自动关闭" });
    await f.automation.tick(); expect(f.execute).toHaveBeenCalledTimes(2);
    f.finish(b); await f.automation.tick(); await f.automation.tick(); expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("ignores intermediate errors and closes a successfully completed session", async () => {
    const f = fixture(); const item = f.add(); f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const id = f.db.getWorkItem(item.id).latestAttemptId;
    f.error({ sessionId: id, error: "command exited 1" });
    f.execute.mock.calls[0][2]({ id }, { sessionId: id, error: "temporary", pendingErrors: ["tool error"] });
    await f.automation.tick();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.db.getWorkItemAttempt(item.id, id).hadError).toBeUndefined();
    f.finish(item); await f.automation.tick();
    expect(f.close).toHaveBeenCalledWith(id);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.db.getWorkItemAttempt(item.id, id).automationError).toBeUndefined();
  });
  it("does not treat a transport exception after submission as final failure", async () => {
    const f = fixture(); const item = f.add(); const execute = f.execute.getMockImplementation();
    f.execute.mockImplementation(async (...args) => { await execute(...args); throw new Error("HTTP timeout"); });
    f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    expect(f.notify).not.toHaveBeenCalled();
    const id = f.finish(item);
    await vi.waitFor(async () => { await f.automation.tick(); expect(f.close).toHaveBeenCalledWith(id); });
    expect(f.close).toHaveBeenCalledWith(id); expect(f.notify).not.toHaveBeenCalled();
  });
  it("records and alerts final execution failure once and retains the session", async () => {
    const f = fixture(); const item = f.add(); f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const id = f.db.getWorkItem(item.id).latestAttemptId;
    f.db.updateWorkItemAttempt(item.id, id, { status: "failed", error: "final failure", endedAt: Date.now() });
    await f.automation.tick(); await f.automation.tick();
    expect(f.close).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledOnce();
    expect(f.db.getWorkItemAttempt(item.id, id)).toMatchObject({ hadError: true, automationError: "final failure" });
  });
  it("retains a completed session when execution record persistence fails", async () => {
    const f = fixture(); const item = f.add(); f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const id = f.db.getWorkItem(item.id).latestAttemptId;
    f.execute.mock.calls[0][2]({ id }, { sessionId: id, progressError: "storage unavailable" });
    f.finish(item); await f.automation.tick();
    expect(f.close).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledOnce();
  });
  it.each([{ pendingPlan: {} }, { approvals: [{}] }, { questions: [{}] }, { elicitations: [{}] }, { busy: true }, { agentStatus: "running" }])("does not close a session with unresolved state %j", async patch => {
    const f = fixture(); const item = f.add(); f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.finish(item, patch); await f.automation.tick(); expect(f.close).not.toHaveBeenCalled();
  });
  it("keeps a later turn and reports close failure without failing a successful task", async () => {
    const f = fixture(); const item = f.add(); f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.finish(item, { completedTurnId: "later" }); await f.automation.tick(); expect(f.close).not.toHaveBeenCalled();
    const other = f.add("other", "other"); await f.automation.tick(); f.finish(other);
    f.close.mockImplementation(() => { throw new Error("close error"); }); await f.automation.tick();
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("close error") }));
    expect(f.db.getWorkItem(other.id).status).toBe("completed");
    await f.automation.tick(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("stops on recovered uncertain automation attempts and preserves revision conflicts", async () => {
    const f = fixture(); const item = f.add(); f.automation.saveAutomation({ revision: 0, rules: [rule()] });
    expect(() => f.automation.saveAutomation({ revision: 0, rules: [] })).toThrow("规则已变更");
    const attempt = f.db.startWorkItemAttempt(item.id, item.version, {}, {}, rule()); f.db.recoverWorkItemAttempts();
    f.add("next", "other"); f.automation.start(); await f.automation.tick();
    expect(f.execute).not.toHaveBeenCalled(); expect(f.automation.getAutomation().waiting).toContain("待核对");
    expect(f.db.getWorkItemAttempt(item.id, attempt.id).status).toBe("uncertain");
  });
  it("records and alerts preflight failures once without submitting repeatedly", async () => {
    const f = fixture(); const item = f.add(); f.execute.mockRejectedValue(new Error("来源模板已删除"));
    f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
    await f.automation.tick(); await f.automation.tick();
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.db.getWorkItem(item.id).status).toBe("failed");
  });
  it("does not close when saving the final close decision fails", async () => {
    const f = fixture(); const item = f.add(); f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce()); f.finish(item);
    const original = f.db.patchAutomationAttempt;
    f.db.patchAutomationAttempt = () => { throw new Error("storage unavailable"); };
    await f.automation.tick(); expect(f.close).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledOnce();
    f.db.patchAutomationAttempt = original; await f.automation.tick(); expect(f.close).not.toHaveBeenCalled();
    expect(f.db.getWorkItem(item.id).automation.hadError).toBe(true);
  });
  it("disabling rules removes queued tasks without stopping a running task", async () => {
    const f = fixture(); const item = f.add(); const next = f.add("next", "other");
    f.automation.saveAutomation({ revision: 0, rules: [rule()] }); f.automation.start();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.automation.saveAutomation({ revision: 1, rules: [rule({ enabled: false })] });
    f.finish(item); await f.automation.tick(); await f.automation.tick();
    expect(f.close).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce(); expect(f.db.getWorkItem(next.id).status).toBe("pending");
  });
});
