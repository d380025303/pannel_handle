import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createModuleOwnerService, CALLBACK_PATH } = require("./module-owner-service.cjs");
const { createSessionApiService } = require("../session-api/session-api-service.cjs");
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
const { createGraphicalSessionRouter } = require("../codebuddy-acp/session-router.cjs");
const fixtures = [];
const settings = { mode: "plan", prompt: "分析项目" };
const fields = { name: "模块 A", responsibilities: "职责 A", directories: ["src"] };
async function fixture(withHistory = false) {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-owner-api-"));
  const templates = [{ id: "one", title: "One", type: "windows", agentProvider: "codex", cwd: "C:\\repo" }, { id: "two", title: "Two", type: "windows", agentProvider: "claude", cwd: "C:\\repo" }];
  const sessions = new Map();
  const graphicalService = { snapshot: id => sessions.get(id), getInjectedToolState: id => sessions.get(id),
    isInjectedToolCallCurrent: (id, input) => sessions.get(id)?.busy && sessions.get(id)?.turnId === input.turnId && input.callId !== "canceled" };
  let listener;
  graphicalService.onTaskTurnEnded = fn => { listener = fn; return () => { listener = undefined; }; };
  const dataStore = createBusinessDataStore({ userData }).open();
  let api;
  const terminalManager = { getSession: id => sessions.get(id) };
  const routedGraphicalService = createGraphicalSessionRouter(graphicalService, {}, terminalManager);
  const owners = createModuleOwnerService({ userData, dataStore, sessionStore: { getTemplate: id => templates.find(value => value.id === id), getLibrary: () => templates },
    terminalManager, graphicalService: routedGraphicalService, getSessionApi: () => api });
  let body;
  const instances = { listTemplates: () => ({ templates: [] }), create: vi.fn(async (input, hooks) => {
    body = input;
    sessions.set("run", { threadId: "thread", turnId: null, busy: false, authorized: true });
    hooks.onSessionCreated({ id: "run" });
    sessions.get("run").busy = true; sessions.get("run").turnId = "turn";
    hooks.onTaskSubmitted({ id: "run" });
    return { sessionId: "run", status: "started" };
  }) };
  api = createSessionApiService({ userData, instances, moduleOwners: owners, defaultPort: 0 });
  fixtures.push({ api, userData, owners, dataStore });
  await api.configure({ enabled: true });
  const callback = (tool, args, overrides = {}) => fetch(api.status().url + CALLBACK_PATH, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${body?.toolCallback.bearerToken}` },
    body: JSON.stringify({ sessionId: "run", threadId: "thread", turnId: "turn", callId: `${Math.random()}`, tool, arguments: args, ...overrides }) });
  return { owners, api, callback, sessions, instances, templates, dataStore, end: event => listener(event), getBody: () => body };
}
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.stop(); f.owners.shutdown(); f.dataStore?.close(); rmSync(f.userData, { recursive: true, force: true }); } });
describe("module owner generation through actual HTTP", () => {
  it("queries generation without cloning storage and refreshes lifecycle within template scope", async () => {
    const f = await fixture();
    expect(f.owners.getGeneration("one")).toBeNull();
    expect(() => f.owners.getGeneration("missing")).toThrow("来源会话模板不存在");
    await f.owners.generate("one", settings);
    const clone = vi.spyOn(globalThis, "structuredClone");
    for (let i = 0; i < 7; i++) {
      expect(f.owners.getGeneration("one")).toMatchObject({ status: "running", sessionId: "run" });
      expect(f.owners.getGeneration("two")).toBeNull();
    }
    const result = f.owners.getGeneration("one");
    result.status = "tampered";
    expect(f.owners.getGeneration("one").status).toBe("running");
    f.sessions.get("run").busy = false;
    expect(f.owners.getGeneration("one").status).toBe("completed");
    expect(clone).not.toHaveBeenCalled();
    expect((await f.callback("add_module_owner", fields)).status).toBe(401);
  });
  it("never accesses accumulated history during repeated generation queries", () => {
    const entry = { kind: "owner", ownerId: "owner", before: { responsibilities: "a".repeat(5000) }, after: { responsibilities: "b".repeat(5000) } };
    const state = { schemaVersion: 1, templates: { one: { revision: 5000, records: [], history: Array.from({ length: 5000 }, () => entry), settings } } };
    const read = vi.fn(() => state);
    const owners = createModuleOwnerService({ userData: "memory-only", dataStore: { read },
      sessionStore: { getTemplate: id => id === "one" ? { id } : null, getLibrary: () => [] },
      terminalManager: {}, graphicalService: {}, getSessionApi: () => null });
    try {
      const history = vi.fn(() => { throw new Error("history accessed"); });
      Object.defineProperty(state.templates.one, "history", { get: history });
      const clone = vi.spyOn(globalThis, "structuredClone");
      read.mockClear();
      for (let i = 0; i < 7; i++) expect(owners.getGeneration("one")).toBeNull();
      expect(history).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally { owners.shutdown(); }
  });

  it("lists all owners or filters by an optional exact module name within the source template", async () => {
    const f = await fixture();
    f.owners.mutate("one", { operation: "add", ...fields });
    f.owners.mutate("one", { operation: "add", ...fields, name: "模块 AB" });
    f.owners.mutate("two", { operation: "add", ...fields });
    await f.owners.generate("one", settings);
    const list = async args => (await (await f.callback("list_module_owners", args)).json());
    expect(JSON.parse((await list({})).output)).toHaveLength(2);
    expect(JSON.parse((await list({ name: "  模块 A  " })).output)).toEqual([f.owners.get("one").records[0]]);
    expect(JSON.parse((await list({ name: "模块" })).output)).toEqual([]);
    for (const args of [{ name: "" }, { name: "   " }, { name: 1 }, { name: null }, { name: "a".repeat(201) }, { name: "模块 A", templateId: "two" }]) {
      expect((await list(args)).success).toBe(false);
    }
  });
  it("submits existing owners and tools, binds callbacks and maintains an isolated table with AI history", async () => {
    const f = await fixture();
    f.owners.mutate("one", { operation: "add", ...fields });
    const generated = await f.owners.generate("one", settings);
    expect(generated.result.status).toBe(201);
    expect(f.getBody().prompt).toContain('"name": "模块 A"');
    expect(f.getBody().tools.map(value => value.name)).toEqual(["list_module_owners", "add_module_owner", "update_module_owner", "delete_module_owner"]);
    expect(JSON.stringify(generated.state)).not.toContain(f.getBody().toolCallback.bearerToken);
    expect(JSON.stringify(generated.request)).not.toContain(f.getBody().toolCallback.bearerToken);
    expect(generated.request.prompt).toBe(f.getBody().prompt);
    expect(JSON.stringify(f.owners.preview("one", settings))).not.toContain(f.getBody().toolCallback.bearerToken);
    expect((await (await f.callback("add_module_owner", { ...fields, name: "模块 B" })).json()).success).toBe(true);
    const record = f.owners.get("one").records[0];
    expect((await (await f.callback("update_module_owner", { ...fields, id: record.id, version: record.version, responsibilities: "AI 更新", recentActivity: "执行模块检查" })).json()).success).toBe(true);
    expect((await (await f.callback("delete_module_owner", { id: record.id, version: record.version })).json()).success).toBe(false);
    const current = f.owners.get("one").records[0];
    const listed = JSON.parse((await (await f.callback("list_module_owners", { name: current.name })).json()).output);
    expect(listed[0].recentActivity).toBe("执行模块检查");
    expect((await (await f.callback("delete_module_owner", { id: current.id, version: current.version })).json()).success).toBe(true);
    expect(f.owners.get("one").records).toHaveLength(1);
    expect(f.owners.get("two").records).toEqual([]);
    expect(f.owners.get("one").history.at(-1)).toMatchObject({ source: "ai", sessionId: "run", operation: "delete" });
    expect((await (await f.callback("list_module_owners", {})).json()).output).toContain("模块 B");
    expect(f.templates[0]).not.toHaveProperty("tools");
  });
  it("rejects wrong sessions, threads, turns, canceled requests, duplicate calls and parameter scope injection", async () => {
    const f = await fixture(); await f.owners.generate("one", settings);
    for (const override of [{ sessionId: "other" }, { threadId: "other" }, { turnId: "other" }, { callId: "canceled" }]) expect((await f.callback("add_module_owner", fields, override)).status).toBe(401);
    expect((await (await f.callback("add_module_owner", { ...fields, templateId: "two" })).json()).success).toBe(false);
    expect((await (await f.callback("add_module_owner", fields, { callId: "repeat" })).json()).success).toBe(true);
    expect((await (await f.callback("add_module_owner", { ...fields, name: "duplicate" }, { callId: "repeat" })).json()).success).toBe(false);
    expect((await fetch(f.api.status().url + CALLBACK_PATH, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.api.revealToken()}` }, body: "{}" })).status).toBe(401);
    expect(f.owners.get("one").records).toHaveLength(1);
  });
  it("blocks concurrent generation and rollback, revokes finished calls and allows history recovery", async () => {
    const f = await fixture(); await f.owners.generate("one", settings);
    await f.callback("add_module_owner", fields);
    await expect(f.owners.generate("one", settings)).rejects.toThrow("已有生成任务");
    const state = f.owners.get("one");
    expect(() => f.owners.restore("one", { historyId: state.history[0].id, revision: state.revision })).toThrow("不能回滚");
    f.sessions.get("run").busy = false; f.sessions.get("run").turnId = null;
    expect(f.owners.get("one").generation.status).toBe("completed");
    expect((await f.callback("add_module_owner", { ...fields, name: "late" })).status).toBe(401);
    expect(f.owners.restore("one", { historyId: state.history[0].id, revision: state.revision }).records).toHaveLength(1);
  });
  it.each(["thread", "turn", "revoke", "close"])("revokes grants when lifecycle changes: %s", async change => {
    const f = await fixture(); await f.owners.generate("one", settings);
    if (change === "thread") f.sessions.get("run").threadId = "new";
    if (change === "turn") f.sessions.get("run").turnId = "next-turn";
    if (change === "revoke") f.sessions.get("run").authorized = false;
    if (change === "close") f.sessions.delete("run");
    expect((await f.callback("add_module_owner", fields)).status).toBe(401);
    expect(f.owners.get("one").generation.status).toBe("stopped");
  });
  it("does not create for unsupported templates or a stopped HTTP server and reports creation failures", async () => {
    const f = await fixture();
    await expect(f.owners.generate("two", settings)).rejects.toThrow("仅支持");
    f.instances.create.mockRejectedValueOnce(new Error("launch failed"));
    expect((await f.owners.generate("one", settings)).state.generation.status).toBe("failed");
    expect((await f.callback("add_module_owner", fields)).status).toBe(401);
    await f.api.configure({ enabled: false });
    await expect(f.owners.generate("one", settings)).rejects.toThrow("开启 HTTP");
  });
  it("keeps a timed-out HTTP launch locked while the server is still preparing the first turn", async () => {
    const f = await fixture();
    let hooks;
    vi.spyOn(f.api, "invoke").mockImplementationOnce(async input => {
      hooks = f.owners.claimCreation(input.body);
      f.sessions.set("run", { threadId: "thread", turnId: null, busy: false, authorized: true });
      hooks.onSessionCreated({ id: "run" });
      throw new Error("HTTP 超时");
    });
    await expect(f.owners.generate("one", settings)).rejects.toThrow("HTTP 超时");
    expect(f.owners.get("one").generation).toMatchObject({ status: "uncertain", sessionId: "run" });
    await expect(f.owners.generate("one", settings)).rejects.toThrow("已有生成任务");
    f.sessions.get("run").busy = true; f.sessions.get("run").turnId = "turn";
    hooks.onTaskSubmitted({ id: "run" });
    expect(f.owners.get("one").generation.status).toBe("uncertain");
    f.sessions.delete("run");
    expect(f.owners.get("one").generation.status).toBe("stopped");
  });
});

