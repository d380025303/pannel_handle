import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const { createOpenCodeFormTransport } = require("./form-transport.cjs");

let server;
let transport;
afterEach(async () => {
  transport?.close();
  transport = null;
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
});

describe("OpenCode Form transport", () => {
  it("authenticates, lists pending forms, replies, cancels, and receives SSE", async () => {
    const requests = [];
    server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ method: request.method, path: request.url, auth: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8") });
        if (request.url === "/api/event") {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.write('data: {"type":"form.created","data":{"id":"form-1","sessionID":"thread"}}\n\n');
        } else if (request.method === "GET") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end('{"data":[{"id":"form-1"}]}');
        } else { response.writeHead(204); response.end(); }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    transport = createOpenCodeFormTransport({ port: server.address().port, password: "secret" });
    expect(await transport.list("thread")).toEqual([{ id: "form-1" }]);
    await transport.reply("thread", "form-1", { plan: ["a"] });
    await transport.cancel("thread", "form-1");
    const onEvent = vi.fn();
    transport.subscribe(onEvent);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: "form.created",
      data: { id: "form-1", sessionID: "thread" } }));
    expect(requests.map(request => [request.method, request.path])).toEqual([
      ["GET", "/api/session/thread/form"], ["POST", "/api/session/thread/form/form-1/reply"],
      ["DELETE", "/api/session/thread/form/form-1"], ["GET", "/api/event"]
    ]);
    expect(JSON.parse(requests[1].body)).toEqual({ answer: { plan: ["a"] } });
    expect(requests.every(request => request.auth === `Basic ${Buffer.from("opencode:secret").toString("base64")}`)).toBe(true);
  });
});
