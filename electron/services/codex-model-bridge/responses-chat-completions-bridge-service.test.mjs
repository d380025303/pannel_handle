import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { MAX_REQUEST_BYTES, createResponsesChatCompletionsBridgeService } = require("./responses-chat-completions-bridge-service.cjs");
const services = [];

afterEach(async () => {
  while (services.length) await services.pop().shutdown();
});

function createService(fetchImpl, options = {}) {
  const service = createResponsesChatCompletionsBridgeService({
    providerId: "nararouter",
    providerName: "NaraRouter",
    upstreamUrl: "https://router.bynara.id/v1/chat/completions",
    apiKeyEnv: "PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY",
    ignoredToolTypes: ["web_search", "web_search_preview"],
    fetchImpl,
    ...options
  });
  services.push(service);
  return service;
}

describe("Responses Chat Completions bridge", () => {
  it.each(["stream", "fetch", "error body"])("cancels a pending upstream %s and ends the client on shutdown", async phase => {
    let upstreamSignal;
    let releaseUpstream;
    const service = createService(async (_url, { signal }) => {
      upstreamSignal = signal;
      const pending = () => new Promise((_resolve, reject) => {
        releaseUpstream = () => reject(new Error("Test cleanup"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (phase === "fetch") return pending();
      if (phase === "error body") {
        return { ok: false, status: 429, headers: new Headers(), text: pending };
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
          releaseUpstream = () => controller.error(new Error("Test cleanup"));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        }
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "secret", model: "model-a" });
    let clientEnded = false;
    let receivedChunk = false;
    const client = http.request(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" }
    }, response => {
      response.on("data", () => { receivedChunk = true; });
      response.on("end", () => { clientEnded = true; });
    });
    client.on("error", () => {});
    client.end(JSON.stringify({ model: "model-a", input: "hello", stream: true }));
    try {
      await vi.waitFor(() => {
        expect(releaseUpstream).toBeTypeOf("function");
        if (phase === "stream") expect(receivedChunk).toBe(true);
      });
      expect(upstreamSignal.aborted).toBe(false);
      const shutdown = service.shutdown();
      expect(service.shutdown()).toBe(shutdown);
      let closed = false;
      void shutdown.then(() => { closed = true; });
      await vi.waitFor(() => {
        expect(upstreamSignal.aborted).toBe(true);
        expect(clientEnded).toBe(true);
        expect(closed).toBe(true);
      }, { timeout: 1000 });
      await shutdown;
    } finally {
      client.destroy();
      if (!upstreamSignal?.aborted) releaseUpstream?.();
    }
  });

  it("shares a listener across concurrent launches and closes it on shutdown", async () => {
    const service = createService(vi.fn());
    const launches = await Promise.all(Array.from({ length: 8 }, () => service.getLaunchConfig(
      { type: "windows" }, { apiKey: "secret", model: "model-a" }
    )));
    const origins = new Set(launches.map(launch => new URL(launch.baseUrl).origin));
    expect(origins.size).toBe(1);

    await service.shutdown();
    await expect(fetch(`${[...origins][0]}/health`)).rejects.toThrow();
  });

  it("returns HTTP 413 when the request body exceeds the limit", async () => {
    const service = createService(vi.fn());
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "secret", model: "model-a" });
    const response = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-a", input: "x".repeat(MAX_REQUEST_BYTES) })
    });

    expect(response.status).toBe(413);
    expect((await response.json()).error.message).toContain("请求正文过大");
  });

  it("keeps the provider key in the main process and converts both streaming directions", async () => {
    const fetchImpl = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }, choices: [] })}`,
      "data: [DONE]",
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const service = createService(fetchImpl);
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "sk-nry-secret", model: "model-a", catalogPath: "C:\\catalog.json", providerId: "nararouter", providerName: "NaraRouter" });

    expect(launch.apiKey).not.toBe("sk-nry-secret");
    expect(launch.apiKeyEnv).toBe("PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY");
    const response = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-a", stream: true, store: false, input: "hello" })
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain('"type":"response.completed"');
    expect(responseText).toContain('"input_tokens":4');
    expect(fetchImpl).toHaveBeenCalledWith("https://router.bynara.id/v1/chat/completions", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-nry-secret" })
    }));
    const chatBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(chatBody).toMatchObject({ model: "model-a", stream: true, messages: [{ role: "user", content: "hello" }] });
  });

  it("isolates registrations by model and invalidates the token on disconnect", async () => {
    const service = createService(vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })));
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "secret", model: "allowed" });
    service.bindSession("session-1", launch.registrationId);

    const wrongModel = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "other", stream: true, input: "hello" })
    });
    expect(wrongModel.status).toBe(400);

    service.disconnect("session-1");
    const expired = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "allowed", stream: true, input: "hello" })
    });
    expect(expired.status).toBe(401);
  });

  it("preserves upstream HTTP errors for provider diagnostics", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { type: "telegram_required", message: "Relink your account", request_id: "req-nara" } }), { status: 403, headers: { "content-type": "application/json" } }));
    const service = createService(fetchImpl);
    const response = await service.fetchResponses({ apiKey: "secret", body: { model: "model-a", input: "hello", stream: true } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { type: "telegram_required", message: "Relink your account", request_id: "req-nara" } });
  });

  it("aborts a pending upstream error body when the HTTP client disconnects", async () => {
    let upstreamSignal;
    let rejectBody;
    let bodyStarted = false;
    let bodyExited = false;
    const service = createService(async (_url, { signal }) => {
      upstreamSignal = signal;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "content-type": "application/json" }),
        async text() {
          bodyStarted = true;
          try {
            return await new Promise((_resolve, reject) => {
              rejectBody = reject;
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          } finally {
            bodyExited = true;
          }
        }
      };
    });
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "secret", model: "model-a" });
    const client = http.request(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" }
    });
    client.on("error", () => {});
    client.end(JSON.stringify({ model: "model-a", input: "hello", stream: true }));
    try {
      await vi.waitFor(() => expect(bodyStarted).toBe(true));
      expect(upstreamSignal.aborted).toBe(false);
      client.destroy();
      await vi.waitFor(() => {
        expect(upstreamSignal.aborted).toBe(true);
        expect(bodyExited).toBe(true);
      });
    } finally {
      client.destroy();
      rejectBody?.(new Error("Test cleanup"));
    }
  });

  it("preserves a completed upstream 429 body and diagnostic headers", async () => {
    const payload = '{"error":{"message":"Rate limit exceeded"}}';
    const service = createService(async () => new Response(payload, {
      status: 429,
      headers: { "content-type": "application/json", "x-request-id": "req-rate-limit" }
    }));
    const response = await service.fetchResponses({ apiKey: "secret", body: { model: "model-a", input: "hello" } });
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("req-rate-limit");
    expect(await response.text()).toBe(payload);
  });

  it("accepts an explicit finish_reason when the provider omits [DONE]", async () => {
    const fetchImpl = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const service = createService(fetchImpl, { allowFinishReasonAsDone: true });

    const response = await service.fetchResponses({ apiKey: "secret", body: { model: "model-a", input: "hello", stream: true } });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain('"type":"response.completed"');
    expect(responseText).not.toContain('"type":"response.failed"');
  });

  it.each([
    [false, "length"], [true, "length"],
    [false, "stop"], [true, "stop"],
    [false, "tool_calls"], [true, "tool_calls"]
  ])("returns the correct terminal status over HTTP (omit DONE: %s, reason: %s)", async (omitDone, finishReason) => {
    const truncated = finishReason === "length";
    const argumentsText = truncated ? '{"input":"truncated' : '{"input":"complete"}';
    const fetchImpl = vi.fn(async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "echo", arguments: argumentsText } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}`,
      ...(omitDone ? [] : ["data: [DONE]"]), ""
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const service = createService(fetchImpl, { allowFinishReasonAsDone: omitDone });
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "secret", model: "model-a" });
    const response = await fetch(`${launch.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-a", input: "hello", stream: true })
    });
    expect(response.status).toBe(200);
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
    const status = truncated ? "incomplete" : "completed";
    expect(events.at(-1)).toMatchObject({ type: `response.${status}`, response: { status, output: [{ type: "function_call", status, arguments: argumentsText }] } });
    expect(events.find(event => event.type === "response.output_item.done").item.status).toBe(status);
    if (truncated) {
      expect(events.at(-1).response.incomplete_details).toEqual({ reason: "max_output_tokens" });
      expect(events.some(event => event.type === "response.completed")).toBe(false);
    }
  });

  it.each(["web_search", "web_search_preview"])("ignores unsupported %s tools while preserving function tools", async webToolType => {
    const fetchImpl = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    const service = createService(fetchImpl);
    const response = await service.fetchResponses({
      apiKey: "secret",
      body: {
        model: "model-a",
        input: "hello",
        tools: [
          { type: webToolType, external_web_access: true },
          { type: "function", name: "exec_command", parameters: { type: "object" } }
        ]
      }
    });

    expect(response.status).toBe(200);
    const chatBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(chatBody.tools).toHaveLength(1);
    expect(chatBody.tools[0]).toMatchObject({ type: "function", function: { description: expect.stringContaining("exec_command") } });
  });

  it("rejects requests that explicitly force the ignored web search tool", async () => {
    const fetchImpl = vi.fn();
    const service = createService(fetchImpl);
    const response = await service.fetchResponses({
      apiKey: "secret",
      body: {
        model: "model-a",
        input: "search",
        tools: [{ type: "web_search" }],
        tool_choice: { type: "web_search" }
      }
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("tool_choice is not supported");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