const scheduled = ownerId => ({ ownerId, name: "巡检", prompt: "检查所属模块", mode: "default", enabled: true,
  tools: ["list_module_owners", "update_module_owner"], schedule: { kind: "interval", minutes: 1, count: 2 } });
async function due(f, advance = 60000) {
  const task = f.owners.listTasks("one")[0];
  const clock = vi.spyOn(Date, "now").mockReturnValue(task.nextRunAt - 60000);
  await f.owners.tickTasks();
  clock.mockReturnValue(task.nextRunAt - 60000 + advance);
  await f.owners.tickTasks();
  return clock;
}
describe("module owner scheduled HTTP sessions", () => {
  it.each([
    [], ["list_module_owners"], ["update_module_owner"],
    ["list_module_owners", "update_module_owner"]
  ])("describes only explicitly selected tools: %j", async (...selected) => {
    const f = await fixture();
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const prompt = "用户原文：请考虑 list_module_owners，但不要自动授权。";
    f.owners.saveTask("one", { ...scheduled(owner.id), tools: selected, prompt });
    await due(f);
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].executedCount).toBe(1));
    const body = f.getBody();
    expect(body.prompt.startsWith(`${prompt}\n\n`)).toBe(true);
    const appended = body.prompt.slice(prompt.length);
    for (const name of ["list_module_owners", "update_module_owner"]) {
      expect(appended.includes(name)).toBe(selected.includes(name));
    }
    expect(body.tools?.map(tool => tool.name) || []).toEqual(selected);
    if (!selected.length) {
      expect(appended).not.toContain("工具");
      expect(body).not.toHaveProperty("toolCallback");
    }
    if (selected.includes("update_module_owner")) expect(appended).toContain("仅可修改本负责人");
  });
  it("injects selected tools and latest owner, enforces owner boundaries and counts submissions", async () => {
    const f = await fixture();
    f.owners.mutate("one", { operation: "add", ...fields });
    f.owners.mutate("one", { operation: "add", ...fields, name: "模块 B" });
    const [owner, other] = f.owners.get("one").records;
    f.owners.saveTask("one", scheduled(owner.id));
    const revision = f.owners.get("one").revision;
    f.owners.mutate("one", { operation: "update", ...fields, id: owner.id, version: owner.version, responsibilities: "最新职责" });
    const clock = await due(f);
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].executedCount).toBe(1));
    expect(f.getBody().prompt).toContain("最新职责");
    expect(f.getBody().tools.map(t => t.name)).toEqual(["list_module_owners", "update_module_owner"]);
    expect(f.owners.get("one").revision).toBe(revision + 1);
    expect((await (await f.callback("list_module_owners", {})).json()).output).toContain("模块 B");
    expect((await (await f.callback("update_module_owner", { ...fields, id: other.id, version: other.version })).json()).success).toBe(false);
    expect((await (await f.callback("add_module_owner", { ...fields, name: "模块 C" })).json()).success).toBe(false);
    const latest = f.owners.get("one").records[0];
    expect((await (await f.callback("update_module_owner", { ...fields, id: latest.id, version: latest.version })).json()).success).toBe(true);
    expect((await (await f.callback("update_module_owner", { ...fields, id: latest.id, version: latest.version })).json()).success).toBe(false);
    clock.mockReturnValue(f.owners.listTasks("one")[0].nextRunAt);
    await f.owners.tickTasks();
    expect(f.instances.create).toHaveBeenCalledTimes(1);
    expect(f.owners.listTasks("one")[0].executedCount).toBe(1);
    f.sessions.get("run").busy = false;
    f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "完成巡检" });
    const item = f.owners.workItems.list().records[0];
    f.owners.workItems.void({ id: item.id, version: item.version });
    clock.mockReturnValue(f.owners.listTasks("one")[0].nextRunAt);
    await f.owners.tickTasks();
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].enabled).toBe(false));
    expect(f.owners.listTasks("one")[0].executedCount).toBe(2);
    expect(f.owners.listTasks("one")[0].nextRunAt).toBeNull();
    expect(JSON.stringify(f.owners.listTasks("one"))).not.toContain(f.getBody().toolCallback.bearerToken);
    f.owners.mutate("one", { operation: "delete", id: owner.id, version: f.owners.get("one").records[0].version });
    expect((await f.callback("list_module_owners", {})).status).toBe(401);
    const state = f.owners.get("one");
    f.owners.restore("one", { historyId: state.history.at(-1).id, revision: state.revision });
    expect(f.owners.listTasks("one")[0].enabled).toBe(false);
  });
  it("supports no tools, prevents overlap across multiple tasks and keeps deleted running tasks locked", async () => {
    const f = await fixture();
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    f.owners.saveTask("one", { ...scheduled(owner.id), tools: [] });
    f.owners.saveTask("one", { ...scheduled(owner.id), name: "第二项" });
    const clock = await due(f);
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].executedCount).toBe(1));
    expect(f.getBody()).not.toHaveProperty("tools");
    expect(f.getBody()).not.toHaveProperty("toolCallback");
    expect(f.instances.create).toHaveBeenCalledTimes(1);
    f.owners.deleteTask("one", { id: f.owners.listTasks("one")[0].id });
    clock.mockReturnValue(f.owners.listTasks("one")[0].nextRunAt);
    await f.owners.tickTasks();
    expect(f.instances.create).toHaveBeenCalledTimes(1);
  });
  it("does not consume failures, replays no missed periods and disables invalid templates", async () => {
    const f = await fixture();
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    f.owners.saveTask("one", scheduled(owner.id));
    f.instances.create.mockRejectedValueOnce(new Error("failed"));
    const clock = await due(f);
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].lastRun.status).toBe("failed"));
    expect(f.owners.listTasks("one")[0].executedCount).toBe(0);
    clock.mockReturnValue(f.owners.listTasks("one")[0].nextRunAt + 3600000);
    await f.owners.tickTasks();
    expect(f.instances.create).toHaveBeenCalledTimes(1);
    const future = f.owners.listTasks("one")[0].nextRunAt;
    expect(future).toBeGreaterThan(Date.now());
    f.templates[0].agentProvider = "claude";
    await f.owners.tickTasks();
    expect(f.owners.listTasks("one")[0].enabled).toBe(false);
    expect(f.owners.listTasks("one")[0].lastRun.error).toContain("不支持");
  });
});


