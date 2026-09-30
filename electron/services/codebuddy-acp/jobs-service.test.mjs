import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import http from "node:http";

const { createCodeBuddyJobsService } = createRequire(import.meta.url)("./jobs-service.cjs");
const { createCodeBuddyHttpTransport } = createRequire(import.meta.url)("./http-transport.cjs");
const { createGraphicalSessionRouter } = createRequire(import.meta.url)("./session-router.cjs");
const { buildInvocation } = createRequire(import.meta.url)("./session-service.cjs");

function fixture() {
  const calls = [];
  const streams = new Map();
  const stopped = vi.fn();
  const broadcasts = [];
  const child = new EventEmitter();
  const jobs = [{ id: "own", cwd: "C:\\work", name: "Review", status: "waiting" },
    { id: "foreign", cwd: "C:\\other", name: "Other" }];
  const transport = {
    rest: vi.fn(async (method, route, body) => {
      calls.push({ method, route, body });
      if (route.startsWith("/api/v1/jobs?")) return { data: { jobs } };
      if (route.startsWith("/api/v1/jobs/resumable?")) return { data: { candidates: [
        { sessionId: "history", label: "Prior task" }, { sessionId: "elsewhere", cwd: "C:\\other" }] } };
      if (route.endsWith("/transcript")) return { data: { sessionId: "thread", updates: [] } };
      if (route.includes("/dispatch-context")) return { data: { agents: [{ name: "cli" }] } };
      if (method === "DELETE") return { data: { deleted: false, reason: "worktree in use" } };
      return { data: { ok: true } };
    }),
    subscribeRest: vi.fn((route, onEvent) => {
      streams.set(route, onEvent);
      return () => streams.delete(route);
    }),
    close: vi.fn(async () => {})
  };
  const service = createCodeBuddyJobsService({
    spawnProcess: vi.fn(() => child), resolveHttpEndpoint: vi.fn(async () => ({ endpoint: "http://127.0.0.1:1234", password: "secret" })),
    httpTransportFactory: vi.fn(() => transport), buildInvocation: vi.fn(() => ({ executable: "codebuddy", args: [], cwd: "C:\\work", env: {} })),
    stopAgentChild: stopped, broadcast: (name, payload) => broadcasts.push({ name, payload })
  });
  const context = { session: { id: "run", type: "windows", cwd: "C:\\work" }, runtime: {}, environment: {}, cwd: "C:\\work" };
  return { service, context, calls, streams, stopped, broadcasts, transport };
}

describe("CodeBuddy background jobs", () => {
  it("starts a separate authenticated Windows gateway without an ACP conversation", () => {
    const invocation = buildInvocation({ id: "run", type: "windows", cwd: "C:\\work", shell: "powershell.exe" },
      { jobsGateway: true }, {}, "codebuddy");
    expect(invocation.args.join(" ")).toContain("codebuddy --serve --auth password");
    expect(invocation.args.join(" ")).not.toContain("--acp");
    expect(invocation.env.CODEBUDDY_GATEWAY_AUTH).toBe("password");
  });

  it("routes Jobs only to CodeBuddy sessions", () => {
    const buddy = { listJobs: vi.fn(() => ["job"]) };
    const router = createGraphicalSessionRouter({}, buddy, { getSession: id => ({ agentProvider: id === "buddy" ? "codebuddy" : "codex" }) });
    expect(router.listJobs("buddy")).toEqual(["job"]);
    expect(buddy.listJobs).toHaveBeenCalledWith("buddy");
    expect(() => router.listJobs("codex")).toThrow("仅 CodeBuddy");
  });

  it("uses authenticated public REST and parses named SSE events", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ path: req.url, authorization: req.headers.authorization, guard: req.headers["x-codebuddy-request"] });
      if (req.url === "/api/v1/jobs/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: changed\ndata: {"id":"own"}\n\n');
      } else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":{"jobs":[]}}'); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const transport = createCodeBuddyHttpTransport({ endpoint: `http://127.0.0.1:${server.address().port}`, password: "secret" });
    try {
      expect(await transport.rest("GET", "/api/v1/jobs?all=1")).toEqual({ data: { jobs: [] } });
      const event = await new Promise((resolve, reject) => {
        const cancel = transport.subscribeRest("/api/v1/jobs/events", value => { cancel(); resolve(value); }, reject);
      });
      expect(event).toEqual({ type: "changed", data: { id: "own" } });
      expect(seen).toHaveLength(2);
      expect(seen.every(item => item.authorization === "Bearer secret" && item.guard === "1")).toBe(true);
    } finally {
      await transport.close();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it("keeps one project gateway alive across requests and scopes operations to the project", async () => {
    const { service, context, calls, stopped, transport } = fixture();
    expect((await service.list(context)).map(job => job.id)).toEqual(["own"]);
    expect(await service.dispatchContext(context)).toEqual({ agents: [{ name: "cli" }] });
    await service.dispatch(context, { prompt: "Check tests", permissionMode: "default" });
    expect(calls.find(call => call.method === "POST" && call.route === "/api/v1/jobs")?.body).toEqual({
      prompt: "Check tests", cwd: "C:\\work", permissionMode: "default" });
    expect((await service.resumable(context)).map(item => item.sessionId)).toEqual(["history"]);
    await service.resume(context, "history");
    await expect(service.resume(context, "elsewhere")).rejects.toThrow("当前项目");
    await expect(service.action(context, "foreign", "stop")).rejects.toThrow("当前项目");
    await expect(service.action(context, "own", "delete")).rejects.toThrow("worktree in use");
    expect(stopped).not.toHaveBeenCalled();
    service.shutdown();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("forwards job and transcript SSE events and closes the selected stream", async () => {
    const { service, context, streams, broadcasts } = fixture();
    await service.list(context);
    streams.get("/api/v1/jobs/events")({ type: "changed", data: { id: "own" } });
    await service.watch(context, "own");
    streams.get("/api/v1/jobs/own/stream")({ type: "message", data: { sessionUpdate: "agent_message_chunk" } });
    expect(broadcasts).toMatchObject([
      { name: "codebuddy-jobs:event", payload: { cwd: "C:\\work", type: "changed" } },
      { name: "codebuddy-jobs:transcript", payload: { cwd: "C:\\work", jobId: "own", reset: true } },
      { name: "codebuddy-jobs:transcript", payload: { cwd: "C:\\work", jobId: "own" } }
    ]);
    await service.unwatch(context, "own");
    expect(streams.has("/api/v1/jobs/own/stream")).toBe(false);
    service.shutdown();
  });
});
