import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSessionStatusServer, workState } = require("./session-status-server.cjs");
const active = [];

function setup(sessions = []) {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-mcp-"));
  const terminalManager = {
    listSessions: () => sessions,
    getSession: id => sessions.find(item => item.id === id)
  };
  const service = createSessionStatusServer({ userData, terminalManager, port: 0,
    graphicalService: { snapshot: () => ({ busy: false, items: [{ type: "agentMessage", text: "完成任务" }] }) },
    stateHub: { getText: async () => "最近命令\n输出结果" } });
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
  it("maps connection and approval states to stable values", () => {
    expect(workState({ status: "重连中" })).toBe("reconnecting");
    expect(workState({ status: "待确认", detail: "等待授权" })).toBe("waiting_for_permission");
    expect(workState({ status: "待确认", detail: "需要用户输入" })).toBe("waiting_for_input");
    expect(workState({ status: "待确认", detail: "等待确认计划" })).toBe("waiting_for_plan");
    expect(workState({ status: "空闲" }, { status: "waiting_for_permission" })).toBe("waiting_for_permission");
    expect(workState({ status: "错误" })).toBe("failed");
  });
  it("starts only after opt in and serves read-only session tools", async () => {
    const sessions = [{ id: "run-1", title: "Work", templateId: "saved-1", type: "windows", runtimeMode: "terminal", agentProvider: "codex" }];
    const { service, userData } = setup(sessions);
    expect(service.status().enabled).toBe(false);
    await service.setEnabled(true);
    expect(service.status().running).toBe(true);
    const token = service.revealToken();
    expect(readFileSync(path.join(userData, "session-status-mcp.json"), "utf8")).toContain(token);
    expect((await rpc(service, token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } })).status).toBe(200);
    const tools = await result(await rpc(service, token, "tools/list", {}));
    expect(tools.result.tools.map(item => item.name)).toEqual(["list_session_instances", "get_session_instance_status"]);
    const listed = await result(await rpc(service, token, "tools/call", { name: "list_session_instances", arguments: {} }));
    expect(JSON.parse(listed.result.content[0].text).sessions).toMatchObject([{ sessionId: "run-1", workState: "running", summary: "输出结果" }]);
    const single = await result(await rpc(service, token, "tools/call", { name: "get_session_instance_status", arguments: { sessionId: "run-1" } }));
    expect(JSON.parse(single.result.content[0].text)).toMatchObject({ sessionId: "run-1", templateId: "saved-1" });
    sessions.splice(0);
    const missing = await result(await rpc(service, token, "tools/call", { name: "get_session_instance_status", arguments: { sessionId: "run-1" } }));
    expect(missing.result.isError).toBe(true);
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