it("exposes filtered owner history and validates the source template", async () => {
  const f = await fixture();
  const first = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
  f.owners.mutate("one", { operation: "add", ...fields, name: "模块 B" });
  const result = f.owners.listHistory("one", { ownerId: first.id });
  expect(result.revision).toBe(2);
  expect(result.history).toHaveLength(1);
  expect(result.history[0].ownerId).toBe(first.id);
  expect(f.owners.listHistory("two", { ownerId: first.id }).history).toEqual([]);
  expect(() => f.owners.listHistory("missing", { ownerId: first.id })).toThrow("来源会话模板不存在");
});

describe("scheduled call history", () => {
  function trackJobs() {
    let jobs;
    const set = Map.prototype.set;
    vi.spyOn(Map.prototype, "set").mockImplementation(function (key, value) {
      if (typeof key === "string" && key.startsWith("task:") && value?.runId) jobs = this;
      return set.call(this, key, value);
    });
    return () => jobs;
  }

  it("releases completed jobs after ten large replies and task deletions", async () => {
    const getJobs = trackJobs();
    const f = await fixture();
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const output = "x".repeat(1024 * 1024);
    for (let index = 0; index < 10; index++) {
      const task = f.owners.saveTask("one", { ...scheduled(owner.id), enabled: false, autoCreateWorkItem: false })[0];
      await f.owners.runTask("one", { id: task.id });
      f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output });
      expect(getJobs().get(`task:${task.id}`).output).toBe(output);
      f.sessions.clear();
      f.owners.deleteTask("one", { id: task.id });
      expect(getJobs().size).toBe(0);
    }
    expect(f.owners.listTasks("one")).toEqual([]);
    expect(f.sessions.size).toBe(0);
  });

  it.each(["completed", "running"])("retains deleted %s jobs until result and history retries succeed", async status => {
    let retry;
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((fn, delay, ...args) => {
      retry = fn;
      return interval(fn, delay, ...args);
    });
    const getJobs = trackJobs();
    const f = await fixture();
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const task = f.owners.saveTask("one", { ...scheduled(owner.id), enabled: false, recordHistory: true })[0];
    await f.owners.runTask("one", { id: task.id });
    const job = getJobs().get(`task:${task.id}`);
    const saveHistory = f.dataStore.saveTaskRun.bind(f.dataStore);
    const saveResult = f.dataStore.insertWorkItem.bind(f.dataStore);
    const history = vi.spyOn(f.dataStore, "saveTaskRun").mockImplementation(() => { throw new Error("disk full"); });
    const result = vi.spyOn(f.dataStore, "insertWorkItem").mockImplementation(() => { throw new Error("disk full"); });
    if (status === "running") {
      f.owners.deleteTask("one", { id: task.id });
      retry();
      expect(getJobs().get(`task:${task.id}`)).toBe(job);
    }
    f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "final reply" });
    if (status === "completed") f.owners.deleteTask("one", { id: task.id });
    f.sessions.clear();
    retry();
    expect(getJobs().get(`task:${task.id}`)).toBe(job);
    history.mockImplementation(saveHistory);
    retry();
    expect(getJobs().get(`task:${task.id}`)).toBe(job);
    expect(f.owners.getTaskRun("one", { taskId: task.id, id: job.runId })).toMatchObject({ status: "completed", output: "final reply" });
    result.mockImplementation(saveResult);
    retry();
    expect(getJobs().size).toBe(0);
    expect(f.owners.workItems.list().records).toHaveLength(1);
    expect(f.owners.workItems.list().records[0]).toMatchObject({ summary: "final reply", sourceRunId: job.runId });
    retry();
    expect(f.owners.workItems.list().records).toHaveLength(1);
  });

  it("does not serialize or write unchanged history for 100 completed disabled tasks", async () => {
    const f = await fixture(true);
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const output = "x".repeat(256 * 1024);
    for (let index = 0; index < 100; index++) {
      const task = f.owners.saveTask("one", { ...scheduled(owner.id), name: `task ${index}`, enabled: false, recordHistory: true }).at(-1);
      await f.owners.runTask("one", { id: task.id });
      f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output });
      f.sessions.get("run").busy = false;
    }
    await f.owners.tickTasks();
    expect(f.owners.listTasks("one")).toHaveLength(100);
    expect(f.owners.listTasks("one").every(task => !task.enabled && task.lastRun.status === "completed")).toBe(true);
    const stringify = vi.spyOn(JSON, "stringify");
    const save = vi.spyOn(f.dataStore, "saveTaskRun");
    for (let index = 0; index < 5; index++) await f.owners.tickTasks();
    expect(stringify.mock.calls.filter(([value]) => value?.input && value?.output === output)).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  }, 30000);

  it("retries a failed final history save and stops writing after recovery", async () => {
    const f = await fixture(true);
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const task = f.owners.saveTask("one", { ...scheduled(owner.id), enabled: false, recordHistory: true })[0];
    await f.owners.runTask("one", { id: task.id });
    const summary = f.owners.listTaskRuns("one", { taskId: task.id }).records[0];
    const query = { taskId: task.id, id: summary.id };
    expect(f.owners.getTaskRun("one", query)).toMatchObject({ status: "running", sessionId: "run", threadId: "thread", turnId: "turn", output: "" });
    const save = vi.spyOn(f.dataStore, "saveTaskRun").mockImplementationOnce(() => { throw new Error("disk full"); });
    f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "final reply" });
    expect(f.owners.getTaskRun("one", query).status).toBe("running");
    await f.owners.tickTasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(f.owners.getTaskRun("one", query)).toMatchObject({ status: "completed", output: "final reply", endedAt: expect.any(Number) });
    await f.owners.tickTasks();
    expect(save).toHaveBeenCalledTimes(2);
    expect(f.owners.listTasks("one")[0].lastRun.error).toBe("");
  });

  it("defaults off and stores one sanitized record with the matching final turn only", async () => {
    const f = await fixture(true);
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const task = f.owners.saveTask("one", scheduled(owner.id))[0];
    expect(task.recordHistory).toBe(false);
    await due(f);
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].executedCount).toBe(1));
    expect(f.owners.listTaskRuns("one", { taskId: task.id }).total).toBe(0);
    f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "unrecorded" });
    const item = f.owners.workItems.list().records[0];
    f.owners.workItems.void({ id: item.id, version: item.version });
    f.sessions.get("run").busy = false;
    vi.restoreAllMocks();
    f.owners.saveTask("one", { ...scheduled(owner.id), id: task.id, recordHistory: true });
    await due(f);
    await vi.waitFor(() => expect(f.owners.listTaskRuns("one", { taskId: task.id }).total).toBe(1));
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].executedCount).toBe(2));
    const summary = f.owners.listTaskRuns("one", { taskId: task.id }).records[0];
    const query = { taskId: task.id, id: summary.id };
    expect(f.owners.getTaskRun("one", query).input.prompt).toContain("本次负责人的最新信息");
    expect(JSON.stringify(f.owners.getTaskRun("one", query))).not.toContain(f.getBody().toolCallback.bearerToken);
    f.end({ sessionId: "other", threadId: "thread", turnId: "turn", status: "completed", output: "wrong session" });
    f.end({ sessionId: "run", threadId: "other", turnId: "turn", status: "completed", output: "wrong thread" });
    expect(f.owners.getTaskRun("one", query).output).toBe("");
    f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "最终计划" });
    f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "duplicate" });
    expect(f.owners.getTaskRun("one", query)).toMatchObject({ output: "最终计划", status: "completed" });
    f.owners.deleteTask("one", { id: task.id });
    expect(f.owners.getTaskRun("one", query).output).toBe("最终计划");
    expect(() => f.owners.getTaskRun("two", query)).toThrow("不属于");
  });
  it("retains creation failures without repeating creation", async () => {
    const f = await fixture(true);
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const task = f.owners.saveTask("one", { ...scheduled(owner.id), recordHistory: true })[0];
    f.instances.create.mockRejectedValueOnce(new Error("failed"));
    await due(f);
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].lastRun.status).toBe("failed"));
    expect(f.owners.listTaskRuns("one", { taskId: task.id }).records[0]).toMatchObject({ status: "failed" });
    expect(f.instances.create).toHaveBeenCalledTimes(1);
  });
});

