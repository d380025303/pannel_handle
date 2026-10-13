import http from "node:http";
import { execFile as nodeExecFile } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { MAX_REQUEST_BYTES, pipeWebStream, createResponsesChatCompletionsBridgeService } = require("./responses-chat-completions-bridge-service.cjs");
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
  it.each(["iterator", "reader"])("awaits asynchronous chunk processing for the %s stream API", async api => {
    let reads = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const read = async () => ++reads <= 2 ? { value: Buffer.from("chunk"), done: false } : { done: true };
    const releaseLock = vi.fn();
    const stream = api === "reader" ? { getReader: () => ({ read, releaseLock }) } : {
      async *[Symbol.asyncIterator]() {
        for (;;) { const next = await read(); if (next.done) return; yield next.value; }
      }
    };
    const piping = pipeWebStream(stream, () => gate);
    await vi.waitFor(() => expect(reads).toBe(1));
    release();
    await piping;
    expect(reads).toBe(3);
    if (api === "reader") expect(releaseLock).toHaveBeenCalledOnce();
  });

  it.each(["resume", "disconnect", "shutdown"])("bounds the HTTP queue while paused and exits on %s", async action => {
    let reads = 0;
    let exited = false;
    let upstreamSignal;
    let bridgeResponse;
    let peakPausedQueue = 0;
    let paused = true;
    const originalWrite = http.ServerResponse.prototype.write;
    const write = vi.spyOn(http.ServerResponse.prototype, "write").mockImplementation(function (...args) {
      const result = originalWrite.apply(this, args);
      bridgeResponse = this;
      if (paused) peakPausedQueue = Math.max(peakPausedQueue, this.writableLength);
      return result;
    });
    const text = "x".repeat(16 * 1024);
    const service = createService(async (_url, { signal }) => {
      upstreamSignal = signal;
      return { ok: true, body: {
        async *[Symbol.asyncIterator]() {
          try {
            for (let index = 0; index < 256; index++) {
              reads++;
              yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
              await new Promise(resolve => setImmediate(resolve));
            }
            yield Buffer.from("data: [DONE]\n\n");
          } finally { exited = true; }
        }
      } };
    });
    const launch = await service.getLaunchConfig({ type: "windows" }, { apiKey: "secret", model: "model-a" });
    let incoming;
    const client = http.request(`${launch.baseUrl}/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${launch.apiKey}`, "Content-Type": "application/json" }
    }, response => { incoming = response; response.pause(); });
    client.on("error", () => {});
    client.end(JSON.stringify({ model: "model-a", input: "hello", stream: true }));
    try {
      await vi.waitFor(() => {
        expect(incoming).toBeDefined();
        expect(bridgeResponse?.writableNeedDrain).toBe(true);
      });
      const stalledReads = reads;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(reads).toBe(stalledReads);
      expect(reads).toBeLessThan(256);
      expect(peakPausedQueue).toBeLessThan(128 * 1024);
      console.info(`HTTP backpressure (${action}): ${reads}/256 chunks read, peak paused queue ${peakPausedQueue} bytes`);
      paused = false;
      if (action === "resume") {
        const chunks = [];
        const completed = new Promise((resolve, reject) => {
          incoming.on("data", chunk => chunks.push(chunk));
          incoming.once("end", resolve);
          incoming.once("error", reject);
        });
        incoming.resume();
        await completed;
        const events = Buffer.concat(chunks).toString().split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
        expect(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""))
          .toBe(text.repeat(256));
        expect(events.at(-1).type).toBe("response.completed");
        expect(exited).toBe(true);
      } else {
        if (action === "disconnect") client.destroy();
        else { const closing = service.shutdown(); incoming.resume(); await closing; }
        await vi.waitFor(() => {
          expect(upstreamSignal.aborted).toBe(true);
          expect(exited).toBe(true);
        }, { timeout: 1000 });
        expect(reads).toBe(stalledReads);
      }
      expect(bridgeResponse.listenerCount("drain")).toBe(0);
    } finally {
      client.destroy();
      write.mockRestore();
    }
  }, 10000);

  it.each(["localhost", "route"])("keeps timers responsive during a slow WSL %s probe", async phase => {
    let probeFinished = false;
    let timerBeforeProbe = false;
    let timer;
    const execFile = vi.fn((_file, args, options, callback) => {
      if (phase === "route" && args[3] === "bash") {
        callback(new Error("Localhost unavailable"), "");
        return;
      }
      timer = setTimeout(() => { timerBeforeProbe = !probeFinished; }, 10);
      return nodeExecFile(process.execPath, ["-e", "setTimeout(() => process.stdout.write('127.0.0.2'), 350)"], options, (error, stdout) => {
        probeFinished = true;
        callback(error, stdout);
      });
    });
    const service = createService(vi.fn(), { execFile });
    try {
      const launch = await service.getLaunchConfig({ type: "wsl", wslDistro: "Ubuntu" }, { apiKey: "secret", model: "model-a" });
      expect(timerBeforeProbe).toBe(true);
      expect(new URL(launch.baseUrl).hostname).toBe(phase === "localhost" ? "127.0.0.1" : "127.0.0.2");
      expect(execFile).toHaveBeenCalledTimes(phase === "localhost" ? 1 : 2);
      expect(execFile.mock.calls[0].slice(0, 3)).toEqual([
        "wsl.exe",
        ["-d", "Ubuntu", "--", "bash", "-lc", expect.stringMatching(/^timeout 2 bash -c '<\/dev\/tcp\/127\.0\.0\.1\/\d+'$/)],
        { encoding: "utf-8", windowsHide: true, timeout: 5000 }
      ]);
      if (phase === "route") {
        expect(execFile.mock.calls[1].slice(0, 3)).toEqual([
          "wsl.exe", ["-d", "Ubuntu", "--", "sh", "-lc", "ip route show default | awk '{print $3; exit}'"],
          { encoding: "utf-8", windowsHide: true, timeout: 10000 }
        ]);
      }
    } finally {
      clearTimeout(timer);
    }
  });

  it("falls back to the route after a localhost timeout", async () => {
    const execFile = vi.fn((_file, args, _options, callback) => {
      callback(args[3] === "bash" ? Object.assign(new Error("Timed out"), { killed: true, signal: "SIGTERM" }) : null, "127.0.0.2\n");
    });
    const service = createService(vi.fn(), { execFile });
    const launch = await service.getLaunchConfig({ type: "wsl", wslDistro: "Ubuntu" }, { apiKey: "secret", model: "model-a" });
    expect(new URL(launch.baseUrl).hostname).toBe("127.0.0.2");
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it.each(["timeout", "exit", "invalid", "empty"])("rejects an unusable WSL route (%s)", async failure => {
    const execFile = vi.fn((_file, args, _options, callback) => {
      if (args[3] === "bash") return callback(new Error("Localhost unavailable"), "");
      const error = failure === "timeout" ? Object.assign(new Error("Timed out"), { killed: true, signal: "SIGTERM" })
        : failure === "exit" ? Object.assign(new Error("Nonzero exit"), { code: 1 }) : null;
      callback(error, failure === "invalid" ? "not-an-address" : failure === "empty" ? "" : "127.0.0.2");
    });
    const service = createService(vi.fn(), { execFile });
    await expect(service.getLaunchConfig({ type: "wsl", wslDistro: "Ubuntu" }, { apiKey: "secret", model: "model-a" }))
      .rejects.toThrow("无法确定 WSL 到 NaraRouter 桥的 Windows 主机地址。");
  });

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
