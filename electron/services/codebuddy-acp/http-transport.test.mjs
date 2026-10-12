import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { parseStartupLine, waitForEndpoint, createCodeBuddyHttpTransport } = require("./http-transport.cjs");

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe("CodeBuddy HTTP ACP transport", () => {
  it("confirms the outgoing prompt without waiting for the HTTP response to finish", async () => {
    let finishResponse;
    let received;
    const accepted = new Promise(resolve => { received = resolve; });
    const server = http.createServer((req, res) => {
      req.resume(); req.on("end", () => {
        finishResponse = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: 1, result: {} })); };
        received();
      });
    });
    servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const transport = createCodeBuddyHttpTransport({ endpoint: `http://127.0.0.1:${server.address().port}`, password: "secret" });
    let sent;
    const submitted = new Promise(resolve => { sent = resolve; });
    let completed = false;
    const pending = transport.send({ id: 1, method: "session/prompt", params: {} }, { onSent: sent }).then(() => { completed = true; });
    try {
      await submitted; await accepted;
      expect(completed).toBe(false);
      finishResponse(); await pending;
    } finally { await transport.close(); }
  });
  it("binds scheduled task routes to the authenticated session", async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, guard: req.headers["x-codebuddy-request"], body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
      if (req.method === "DELETE") { res.writeHead(204); res.end(); }
      else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { tasks: [] } })); }
    });
    servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const transport = createCodeBuddyHttpTransport({ endpoint: `http://127.0.0.1:${server.address().port}`, password: "secret" });
    await transport.scheduledTasksRequest("GET", "thread /?");
    await transport.scheduledTasksRequest("POST", "thread", null, { sessionId: "foreign", prompt: "Check" });
    await transport.scheduledTasksRequest("DELETE", "thread", "task /?");
    expect(seen[0].path).toBe("/api/v1/scheduled-tasks?sessionId=thread%20%2F%3F");
    expect(seen[1].body.sessionId).toBe("thread");
    expect(seen[2].path).toBe("/api/v1/scheduled-tasks/task%20%2F%3F?sessionId=thread");
    expect(seen.every(item => item.auth === "Bearer secret" && item.guard === "1")).toBe(true);
    expect(() => transport.scheduledTasksRequest("PATCH", "thread", "task")).toThrow("不支持");
    await transport.close();
  });
  it("limits plugin requests to the authenticated plugin API", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, guard: req.headers["x-codebuddy-request"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ name: "example" }] }));
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const transport = createCodeBuddyHttpTransport({ endpoint: `http://127.0.0.1:${server.address().port}`, password: "secret" });
    await expect(transport.pluginRequest("GET", "/api/v1/plugins/marketplaces")).resolves.toEqual({ data: [{ name: "example" }] });
    expect(() => transport.pluginRequest("GET", "/internal/file-changes/diff")).toThrow("不支持");
    expect(seen).toEqual([{ method: "GET", path: "/api/v1/plugins/marketplaces", authorization: "Bearer secret", guard: "1" }]);
    await transport.close();
  });
  it("reads only loopback startup endpoints and the in-memory password", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const pending = waitForEndpoint(child, { timeoutMs: 500 });
    child.stdout.emit("data", Buffer.from("  Endpoint  http://127.0.0.1:12345\n"));
    child.stderr.emit("data", Buffer.from("  Password  secret\n"));
    const result = await pending;
    expect(result.endpoint.href).toBe("http://127.0.0.1:12345/");
    expect(result.password).toBe("secret");
    expect(() => parseStartupLine("Endpoint http://0.0.0.0:1", {})).toThrow("回环");
  });

  it("connects, receives GET and POST SSE messages, answers JSON requests, and disconnects", async () => {
    const seen = [];
    const teamMessages = [];
    const renamed = [];
    let subscription;
    const server = http.createServer(async (req, res) => {
      seen.push({ method: req.method, path: req.url, headers: req.headers });
      if (req.url === "/api/v1/acp/connect") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ connectionId: "conn-1", sessionToken: "token-1" }));
      } else if (req.method === "GET") {
        subscription = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(":ok\n\n");
      } else if (req.method === "POST") {
        const parts = [];
        for await (const part of req) parts.push(part);
        const message = JSON.parse(Buffer.concat(parts).toString());
        if (req.url === "/api/v1/team/messages/send") {
          teamMessages.push(message);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } else if (req.url.startsWith("/api/v1/sessions/") && req.url.endsWith("/rename")) {
          renamed.push({ path: req.url, body: message });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { name: message.name } }));
        } else if (message.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }));
        } else {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "one" } })}\n\n`);
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n\n`);
        }
      } else if (req.method === "DELETE") { res.writeHead(200); res.end(); }
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const transport = createCodeBuddyHttpTransport({ endpoint: `http://127.0.0.1:${server.address().port}`, password: "secret" });
    const messages = [];
    transport.on("message", message => messages.push(message));
    await transport.connect();
    subscription.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "push" } })}\n\n`);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await transport.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: {} });
    await transport.sendTeamMessage({ teamName: "design", recipient: "architect", message: { from: "user", text: "继续", timestamp: "2026-09-24T00:00:00Z" } });
    await transport.renameSession("old-thread", "New title");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(messages.map(message => message.params?.sessionId || message.id)).toEqual(["push", 1, "one", 2]);
    expect(teamMessages).toMatchObject([{ teamName: "design", recipient: "architect", message: { from: "user", text: "继续" } }]);
    expect(renamed).toEqual([{ path: "/api/v1/sessions/old-thread/rename", body: { name: "New title" } }]);
    expect(seen.slice(1).every(call => call.headers["acp-connection-id"] === "conn-1" && call.headers["acp-session-token"] === "token-1")).toBe(true);
    expect(seen.every(call => call.headers.authorization === "Bearer secret" && call.headers["x-codebuddy-request"] === "1")).toBe(true);
    await transport.close();
    expect(seen.at(-1).method).toBe("DELETE");
  });

  it("includes HTTP failure details while hiding the ACP password", async () => {
    const server = http.createServer((req, res) => {
      if (req.url.endsWith("/connect")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ connectionId: "conn-1" }));
      } else if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(":ok\n\n");
      } else if (req.method === "POST") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ error: { message: "额度不足，Password secret，请稍后重试", requestId: "req-429",
          resetAt: "2026-09-26 02:50:40 UTC+8" } }));
      } else { res.writeHead(200); res.end(); }
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const transport = createCodeBuddyHttpTransport({ endpoint: `http://127.0.0.1:${server.address().port}`, password: "secret" });
    await transport.connect();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "session/prompt" })).rejects.toThrow(/HTTP 429.*额度不足.*req-429.*2026-09-26.*Retry-After：60/);
    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "session/prompt" })).rejects.not.toThrow("secret");
    await transport.close();
  });
});
