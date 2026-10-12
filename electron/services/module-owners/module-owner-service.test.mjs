import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createModuleOwnerService, CALLBACK_PATH } = require("./module-owner-service.cjs");
const { createSessionApiService } = require("../session-api/session-api-service.cjs");
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
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
  const dataStore = withHistory ? createBusinessDataStore({ userData }).open() : undefined;
  let api;
  const owners = createModuleOwnerService({ userData, dataStore, sessionStore: { getTemplate: id => templates.find(value => value.id === id), getLibrary: () => templates },
    terminalManager: { getSession: id => sessions.get(id) }, graphicalService, getSessionApi: () => api });
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
    expect((await (await f.callback("update_module_owner", { ...fields, id: record.id, version: record.version, responsibilities: "AI 更新" })).json()).success).toBe(true);
    expect((await (await f.callback("delete_module_owner", { id: record.id, version: record.version })).json()).success).toBe(false);
    const current = f.owners.get("one").records[0];
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
  it("defaults off and stores one sanitized record with the matching final turn only", async () => {
    const f = await fixture(true);
    const owner = f.owners.mutate("one", { operation: "add", ...fields }).records[0];
    const task = f.owners.saveTask("one", scheduled(owner.id))[0];
    expect(task.recordHistory).toBe(false);
    await due(f);
    await vi.waitFor(() => expect(f.owners.listTasks("one")[0].executedCount).toBe(1));
    expect(f.owners.listTaskRuns("one", { taskId: task.id }).total).toBe(0);
    f.end({ sessionId: "run", threadId: "thread", turnId: "turn", status: "completed", output: "unrecorded" });
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
    f.end({ sessionId: "run", threadId: "thread", turnId: "other", status: "completed", output: "wrong" });
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
