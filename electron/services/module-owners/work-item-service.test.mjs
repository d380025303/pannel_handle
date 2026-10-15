import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createModuleOwnerService } = require("./module-owner-service.cjs");
const { createSessionApiService } = require("../session-api/session-api-service.cjs");
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
const { createWorkItemService } = require("./work-item-service.cjs");
const fixtures = [];
async function fixture() {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-work-items-"));
  const db = createBusinessDataStore({ userData }).open();
  const templates = [{ id: "template", title: "工程", cwd: "C:\\repo", type: "windows", agentProvider: "codex", codexAppServerModel: "model", secret: "private" }];
  const sessions = new Map(); let listener; let api; let sequence = 0;
  const terminal = { getSession: id => sessions.get(id) };
  const graphical = { snapshot: id => sessions.get(id), getInjectedToolState: id => sessions.get(id),
    isInjectedToolCallCurrent: (id, input) => sessions.get(id)?.busy && sessions.get(id)?.turnId === input.turnId,
    onTaskTurnEnded: callback => { listener = callback; return () => { listener = undefined; }; } };
  const broadcast = vi.fn();
  const service = createModuleOwnerService({ userData, dataStore: db, broadcast, sessionStore: { getTemplate: id => templates.find(value => value.id === id), getLibrary: () => templates },
    terminalManager: terminal, graphicalService: graphical, getSessionApi: () => api });
  const instances = { listTemplates: () => ({ templates: [] }), create: vi.fn(async (body, hooks) => {
    const id = `session-${++sequence}`;
    sessions.set(id, { threadId: `thread-${sequence}`, turnId: null, busy: false, authorized: true });
    hooks.onSessionCreated({ id });
    Object.assign(sessions.get(id), { turnId: `turn-${sequence}`, busy: true });
    hooks.onTaskSubmitted({ id });
    return { sessionId: id, status: "started" };
  }) };
  api = createSessionApiService({ userData, instances, moduleOwners: service, defaultPort: 0 });
  await api.configure({ enabled: true });
  const owner = service.mutate("template", { operation: "add", name: "模块", responsibilities: "职责", directories: ["src"] }).records[0];
  const task = service.saveTask("template", { ownerId: owner.id, name: "巡检", prompt: "检查", tools: [], mode: "plan", enabled: false, recordHistory: false, schedule: { kind: "interval", minutes: 1, count: 10 } })[0];
  function end(id, output = "修复模块的问题", status = "completed", overrides = {}) {
    const state = sessions.get(id);
    listener({ sessionId: id, threadId: state.threadId, turnId: state.turnId, output, status, ...overrides });
    state.busy = false;
  }
  async function source(output = "修复模块的问题", status = "completed", patch = {}) {
    const result = await service.generate("template", { mode: "plan", prompt: "检查" }, { ...task, ...patch });
    end(result.result.body.sessionId, output, status);
    return service.workItems.list().records[0];
  }
  const f = { broadcast, userData, db, service, api, instances, templates, sessions, graphical, owner, task, end, source, work: service.workItems };
  fixtures.push(f); return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { f.service.shutdown(); await f.api.stop(); f.db.close(); rmSync(f.userData, { recursive: true, force: true }); }
});
describe("scheduled replies and manual work items through HTTP", () => {
  it.each(["failed", "stopped", "completed"])("persists unsuccessful final automation turns as failed (%s)", async status => {
    const f = await fixture(); const item = await f.source(); const progress = vi.fn();
    const running = await f.work.executeAutomation({ id: item.id, version: item.version }, { id: "rule", name: "rule" }, progress);
    f.end(running.sessionId, "", status, { error: "final failure" });
    expect(f.work.get({ id: item.id }).status).toBe("failed");
    expect(f.db.getWorkItemAttempt(item.id, running.latestAttemptId)).toMatchObject({ status: "failed", error: "final failure" });
    expect(f.sessions.has(running.sessionId)).toBe(true);
  });
  it("does not persist recoverable snapshot errors for automated execution", async () => {
    const f = await fixture(); const item = await f.source(); const progress = vi.fn();
    const running = await f.work.executeAutomation({ id: item.id, version: item.version }, { id: "rule", name: "rule" }, progress);
    f.sessions.get(running.sessionId).error = "temporary tool error";
    await f.service.tickTasks();
    expect(progress.mock.calls.some(([, job]) => job?.progressError)).toBe(false);
    delete f.sessions.get(running.sessionId).error;
    f.end(running.sessionId, "recovered successfully");
    expect(f.db.getWorkItemAttempt(item.id, running.latestAttemptId)).toMatchObject({ status: "completed", error: "", output: "recovered successfully" });
  });
  it("creates results for legacy tasks without the new field", async () => {
    const f = await fixture();
    const legacy = { ...f.task }; delete legacy.autoCreateWorkItem;
    const result = await f.service.generate("template", { mode: legacy.mode, prompt: legacy.prompt }, legacy);
    f.end(result.result.body.sessionId, "兼容回复");
    expect(f.work.list().total).toBe(1);
  });
  it.each([false, true])("keeps history independent when automatic task creation is disabled (history=%s)", async recordHistory => {
    const f = await fixture();
    await f.source("仅巡检回复", "completed", { autoCreateWorkItem: false, recordHistory });
    expect(f.work.list().total).toBe(0);
    expect(f.service.listTasks("template")[0].lastRun.status).toBe("completed");
    const history = f.db.listTaskRuns("template", f.task.id);
    expect(history.total).toBe(recordHistory ? 1 : 0);
    if (recordHistory) expect(f.db.getTaskRun("template", f.task.id, history.records[0].id)).toMatchObject({ output: "仅巡检回复", status: "completed" });
  });
  it.each([false, true])("uses the launch snapshot when automatic creation changes during a run (initial=%s)", async initial => {
    const f = await fixture();
    const task = f.service.saveTask("template", { ownerId: f.task.ownerId, id: f.task.id, name: f.task.name, prompt: f.task.prompt,
      mode: f.task.mode, enabled: false, tools: f.task.tools, schedule: f.task.schedule, autoCreateWorkItem: initial })[0];
    const result = await f.service.generate("template", { mode: task.mode, prompt: task.prompt }, task);
    f.service.saveTask("template", { ownerId: task.ownerId, id: task.id, name: task.name, prompt: task.prompt, mode: task.mode,
      enabled: false, tools: task.tools, schedule: task.schedule, autoCreateWorkItem: !initial });
    f.end(result.result.body.sessionId, "本轮结果");
    expect(f.work.list().total).toBe(initial ? 1 : 0);
    await f.source("下一轮结果", "completed", f.service.listTasks("template")[0]);
    expect(f.work.list().total).toBe(1);
  });
  it("validates follow-up values and allows marking unavailable tasks", async () => {
    const f = await fixture(); const item = await f.source();
    expect(item.needsFollowUp).toBe(true);
    expect(() => f.work.setFollowUp({ id: item.id, version: item.version, needsFollowUp: "false" })).toThrow();
    expect(() => f.work.list({ needsFollowUp: "false" })).toThrow();
    f.templates.length = 0;
    const updated = f.work.setFollowUp({ id: item.id, version: item.version, needsFollowUp: false });
    expect(updated).toMatchObject({ needsFollowUp: false, version: item.version + 1 });
    expect(f.work.list({ needsFollowUp: false }).total).toBe(1);
    expect(f.work.list({ needsFollowUp: true }).total).toBe(0);
    expect(() => f.work.setFollowUp({ id: item.id, version: item.version, needsFollowUp: true })).toThrow("已变更");
  });
  it.each([false, true])("blocks automatic dispatch with unprocessed results (pending storage=%s) but allows manual dispatch", async pendingStorage => {
    const f = await fixture();
    if (pendingStorage) vi.spyOn(f.db, "insertWorkItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    await f.source();
    const enabled = f.service.saveTask("template", { enabled: true, id: f.task.id, recordHistory: false,
      schedule: f.task.schedule, ownerId: f.owner.id, name: f.task.name, prompt: f.task.prompt, tools: f.task.tools, mode: f.task.mode,
    });
    await f.service.tickTasks();
    vi.spyOn(Date, "now").mockReturnValue(f.service.listTasks("template")[0].nextRunAt);
    await f.service.tickTasks();
    expect(f.instances.create).toHaveBeenCalledTimes(1);
    expect(f.service.listTasks("template")[0]).toMatchObject({ executedCount: 1, lastRun: { status: "skipped", error: expect.stringContaining("未处理任务") } });
    await f.service.runTask("template", { id: f.task.id });
    expect(f.instances.create).toHaveBeenCalledTimes(2);
  });
  it("creates independently of history, preserves text, deduplicates events but not separate runs", async () => {
    const f = await fixture();
    const output = "  <proposed_plan>\n" + "完整回复".repeat(2000) + "\n</proposed_plan>  ";
    const first = await f.source(output);
    expect(f.db.listTaskRuns("template", f.task.id).total).toBe(0);
    expect(f.work.get({ id: first.id })).toMatchObject({ output, sourceSessionId: "session-1", sourceTurnId: "turn-1", tools: [], taskId: f.task.id, ownerId: f.owner.id, status: "pending" });
    f.end("session-1", output);
    expect(f.work.list().total).toBe(1);
    await f.source(output);
    expect(f.work.list().total).toBe(2);
    expect(f.work.list().records[0]).not.toHaveProperty("output");
  });
  it.each([["", "completed"], ["  \n ", "completed"], ["有回复", "failed"], ["部分回复", "stopped"]])("does not enqueue %j / %s", async (output, status) => {
    const f = await fixture(); await f.source(output, status); expect(f.work.list().total).toBe(0);
  });
  it("ignores other threads and never treats idle as successful completion", async () => {
    const f = await fixture();
    await f.service.generate("template", { mode: "default", prompt: "检查" }, f.task);
    f.end("session-1", "错误回合回复", "completed", { threadId: "wrong" });
    expect(f.work.list().total).toBe(0);
    expect(f.service.listTasks("template")[0].lastRun.status).toBe("running");
    f.end("session-1", "正确结果");
    expect(f.work.list().total).toBe(1);
  });
  it.each([false, true])("waits after errors and accepts later replies (manual=%s)", async manual => {
    const f = await fixture();
    let item; let sessionId;
    if (manual) { item = await f.source(); sessionId = (await f.work.execute({ id: item.id, version: item.version })).sessionId; }
    else { sessionId = (await f.service.generate("template", { mode: "plan", prompt: "检查" }, { ...f.task, recordHistory: true })).result.body.sessionId; }
    f.end(sessionId, "部分内容", "failed", { error: "临时失败" });
    Object.assign(f.sessions.get(sessionId), { busy: false, error: "快照错误" });
    expect(f.service.listTasks("template")[0].lastRun.status).toBe(manual ? "completed" : "running");
    if (manual) {
      expect(f.work.get({ id: item.id }).status).toBe("running");
      await expect(f.work.execute({ id: item.id, version: f.work.get({ id: item.id }).version })).rejects.toThrow();
    } else {
      const run = f.db.listTaskRuns("template", f.task.id).records[0];
      expect(f.db.getTaskRun("template", f.task.id, run.id)).toMatchObject({ status: "running", output: "", error: "" });
    }
    f.end(sessionId, "   ");
    f.sessions.get(sessionId).turnId = "retry-turn";
    f.end(sessionId, "恢复后的最终回复");
    f.end(sessionId, "重复回复");
    if (manual) {
      const done = f.work.get({ id: item.id });
      expect(done.status).toBe("completed");
      expect(f.work.getAttempt({ id: item.id, attemptId: done.latestAttemptId })).toMatchObject({ output: "恢复后的最终回复", error: "", turnId: "retry-turn" });
    } else {
      expect(f.service.listTasks("template")[0].lastRun.status).toBe("completed");
      expect(f.work.list().total).toBe(1);
      expect(f.work.get({ id: f.work.list().records[0].id }).sourceTurnId).toBe("retry-turn");
    }
  });
  it("retains deferred creation errors until the session closes", async () => {
    const f = await fixture();
    f.instances.create.mockImplementationOnce(async (_body, hooks) => {
      f.sessions.set("created", { threadId: "thread", busy: false, error: "snapshot error" });
      hooks.onSessionCreated({ id: "created" });
      throw new Error("submission failed");
    });
    await f.service.generate("template", { mode: "plan", prompt: "检查" }, f.task);
    expect(f.service.listTasks("template")[0].lastRun).toMatchObject({ status: "running", error: "" });
    f.sessions.delete("created");
    expect(f.service.listTasks("template")[0].lastRun).toMatchObject({ status: "failed", error: expect.stringContaining("submission failed") });
  });
  it("keeps tracking when a snapshot cannot be read", async () => {
    const f = await fixture(); const item = await f.source();
    const running = await f.work.execute({ id: item.id, version: item.version });
    vi.spyOn(f.graphical, "getInjectedToolState").mockImplementation(() => { throw new Error("snapshot unavailable"); });
    await vi.waitFor(() => expect(f.graphical.getInjectedToolState).toHaveBeenCalled(), { timeout: 2000 });
    expect(f.work.get({ id: item.id }).status).toBe("running");
    f.end(running.sessionId, "成功回复");
    expect(f.work.get({ id: item.id }).status).toBe("completed");
  });
  it("keeps a created manual session running after HTTP timeout and records errors on close", async () => {
    const f = await fixture(); const item = await f.source();
    vi.spyOn(f.api, "invoke").mockImplementationOnce(async (_input, hooks) => {
      f.sessions.set("timeout", { threadId: "timeout-thread", busy: false });
      hooks.onSessionCreated({ id: "timeout" });
      throw new Error("HTTP 超时");
    });
    await expect(f.work.execute({ id: item.id, version: item.version })).rejects.toThrow("HTTP 超时");
    const running = f.work.get({ id: item.id });
    expect(running.status).toBe("running");
    expect(f.work.getAttempt({ id: item.id, attemptId: running.latestAttemptId }).error).toBe("");
    f.sessions.delete("timeout");
    await vi.waitFor(() => expect(f.work.get({ id: item.id }).status).toBe("failed"), { timeout: 2000 });
    expect(f.work.getAttempt({ id: item.id, attemptId: running.latestAttemptId }).error).toContain("HTTP 超时");
  });
  it("retries failed persistence by run ID without rerunning AI", async () => {
    const f = await fixture();
    const saved = f.db.insertWorkItem;
    vi.spyOn(f.db, "insertWorkItem").mockImplementationOnce(() => { throw new Error("disk"); }).mockImplementation(saved);
    await f.source(); expect(f.work.list().total).toBe(0);
    await vi.waitFor(() => expect(f.work.list().total).toBe(1), { timeout: 2000 });
    expect(f.instances.create).toHaveBeenCalledTimes(1);
  });
  it("tracks zero-tool execution, blocks duplicate submission and keeps attempts without recursive enqueue", async () => {
    const f = await fixture(); const item = await f.source();
    const preview = f.work.preview({ id: item.id, version: item.version });
    expect(preview.body.prompt).toBe("修复模块的问题");
    expect(JSON.stringify(preview)).not.toContain("private");
    const first = f.work.execute({ id: item.id, version: item.version });
    await expect(f.work.execute({ id: item.id, version: item.version })).rejects.toThrow();
    const running = await first;
    expect(running.status).toBe("running");
    expect(f.instances.create.mock.calls.at(-1)[0]).toMatchObject({ mode: "default" });
    f.end(running.sessionId, "执行成功");
    const done = f.work.get({ id: item.id }); expect(done.status).toBe("completed");
    expect(done.output).toBe("修复模块的问题"); expect(done.sourceSessionId).toBe("session-1");
    expect(f.work.list().total).toBe(1);
    const attempt = f.work.getAttempt({ id: item.id, attemptId: done.latestAttemptId });
    expect(attempt).toMatchObject({ status: "completed", output: "执行成功", sessionId: "session-2" });
    const second = await f.work.execute({ id: item.id, version: done.version });
    f.end(second.sessionId, "失败", "failed");
    f.end("session-2", "迟到的旧回复");
    expect(f.work.get({ id: item.id }).status).toBe("running");
    f.sessions.delete(second.sessionId);
    await vi.waitFor(() => expect(f.work.get({ id: item.id }).status).toBe("failed"), { timeout: 2000 });
    expect(f.work.listAttempts({ id: item.id }).total).toBe(2);
    expect(f.work.getAttempt({ id: item.id, attemptId: attempt.id }).status).toBe("completed");
  });
  it("handles a turn that completes before the submitted hook without reopening it", async () => {
    const f = await fixture();
    f.instances.create.mockImplementationOnce(async (_body, hooks) => {
      f.sessions.set("instant", { threadId: "instant-thread", turnId: "instant-turn", busy: true, authorized: true });
      hooks.onSessionCreated({ id: "instant" });
      f.end("instant", "即时完成");
      hooks.onTaskSubmitted({ id: "instant" });
      return { sessionId: "instant", status: "started" };
    });
    const item = await f.source("unused");
    expect(f.work.list().total).toBe(1); expect(item.status).toBe("pending");
    await f.service.tickTasks();
    expect(f.service.listTasks("template")[0].executedCount).toBe(1);
  });
  it("does not unlock a timeout if writing the uncertain state failed", async () => {
    const f = await fixture(); const item = await f.source();
    const update = f.db.updateWorkItemAttempt;
    vi.spyOn(f.db, "updateWorkItemAttempt").mockImplementation((...args) => {
      if (args[2].status === "uncertain") throw new Error("disk full");
      return update(...args);
    });
    vi.spyOn(f.api, "invoke").mockImplementationOnce(async (_input, hooks) => { hooks.onCreationClaimed(); throw new Error("HTTP 超时"); });
    await expect(f.work.execute({ id: item.id, version: item.version })).rejects.toThrow("HTTP 超时");
    const locked = f.work.get({ id: item.id });
    expect(locked.status).toBe("creating");
    expect(f.work.list().storageErrors.join(" ")).toContain("写入失败");
    await expect(f.work.execute({ id: item.id, version: locked.version })).rejects.toThrow();
    vi.mocked(f.db.updateWorkItemAttempt).mockImplementation(update);
    await vi.waitFor(() => expect(f.work.get({ id: item.id }).status).toBe("uncertain"), { timeout: 2000 });
  });
  it("skips owner schedules while a manual execution is running", async () => {
    const f = await fixture(); const item = await f.source();
    await f.work.execute({ id: item.id, version: item.version });
    const { id, ownerId, name, prompt, mode, tools, schedule } = f.task;
    const task = f.service.saveTask("template", { id, ownerId, name, prompt, mode, tools, schedule, enabled: true })[0];
    const clock = vi.spyOn(Date, "now").mockReturnValue(task.nextRunAt - 60000);
    await f.service.tickTasks(); clock.mockReturnValue(task.nextRunAt); await f.service.tickTasks();
    expect(f.service.listTasks("template")[0].lastRun.status).toBe("skipped");
    expect(f.instances.create).toHaveBeenCalledTimes(2);
  });
  it("retains source tools and owner permissions, uses current owner/template and never stores tokens", async () => {
    const f = await fixture(); const item = await f.source("实施方案", "completed", { tools: ["list_module_owners", "update_module_owner"] });
    f.templates[0].codexAppServerModel = "new-model";
    f.service.mutate("template", { operation: "update", id: f.owner.id, name: f.owner.name, directories: f.owner.directories, version: f.owner.version, responsibilities: "最新职责" });
    const running = await f.work.execute({ id: item.id, version: item.version });
    const body = f.instances.create.mock.calls.at(-1)[0];
    expect(body.prompt).toBe("实施方案");
    expect(body.tools.map(tool => tool.name)).toEqual(item.tools);
    const call = args => fetch(f.api.status().url + "/api/v1/module-owner-tools", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.toolCallback.bearerToken}` }, body: JSON.stringify({ sessionId: running.sessionId, threadId: "thread-2", turnId: "turn-2", callId: "call", tool: "update_module_owner", arguments: args }) });
    expect((await (await call({ ...f.owner, id: "someone-else" })).json()).success).toBe(false);
    const attempt = f.work.getAttempt({ id: item.id, attemptId: running.latestAttemptId });
    expect(attempt.configuration.codexAppServerModel).toBe("new-model");
    expect(JSON.stringify(attempt)).not.toContain(body.toolCallback.bearerToken);
  });
  it("keeps scoped tools after manual completion and cleanup without duplicating results", async () => {
    const f = await fixture();
    const item = await f.source("实施方案", "completed", { tools: ["list_module_owners", "update_module_owner"] });
    const running = await f.work.execute({ id: item.id, version: item.version });
    const body = f.instances.create.mock.calls.at(-1)[0];
    f.end(running.sessionId, "completed result");
    const saved = f.work.get({ id: item.id });
    const attempt = f.work.getAttempt({ id: item.id, attemptId: running.latestAttemptId });
    Object.assign(f.sessions.get(running.sessionId), { busy: true, turnId: "followup" });
    const call = (tool, args) => fetch(f.api.status().url + "/api/v1/module-owner-tools", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.toolCallback.bearerToken}` },
      body: JSON.stringify({ sessionId: running.sessionId, threadId: "thread-2", turnId: "followup", callId: String(Math.random()), tool, arguments: args }) });
    expect((await (await call("list_module_owners", {})).json()).success).toBe(true);
    expect((await (await call("add_module_owner", { name: "forbidden", responsibilities: "x", directories: ["src"] })).json()).success).toBe(false);
    const owner = f.service.get("template").records[0];
    expect((await (await call("update_module_owner", { ...owner, id: "other" })).json()).success).toBe(false);
    f.end(running.sessionId, "do not rewrite");
    expect(f.work.list().total).toBe(1);
    expect(f.work.get({ id: item.id })).toEqual(saved);
    expect(f.work.getAttempt({ id: item.id, attemptId: running.latestAttemptId })).toEqual(attempt);
    f.service.mutate("template", { operation: "delete", id: owner.id, version: owner.version });
    Object.assign(f.sessions.get(running.sessionId), { busy: true, turnId: "followup" });
    expect((await call("list_module_owners", {})).status).toBe(401);
  });
  it("normalizes outer whitespace, records edited text only for this attempt and validates it", async () => {
    const f = await fixture(); const item = await f.source();
    expect(f.instances.create.mock.calls[0][0].prompt).toContain("本次负责人的最新信息");
    const input = { id: item.id, version: item.version, prompt: "  修改后的方案\n保留换行  " };
    expect(f.work.preview(input).body.prompt).toBe(input.prompt.trim());
    expect(() => f.work.preview({ ...input, prompt: " \n " })).toThrow("提示词不能为空");
    await expect(f.work.execute({ ...input, prompt: "" })).rejects.toThrow("提示词不能为空");
    expect(() => f.work.preview({ ...input, prompt: "中".repeat(100000) })).toThrow("256 KiB");
    const running = await f.work.execute(input);
    expect(f.instances.create.mock.calls.at(-1)[0].prompt).toBe(input.prompt.trim());
    expect(f.work.getAttempt({ id: item.id, attemptId: running.latestAttemptId }).input.prompt).toBe(input.prompt.trim());
    f.end(running.sessionId);
    const saved = f.work.get({ id: item.id });
    expect(saved.output).toBe("修复模块的问题");
    expect(f.work.preview({ id: item.id, version: saved.version }).body.prompt).toBe(saved.output);
  });
  it("locks timeout until the server finishes; allows explicit reconciliation after the session ends", async () => {
    const f = await fixture(); const item = await f.source();
    let hooks;
    vi.spyOn(f.api, "invoke").mockImplementationOnce(async (input, callbacks) => { hooks = callbacks; hooks.onCreationClaimed(); throw new Error("HTTP 超时"); });
    await expect(f.work.execute({ id: item.id, version: item.version })).rejects.toThrow("HTTP 超时");
    const uncertain = f.work.get({ id: item.id }); expect(uncertain.status).toBe("uncertain");
    expect(() => f.work.resolveUncertain({ id: item.id, version: uncertain.version })).toThrow("仍在处理");
    await expect(f.work.execute({ id: item.id, version: uncertain.version })).rejects.toThrow();
    f.sessions.set("late", { threadId: "late-thread", turnId: "late-turn", busy: true, authorized: true });
    hooks.onSessionCreated({ id: "late" }); hooks.onTaskSubmitted({ id: "late" });
    const late = f.work.get({ id: item.id }); expect(late.status).toBe("running");
    f.end("late", "中断", "stopped");
    expect(f.work.get({ id: item.id }).status).toBe("running");
    f.sessions.delete("late");
    await vi.waitFor(() => expect(f.work.get({ id: item.id }).status).toBe("failed"), { timeout: 2000 });
  });
  it("recovers unfinished attempts as uncertain and rejects reconciliation while the old session is busy", async () => {
    const f = await fixture(); const item = await f.source(); const running = await f.work.execute({ id: item.id, version: item.version });
    f.db.recoverWorkItemAttempts();
    const uncertain = f.work.get({ id: item.id }); expect(uncertain.status).toBe("uncertain");
    expect(() => f.work.resolveUncertain({ id: item.id, version: uncertain.version })).toThrow("仍在运行");
    f.sessions.delete(running.sessionId);
    expect(f.work.resolveUncertain({ id: item.id, version: uncertain.version }).status).toBe("stopped");
    const next = f.work.get({ id: item.id });
    expect((await f.work.execute({ id: next.id, version: next.version })).status).toBe("running");
  });
  it("supports void/restore with version checks; preserves tasks after source removal and prevents execution", async () => {
    const f = await fixture(); const item = await f.source();
    const removed = f.work.void({ id: item.id, version: item.version, reason: "无需执行" });
    expect(removed).toMatchObject({ status: "void", voidReason: "无需执行" });
    expect(f.work.list().total).toBe(0);
    expect(f.work.list({ statuses: ["pending", "void"] }).records[0].id).toBe(item.id);
    expect(f.work.list({ statuses: [] }).total).toBe(0);
    expect(() => f.work.list({ statuses: ["invalid"] })).toThrow();
    await expect(f.work.execute({ id: item.id, version: removed.version })).rejects.toThrow();
    expect(() => f.work.restore({ id: item.id, version: item.version })).toThrow("已变更");
    const restored = f.work.restore({ id: item.id, version: removed.version });
    f.service.deleteTask("template", { id: f.task.id });
    expect((await f.work.execute({ id: item.id, version: restored.version })).status).toBe("running");
    f.end("session-2");
    f.service.mutate("template", { operation: "delete", id: f.owner.id, version: f.owner.version });
    expect(f.work.list().total).toBe(1); expect(f.work.get({ id: item.id }).unavailable).toContain("负责人已删除");
    await expect(f.work.execute({ id: item.id, version: f.work.get({ id: item.id }).version })).rejects.toThrow("负责人已删除");
    f.templates.splice(0); expect(f.work.list().records[0].unavailable).toContain("模板已删除");
  });
  it("blocks manually starting while a scheduled owner run is active and rejects oversized payloads", async () => {
    const f = await fixture(); const item = await f.source();
    await f.service.generate("template", { mode: "default", prompt: "再次巡检" }, f.task);
    await expect(f.work.execute({ id: item.id, version: item.version })).rejects.toThrow("此负责人");
    f.sessions.delete("session-2");
    const large = await f.source("中".repeat(100000));
    expect(() => f.work.preview({ id: large.id, version: large.version })).toThrow("256 KiB");
  });
});

