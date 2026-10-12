import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
const require = createRequire(import.meta.url);
const { createSessionApiService } = require("./session-api-service.cjs");
const fixtures = [];
function fixture(queries = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-api-"));
  const instances = { listTemplates: vi.fn(() => ({ templates: [{ templateId: "saved" }] })), create: vi.fn(async () => ({ sessionId: "new", status: "started" })) };
  const service = createSessionApiService({ userData, instances, ...queries, defaultPort: 0 });
  fixtures.push({ service, userData });
  return { service, userData, instances };
}
async function call(service, endpoint, options = {}) {
  return fetch(service.status().url + endpoint, { ...options, headers: { Authorization: `Bearer ${service.revealToken()}`, ...options.headers } });
}
async function incompleteRequest(service) {
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(new URL(service.status().url).port) });
  socket.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", data => {
        if (!data.toString().startsWith("HTTP/1.1 100 Continue")) return reject(new Error("Expected request headers to be accepted"));
        socket.write("{", resolve);
      });
      socket.once("connect", () => socket.write([
        "POST /api/v1/session-instances HTTP/1.1", "Host: localhost",
        `Authorization: Bearer ${service.revealToken()}`, "Content-Type: application/json",
        "Content-Length: 100", "Expect: 100-continue", "", "",
      ].join("\r\n")));
    });
    return socket;
  } catch (err) { socket.destroy(); throw err; }
}
async function withinStopDeadline(operation) {
  let timeout;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Service transition exceeded 2500 ms")), 2500);
    })]);
  } finally { clearTimeout(timeout); }
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service.stop(); rmSync(f.userData, { recursive: true, force: true }); } });
describe("session HTTP API", () => {
  it.each(["stop", "disable", "port"])("bounds %s with an incomplete authenticated request and releases queued configuration", async action => {
    const f = fixture(); await f.service.configure({ enabled: true });
    const oldPort = Number(new URL(f.service.status().url).port);
    const target = fixture(); await target.service.configure({ enabled: true });
    const newPort = Number(new URL(target.service.status().url).port);
    await target.service.stop();
    const socket = await incompleteRequest(f.service);
    const closed = new Promise(resolve => socket.once("close", resolve));
    try {
      const operation = action === "stop" ? f.service.stop()
        : f.service.configure(action === "disable" ? { enabled: false } : { port: newPort });
      const queued = action === "stop" ? null : f.service.configure({ enabled: true });
      const result = await withinStopDeadline(operation);
      if (action === "disable") expect(result).toMatchObject({ enabled: false, running: false });
      await withinStopDeadline(closed);
      if (action === "port") {
        expect(f.service.status()).toMatchObject({ running: true, port: newPort });
        expect(newPort).not.toBe(oldPort);
        expect((await f.service.invoke({ operation: "list" })).status).toBe(200);
      } else if (action === "stop") expect(f.service.status().running).toBe(false);
      if (queued) await withinStopDeadline(queued);
      else await withinStopDeadline(f.service.configure({ enabled: true }));
      expect((await f.service.invoke({ operation: "list" })).status).toBe(200);
      expect(f.instances.create).not.toHaveBeenCalled();
    } finally { socket.destroy(); }
  });
  it("correlates identical zero-tool bodies to their own private lifecycle hooks", async () => {
    const f = fixture(); await f.service.configure({ enabled: true });
    const received = [];
    f.instances.create.mockImplementation(async (_body, hooks) => {
      received.push(hooks);
      hooks.onSessionCreated({ id: `session-${received.length}` });
      return { sessionId: `session-${received.length}`, status: "started" };
    });
    const one = { onSessionCreated: vi.fn() }; const two = { onSessionCreated: vi.fn() };
    const body = { templateId: "saved", mode: "default", prompt: "相同内容" };
    await Promise.all([f.service.invoke({ operation: "create", body }, one), f.service.invoke({ operation: "create", body }, two)]);
    expect(one.onSessionCreated).toHaveBeenCalledTimes(1); expect(two.onSessionCreated).toHaveBeenCalledTimes(1);
    expect(one.onSessionCreated.mock.calls[0][0].id).not.toBe(two.onSessionCreated.mock.calls[0][0].id);
    const invalid = await call(f.service, "/api/v1/session-instances", { method: "POST", headers: { "Content-Type": "application/json", "X-Pannel-Creation-Id": "unknown" }, body: JSON.stringify(body) });
    expect(invalid.status).toBe(409); expect(f.instances.create).toHaveBeenCalledTimes(2);
    expect(body).toEqual({ templateId: "saved", mode: "default", prompt: "相同内容" });
  });
  it("queries live instances over HTTP independently of MCP and handles errors", async () => {
    const { createSessionStatusServer } = require("../mcp/session-status-server.cjs");
    const sessions = [{ id: "run /中文", title: "Work", type: "windows", runtimeMode: "terminal" }];
    let status;
    const f = fixture({ listInstances: () => status.listInstances(), getInstanceStatus: id => status.getInstanceStatus(id) });
    status = createSessionStatusServer({ userData: f.userData,
      terminalManager: { listSessions: () => sessions, getSession: id => sessions.find(item => item.id === id) },
      stateHub: { getText: async () => "output" } });
    expect(status.status().enabled).toBe(false);
    await f.service.configure({ enabled: true });
    const list = await f.service.invoke({ operation: "listInstances" });
    expect(list).toMatchObject({ status: 200, body: { sessions: [{ sessionId: "run /中文" }] } });
    const single = await f.service.invoke({ operation: "getInstanceStatus", sessionId: "run /中文" });
    expect(single.status).toBe(200);
    expect(single.body).toMatchObject({ ...list.body.sessions[0], queriedAt: expect.any(Number) });
    expect(single.body).toMatchObject({ ...(await status.getInstanceStatus("run /中文")), queriedAt: expect.any(Number) });
    expect((await call(f.service, "/api/v1/session-instances/%ZZ")).status).toBe(400);
    expect((await call(f.service, "/api/v1/session-instances/run", { method: "POST" })).status).toBe(405);
    expect((await call(f.service, "/api/v1/session-instances", { method: "DELETE" })).status).toBe(405);
    expect((await call(f.service, "/api/v1/session-instances", { headers: { Authorization: "Bearer bad" } })).status).toBe(401);
    expect((await call(f.service, "/api/v1/session-instances/run", { headers: { Origin: "https://example.com" } })).status).toBe(403);
    await expect(f.service.invoke({ operation: "getInstanceStatus", sessionId: " " })).rejects.toThrow();
    sessions.splice(0);
    expect(await f.service.invoke({ operation: "listInstances" })).toMatchObject({ status: 200, body: { sessions: [] } });
    expect(await f.service.invoke({ operation: "getInstanceStatus", sessionId: "run /中文" })).toMatchObject({ status: 404, body: { error: { code: "session_not_found" } } });
  });
  it("accepts injected tools through authenticated HTTP and validates paired configuration", async () => {
    const f = fixture(); await f.service.configure({ enabled: true });
    const body = { templateId: "saved", mode: "plan", prompt: "task",
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
      toolCallback: { url: "http://localhost/tools", bearerToken: "callback-token" } };
    expect((await f.service.invoke({ operation: "create", body })).status).toBe(201);
    expect(f.instances.create).toHaveBeenCalledWith({ ...body, toolCallback: { ...body.toolCallback, timeoutMs: 60000 } });
    expect((await f.service.invoke({ operation: "create", body: { ...body, toolCallback: undefined } })).status).toBe(400);
  });
  it("starts disabled, authenticates requests and invokes real HTTP routes", async () => {
    const f = fixture();
    expect(f.service.status().running).toBe(false);
    await expect(f.service.invoke({ operation: "list" })).rejects.toThrow();
    await f.service.configure({ enabled: true });
    expect((await fetch(f.service.status().url + "/api/v1/session-templates")).status).toBe(401);
    expect(await f.service.invoke({ operation: "list" })).toMatchObject({ status: 200, body: { templates: [{ templateId: "saved" }] } });
    expect(await f.service.invoke({ operation: "create", body: { templateId: "saved", agentProvider: "codebuddy", mode: "plan", prompt: " task " } })).toMatchObject({ status: 201, body: { sessionId: "new" } });
    expect(f.instances.create).toHaveBeenCalledWith({ templateId: "saved", agentProvider: "codebuddy", mode: "plan", prompt: "task" });
    expect(await f.service.invoke({ operation: "create", body: { templateId: "saved", mode: "plan", prompt: "task", modelSource: "native" } })).toMatchObject({ status: 400 });
    await expect(f.service.invoke({ operation: "anything" })).rejects.toThrow();
  });
  it("rejects invalid bodies, methods, origins and oversized requests before creating", async () => {
    const f = fixture(); await f.service.configure({ enabled: true });
    const post = body => call(f.service, "/api/v1/session-instances", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    for (const body of ["{", "null", JSON.stringify({ templateId: "saved", mode: "bad", prompt: "task" }), JSON.stringify({ templateId: "saved", mode: "plan", prompt: "task", extra: true })]) expect((await post(body)).status).toBe(400);
    expect((await post(JSON.stringify({ prompt: "x".repeat(256 * 1024) }))).status).toBe(413);
    expect((await call(f.service, "/api/v1/session-templates", { method: "POST" })).status).toBe(405);
    expect((await call(f.service, "/unknown")).status).toBe(404);
    expect((await call(f.service, "/api/v1/session-templates", { headers: { Origin: "https://example.com" } })).status).toBe(403);
    expect(f.instances.create).not.toHaveBeenCalled();
  });
  it("maps known failures and hides internal error details", async () => {
    const f = fixture(); await f.service.configure({ enabled: true });
    for (const statusCode of [404, 422, 500]) {
      f.instances.create.mockRejectedValueOnce(Object.assign(new Error("secret internal details"), { statusCode, apiCode: "test_error" }));
      const result = await f.service.invoke({ operation: "create", body: { templateId: "saved", mode: "plan", prompt: "task" } });
      expect(result.status).toBe(statusCode);
      if (statusCode === 500) expect(JSON.stringify(result.body)).not.toContain("secret");
    }
  });
  it("persists token and configuration, invalidates old tokens, and stops", async () => {
    const f = fixture(); await f.service.configure({ enabled: true });
    const port = new URL(f.service.status().url).port;
    await f.service.configure({ port: Number(port) });
    const oldToken = f.service.revealToken(); f.service.resetToken();
    expect((await call(f.service, "/api/v1/session-templates", { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    const reloaded = createSessionApiService({ userData: f.userData, instances: f.instances, defaultPort: 0 });
    expect(reloaded.revealToken()).toBe(f.service.revealToken());
    expect(reloaded.status().enabled).toBe(true);
    expect(reloaded.status().port).toBe(Number(port));
    await f.service.stop();
    fixtures.push({ service: reloaded, userData: f.userData });
    await reloaded.start();
    expect((await reloaded.invoke({ operation: "list" })).status).toBe(200);
    await reloaded.stop();
    await f.service.configure({ enabled: false }); expect(f.service.status().running).toBe(false);
    await expect(f.service.configure({ port: -1 })).rejects.toThrow();
  });
  it("reports occupied ports without switching ports", async () => {
    const occupied = http.createServer();
    await new Promise(resolve => occupied.listen(0, "0.0.0.0", resolve));
    try {
      const f = fixture(); const port = occupied.address().port;
      expect(await f.service.configure({ enabled: true, port })).toMatchObject({ running: false, enabled: true, port, error: "接口端口已被占用。" });
    } finally { await new Promise(resolve => occupied.close(resolve)); }
  });
});