it("shows SQLite write failures on the task and continues one creation", async () => {
  const f = await fixture(true);
  const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
  f.owners.saveTask("one", { ...scheduled(owner.id), recordHistory: true });
  vi.spyOn(f.dataStore, "saveTaskRun").mockImplementation(() => { throw new Error("disk full"); });
  await due(f);
  await vi.waitFor(() => expect(f.owners.listTasks("one")[0].executedCount).toBe(1));
  expect(f.owners.listTasks("one")[0].lastRun.error).toContain("历史写入失败");
  expect(f.instances.create).toHaveBeenCalledTimes(1);
});


it("rejects removed task history tools", async () => {
  const f = await fixture();
  await f.owners.generate("one", settings);
  for (const name of ["search_module_owner_task_runs", "get_module_owner_task_run"]) {
    expect(f.getBody().tools.some(tool => tool.name === name)).toBe(false);
    expect(await (await f.callback(name, {})).json()).toMatchObject({ success: false, output: "工具未获本次授权。" });
    expect(() => f.owners.saveTask("one", { ...scheduled("owner"), tools: [name] })).toThrow();
  }
});

it("updates recent activity through HTTP while preserving omission and rejecting stale versions", async () => {
  const f = await fixture();
  f.owners.mutate("one", { operation: "add", ...fields, recentActivity: "开始检查" });
  await f.owners.generate("one", settings);
  const first = f.owners.get("one").records[0];
  const update = async patch => {
    const record = f.owners.get("one").records[0];
    return (await f.callback("update_module_owner", { ...fields, id: record.id, version: record.version, ...patch })).json();
  };
  expect((await update({})).success).toBe(true);
  expect(f.owners.get("one").records[0].recentActivity).toBe("开始检查");
  expect((await update({ version: first.version, recentActivity: "迟到更新" })).success).toBe(false);
  expect((await update({ recentActivity: "" })).success).toBe(true);
  const listed = await (await f.callback("list_module_owners", {})).json();
  expect(JSON.parse(listed.output)[0].recentActivity).toBe("");
});

it("validates template and arguments before deleting finished history", async () => {
  const f = await fixture(true);
  f.dataStore.saveTaskRun({ id: "history", templateId: "one", taskId: "task", status: "running", calledAt: 1, input: {}, output: "" });
  const query = { taskId: "task", id: "history" };
  expect(() => f.owners.deleteTaskRun("missing", query)).toThrow("来源会话模板不存在");
  expect(() => f.owners.deleteTaskRun("one", { ...query, extra: true })).toThrow();
  expect(() => f.owners.deleteTaskRun("one", query)).toThrow("不能删除");
  f.owners.deleteTaskRun("two", query);
  expect(f.owners.getTaskRun("one", query).status).toBe("running");
  f.dataStore.saveTaskRun({ ...f.owners.getTaskRun("one", query), status: "completed" });
  f.owners.deleteTaskRun("one", query); f.owners.deleteTaskRun("one", query);
  expect(f.owners.listTaskRuns("one", { taskId: "task" }).total).toBe(0);
});
