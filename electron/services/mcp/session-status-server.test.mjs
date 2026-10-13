import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSessionStatusServer, workState } = require("./session-status-server.cjs");
const { createSessionApiService } = require("../session-api/session-api-service.cjs");
const active = [];

function setup(sessions = [], dependencies = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-mcp-"));
  const terminalManager = {
    listSessions: () => sessions,
    getSession: id => sessions.find(item => item.id === id)
  };
  const service = createSessionStatusServer({ userData, terminalManager, port: 0,
    graphicalService: { snapshot: () => ({ busy: false, items: [{ type: "agentMessage", text: "完成任务" }] }) },
    stateHub: { getText: async () => "最近命令\n输出结果" }, ...dependencies });
  active.push({ service, userData });
  return { service, sessions, userData };
}

async function rpc(service, token, method, params, headers = {}) {
  return fetch(service.status().url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
}

async function result(response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find(line => line.startsWith("data: "));
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(text);
}

afterEach(async () => {
  for (const { service, userData } of active.splice(0)) {
    await service.stop();
    rmSync(userData, { recursive: true, force: true });
  }
});

describe("session status MCP server", () => {
  it("copies long histories once per session per query and refreshes subsequent queries", async () => {
    const sessions = ["first", "second"].map(id => ({ id, title: id, type: "windows", runtimeMode: "app-server", agentStatus: "completed" }));
    const items = Array.from({ length: 10000 }, () => ({ type: "agentMessage", text: "完成任务" }));
    const calls = [];
    let copiedReferences = 0;
    const graphicalService = { snapshot(id) {
      expect(this).toBe(graphicalService);
      calls.push(id);
      copiedReferences += items.length;
      return { busy: false, items: [...items] };
    } };
    const { service } = setup(sessions, { graphicalService });
    expect(await service.getInstanceStatus("first")).toMatchObject({ workState: "idle", summary: "完成任务" });
    expect(calls).toEqual(["first"]);
    expect(copiedReferences).toBe(10000);
    items.at(-1).text = "最新结果";
    expect((await service.listInstances()).sessions).toMatchObject([
      { sessionId: "first", workState: "idle", summary: "最新结果" },
      { sessionId: "second", workState: "idle", summary: "最新结果" }
    ]);
    expect(calls).toEqual(["first", "first", "second"]);
    expect(copiedReferences).toBe(30000);
  });

  it.each([
    [{ approvals: [{ params: { reason: "允许执行" } }] }, {}, "waiting_for_permission", "允许执行"],
    [{ questions: [{ params: { questions: [{ question: "请选择" }] } }] }, {}, "waiting_for_input", "请选择"],
    [{ pendingPlan: {} }, {}, "waiting_for_plan", "确认执行计划"],
    [{}, { type: "ssh", sshConnectionState: "reconnecting" }, "reconnecting", "完成任务"]
  ])("preserves graphical waiting and connection results for snapshot %j", async (pending, connection, workState, summary) => {
    let calls = 0;
    const { service } = setup([{ id: "graphical", runtimeMode: "app-server", agentStatus: "completed", ...connection }], {
      graphicalService: { snapshot: () => { calls++; return { items: [{ type: "agentMessage", text: "完成任务" }], ...pending }; } }
    });
    expect(await service.getInstanceStatus("graphical")).toMatchObject({ workState, summary });
    expect((await service.listInstances()).sessions[0]).toMatchObject({ workState, summary });
    expect(calls).toBe(2);
  });

  it.each(["missing", "throws"])("reads a %s snapshot at most once per query", async mode => {
    let calls = 0;
    const { service } = setup([{ id: "graphical", runtimeMode: "app-server", agentStatus: "completed" }], {
      graphicalService: { snapshot: () => { calls++; if (mode === "throws") throw new Error("unavailable"); } }
    });
    expect(await service.getInstanceStatus("graphical")).toMatchObject({ workState: "idle", summary: "暂无最近内容" });
    expect(calls).toBe(1);
    await service.listInstances();
    expect(calls).toBe(2);
  });

  it.each(["e_prompt", "completed", "running"])("prioritizes structured %s status while preserving connection and waiting states", status => {
    const agentStatus = { status };
    expect(workState({ status: "运行中" }, agentStatus)).toBe(status === "running" ? "running" : "idle");
    expect(workState({ status: "空闲" }, agentStatus)).toBe(status === "running" ? "running" : "idle");
    for (const [label, expected] of [["连接中", "connecting"], ["重连中", "reconnecting"], ["已断开", "disconnected"]]) {
      expect(workState({ status: label }, agentStatus)).toBe(expected);
    }
    for (const [detail, expected] of [["等待授权", "waiting_for_permission"], ["需要用户输入", "waiting_for_input"], ["等待确认计划", "waiting_for_plan"]]) {
      expect(workState({ status: "待确认", detail }, agentStatus)).toBe(expected);
    }
    for (const [pending, expected] of [
      [{ status: "waiting_for_permission" }, "waiting_for_permission"],
      [{ resolution: "provide_input" }, "waiting_for_input"],
      [{ eventName: "AppServerQuestion" }, "waiting_for_input"],
      [{ eventName: "AppServerPlanPending" }, "waiting_for_plan"]
    ]) {
      expect(workState({ status: "运行中" }, { ...agentStatus, ...pending })).toBe(expected);
    }
  });

  it.each(["cached", "session"])("reports terminal Agent states through HTTP and MCP using %s status", async source => {
    const session = { id: "terminal", title: "Agent", type: "windows", runtimeMode: "terminal" };
    const { service } = setup([session]);
    const userData = mkdtempSync(path.join(tmpdir(), "pannel-status-http-"));
    const api = createSessionApiService({ userData, defaultPort: 0,
      listInstances: () => service.listInstances(), getInstanceStatus: id => service.getInstanceStatus(id) });
    active.push({ service: api, userData });
    await service.setEnabled(true);
    await api.configure({ enabled: true });
    for (const [status, expected] of [["e_prompt", "idle"], ["completed", "idle"], ["running", "running"], ["failed", "failed"], ["waiting_for_permission", "waiting_for_permission"]]) {
      session.agentStatus = source === "cached" ? (status === "running" ? "completed" : "running") : status;
      if (source === "cached") service.handleDesktopEvent("agent:status", { id: session.id, status });
      for (const endpoint of ["/api/v1/session-instances", `/api/v1/session-instances/${session.id}`]) {
        const response = await fetch(api.status().url + endpoint, { headers: { Authorization: `Bearer ${api.revealToken()}` } });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect((body.sessions?.[0] || body).workState).toBe(expected);
      }
      for (const name of ["list_session_instances", "get_session_instance_status"]) {
        const response = await result(await rpc(service, service.revealToken(), "tools/call", {
          name, arguments: name === "get_session_instance_status" ? { sessionId: session.id } : {}
        }));
        const body = JSON.parse(response.result.content[0].text);
        expect((body.sessions?.[0] || body).workState).toBe(expected);
      }
    }
    service.handleDesktopEvent("agent:status", { id: session.id, status: "cleared" });
    session.agentStatus = "completed";
    expect(await service.getInstanceStatus(session.id)).toMatchObject({ workState: "idle" });
  });

  it("maps connection and approval states to stable values", () => {
    expect(workState({ status: "重连中" })).toBe("reconnecting");
    expect(workState({ status: "待确认", detail: "等待授权" })).toBe("waiting_for_permission");
    expect(workState({ status: "待确认", detail: "需要用户输入" })).toBe("waiting_for_input");
    expect(workState({ status: "待确认", detail: "等待确认计划" })).toBe("waiting_for_plan");
    expect(workState({ status: "空闲" }, { status: "waiting_for_permission" })).toBe("waiting_for_permission");
    expect(workState({ status: "错误" })).toBe("failed");
  });
  it("starts only after opt in and keeps the existing status tools", async () => {
    const sessions = [{ id: "run-1", title: "Work", templateId: "saved-1", type: "windows", runtimeMode: "terminal", agentProvider: "codex" }];
    const { service, userData } = setup(sessions);
    expect(service.status().enabled).toBe(false);
    await service.setEnabled(true);
    expect(service.status().running).toBe(true);
    const token = service.revealToken();
    expect(readFileSync(path.join(userData, "session-status-mcp.json"), "utf8")).toContain(token);
    expect((await rpc(service, token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } })).status).toBe(200);
    const tools = await result(await rpc(service, token, "tools/list", {}));
    expect(tools.result.tools.map(item => item.name)).toEqual(["list_session_instances", "get_session_instance_status", "list_session_templates", "create_session_instance"]);
    const listed = await result(await rpc(service, token, "tools/call", { name: "list_session_instances", arguments: {} }));
    expect(JSON.parse(listed.result.content[0].text).sessions).toMatchObject([{ sessionId: "run-1", workState: "running", summary: "输出结果" }]);
    const single = await result(await rpc(service, token, "tools/call", { name: "get_session_instance_status", arguments: { sessionId: "run-1" } }));
    expect(JSON.parse(single.result.content[0].text)).toMatchObject({ sessionId: "run-1", templateId: "saved-1" });
    sessions.splice(0);
    const missing = await result(await rpc(service, token, "tools/call", { name: "get_session_instance_status", arguments: { sessionId: "run-1" } }));
    expect(missing.result.isError).toBe(true);
  });

  it("queries Agent templates and creates a model-selected Plan instance over authenticated MCP", async () => {
    const template = { id: "saved", title: "Work", agentProvider: "codex", type: "windows", graphicalSessionEnabled: true };
    const sessions = [];
    let mode = "default"; let model = "old";
    let injectedTools;
    const { service } = setup(sessions, {
      sessionStore: { getLibrary: () => [{ id: "shell" }, template], getTemplate: id => id === "saved" ? template : undefined },
      agentSessionLauncher: { launchSession: async (source, options) => {
        injectedTools = options.injectedTools;
        const session = { ...source, id: "new", templateId: options.templateId, runtimeMode: "app-server" };
        sessions.push(session); return session;
      } },
      graphicalService: { snapshot: () => ({ threadId: "thread", mode, model, items: [] }),
        setModel: async (_id, value) => { model = value; }, setMode: async (_id, value) => { mode = value; }, submitStarted: async () => {} }
    });
    await service.setEnabled(true);
    const token = service.revealToken();
    const templates = await result(await rpc(service, token, "tools/call", { name: "list_session_templates", arguments: {} }));
    expect(JSON.parse(templates.result.content[0].text).templates.map(item => item.templateId)).toEqual(["saved"]);
    const created = await result(await rpc(service, token, "tools/call", { name: "create_session_instance",
      arguments: { templateId: "saved", agentProvider: "codebuddy", mode: "plan", prompt: "Plan this", modelId: "new-model" } }));
    expect(JSON.parse(created.result.content[0].text)).toMatchObject({ sessionId: "new", agentProvider: "codebuddy", mode: "plan", modelId: "new-model", status: "started" });
    const injection = { tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
      toolCallback: { url: "http://localhost/tools" } };
    const toolCreated = await result(await rpc(service, token, "tools/call", { name: "create_session_instance",
      arguments: { templateId: "saved", mode: "plan", prompt: "Lookup", ...injection } }));
    expect(JSON.parse(toolCreated.result.content[0].text)).toMatchObject({ status: "started" });
    expect(injectedTools).toEqual({ ...injection, toolCallback: { ...injection.toolCallback, timeoutMs: 60000 } });
    const removedSource = await result(await rpc(service, token, "tools/call", { name: "create_session_instance",
      arguments: { templateId: "saved", mode: "plan", prompt: "Work", modelSource: "native" } }));
    expect(removedSource.result?.isError || removedSource.error).toBeTruthy();
    const invalid = await result(await rpc(service, token, "tools/call", { name: "create_session_instance",
      arguments: { templateId: "saved", mode: "execute", prompt: "Work" } }));
    expect(invalid.result?.isError || invalid.error).toBeTruthy();
    const missing = await result(await rpc(service, token, "tools/call", { name: "create_session_instance",
      arguments: { templateId: "missing", mode: "default", prompt: "Work" } }));
    expect(missing.result.isError).toBe(true);
    expect(sessions).toHaveLength(2);
  });

  it("requires the token and rejects foreign origins", async () => {
    const { service } = setup();
    await service.setEnabled(true);
    expect((await rpc(service, "bad", "tools/list", {})).status).toBe(401);
    expect((await rpc(service, service.revealToken(), "tools/list", {}, { Origin: "http://evil.example" })).status).toBe(403);
    const empty = await result(await rpc(service, service.revealToken(), "tools/call", { name: "list_session_instances", arguments: {} }));
    expect(JSON.parse(empty.result.content[0].text).sessions).toEqual([]);
    await service.setEnabled(false);
    expect(service.status().running).toBe(false);
  });

  it.each(["disable", "stop"])("waits for a pending start before %s and can restart", async operation => {
    let listeningUrl;
    const { service, userData } = setup([], { broadcast: (_channel, state) => {
      if (state.running) listeningUrl = state.url;
    } });
    const starting = service.setEnabled(true);
    const stopping = operation === "disable" ? service.setEnabled(false) : service.stop();
    await Promise.all([starting, stopping]);
    expect(service.status()).toMatchObject({ enabled: operation === "stop", running: false });
    expect(listeningUrl).toBeTruthy();
    await expect(fetch(listeningUrl)).rejects.toThrow();
    expect(JSON.parse(readFileSync(path.join(userData, "session-status-mcp.json"), "utf8")).enabled).toBe(operation === "stop");

    await service.setEnabled(true);
    const response = await rpc(service, service.revealToken(), "tools/list", {});
    expect(response.status).toBe(200);
    expect((await result(response)).result.tools.map(item => item.name)).toContain("list_session_instances");
  });

  it("serializes repeated starts and enable changes in invocation order", async () => {
    const { service } = setup();
    await Promise.all([service.setEnabled(true), service.start(), service.setEnabled(false), service.setEnabled(true), service.start()]);
    expect(service.status()).toMatchObject({ enabled: true, running: true });
    const response = await rpc(service, service.revealToken(), "tools/list", {});
    expect(response.status).toBe(200);
    expect((await result(response)).result.tools).toHaveLength(4);
  });

  it("reports waiting states and trims summaries", async () => {
    const sessions = [{ id: "run-2", title: "Agent", type: "windows", runtimeMode: "app-server", agentProvider: "codex" }];
    const { service } = setup(sessions);
    service.handleDesktopEvent("agent:status", { id: "run-2", status: "waiting_for_permission", activitySummary: "a".repeat(220) });
    await service.setEnabled(true);
    const response = await result(await rpc(service, service.revealToken(), "tools/call", { name: "list_session_instances", arguments: {} }));
    expect(JSON.parse(response.result.content[0].text).sessions[0]).toMatchObject({ summary: "a".repeat(160) });
  });

  it("restores enabled settings and reports a fixed-port conflict", async () => {
    const { service, userData } = setup();
    await service.setEnabled(true);
    const port = new URL(service.status().url).port;
    const token = service.revealToken();
    const secondUserData = mkdtempSync(path.join(tmpdir(), "pannel-mcp-conflict-"));
    const second = createSessionStatusServer({ userData: secondUserData,
      terminalManager: { listSessions: () => [], getSession: () => undefined }, stateHub: {}, port: Number(port) });
    active.push({ service: second, userData: secondUserData });
    const conflict = await second.setEnabled(true);
    expect(conflict).toMatchObject({ enabled: true, running: false });
    expect(conflict.error).toContain("已被占用");
    await service.stop();
    const restored = createSessionStatusServer({ userData, terminalManager: { listSessions: () => [], getSession: () => undefined }, stateHub: {}, port: 0 });
    active.push({ service: restored, userData });
    expect(restored.status().enabled).toBe(true);
    expect(restored.revealToken()).toBe(token);
    await restored.start();
    expect(restored.status().running).toBe(true);
  });
});