it("validates quick prompt management", async () => {
  const f = await fixture();
  expect(() => f.work.mutateQuickPrompt({ operation: "add", name: " ", prompt: "内容" })).toThrow();
  expect(() => f.work.mutateQuickPrompt({ operation: "add", name: "要求", prompt: " \n " })).toThrow();
  const first = f.work.mutateQuickPrompt({ operation: "add", name: "要求", prompt: "追加要求" })[0];
  expect(f.work.listQuickPrompts()).toEqual([first]);
  expect(f.broadcast).toHaveBeenCalledWith("work-items:changed");
  expect(() => f.work.mutateQuickPrompt({ operation: "update", ...first, version: 99 })).toThrow("已修改或删除");
});

it("manually completes unavailable work items and broadcasts without launching", async () => {
  const f = await fixture(); const item = await f.source();
  f.templates.length = 0;
  const attempts = f.work.listAttempts({ id: item.id });
  f.broadcast.mockClear();
  expect(() => f.work.markCompleted({ id: item.id, version: item.version, extra: true })).toThrow();
  const updated = f.work.markCompleted({ id: item.id, version: item.version });
  expect(updated).toMatchObject({ status: "completed", version: item.version + 1, needsFollowUp: item.needsFollowUp });
  expect(f.work.listAttempts({ id: item.id })).toEqual(attempts);
  expect(f.broadcast).toHaveBeenCalledWith("work-items:changed");
  expect(() => f.work.markCompleted({ id: item.id, version: item.version })).toThrow("已变更");
});

describe("work item owner availability reads", () => {
  it("reads each template once per list and refreshes deleted-owner markers on the next query", () => {
    const owners = vi.fn(id => id === "one" ? [{ id: "shared" }] : []);
    const result = { templates: [], owners: [
      { templateId: "one", id: "shared", name: "现有" },
      { templateId: "one", id: "deleted", name: "删除" },
      { templateId: "two", id: "shared", name: "另一模板" }
    ], records: Array.from({ length: 20 }, (_, index) => ({ templateId: index < 10 ? "one" : "two", ownerId: "shared" })) };
    const service = createWorkItemService({ dataStore: { listWorkItems: () => result }, template: () => ({}), supported: () => true, owners });
    const listed = service.list();
    expect(owners.mock.calls).toEqual([["one"], ["two"]]);
    expect(listed.owners.map(owner => owner.name)).toEqual(["现有", "删除（已删除）", "另一模板（已删除）"]);
    expect(listed.records.map(item => item.unavailable)).toEqual([...Array(10).fill(""), ...Array(10).fill("来源负责人已删除。")]);
    owners.mockClear(); owners.mockImplementation(() => []);
    expect(service.list().records.every(item => item.unavailable === "来源负责人已删除。")).toBe(true);
    expect(owners.mock.calls).toEqual([["one"], ["two"]]);
  });
  it("uses the injected lightweight store read without cloning history as history grows", () => {
    const userData = mkdtempSync(path.join(tmpdir(), "pannel-work-items-history-"));
    let service;
    try {
      const records = Array.from({ length: 100 }, (_, index) => ({ id: `owner-${index}`, recentActivity: "" }));
      const state = { schemaVersion: 1, templates: { template: { records, tasks: [], history: [] } } };
      const result = { templates: [], owners: records.map(owner => ({ ...owner, templateId: "template", name: owner.id })),
        records: records.slice(0, 20).map(owner => ({ templateId: "template", ownerId: owner.id })) };
      service = createModuleOwnerService({ userData, graphicalService: {}, terminalManager: {}, dataStore: { read: () => state, listWorkItems: () => result },
        sessionStore: { getTemplate: () => ({ type: "windows", agentProvider: "codex", cwd: "C:\\repo" }) } });
      const clone = vi.spyOn(globalThis, "structuredClone");
      for (const size of [1000, 5000]) {
        state.templates.template.history = Array.from({ length: size }, () => ({ text: "x".repeat(20000) }));
        clone.mockClear();
        const listed = service.workItems.list();
        expect(listed.records.every(item => item.unavailable === "")).toBe(true);
        expect(clone.mock.calls).toEqual([[state.templates.template.tasks]]);
      }
    } finally { service?.shutdown(); rmSync(userData, { recursive: true, force: true }); }
  });
});

it("decorates asynchronous keyword search results", async () => {
  const f = await fixture();
  await f.source();
  const result = await f.work.list({ keyword: "" });
  const item = f.work.get({ id: result.records[0].id });
  const listed = await f.work.list({ keyword: item.output.slice(0, 5) });
  expect(listed.total).toBe(1);
  expect(listed.records[0]).toHaveProperty("unavailable", "");
  expect(listed).toHaveProperty("storageErrors", []);
});
