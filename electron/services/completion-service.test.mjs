import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { buildEndpoint, createCompletionService, extractCompletion } = require("./completion-service.cjs");

function createHarness(fetchApi, options = {}) {
  const configStore = {
    getConfig: vi.fn(() => ({ enabled: true, baseUrl: "https://example.test/v1/", model: "test-model", hasApiKey: true })),
    getCredentials: vi.fn(() => ({ apiKey: "secret" }))
  };
  return { service: createCompletionService({ configStore, fetchApi, ...options }), configStore };
}

function response(content = " world") {
  return {
    ok: true,
    status: 200,
    text: vi.fn(async () => JSON.stringify({ choices: [{ message: { content } }] }))
  };
}

describe("completion-service", () => {
  it("normalizes the endpoint", () => {
    expect(buildEndpoint("https://example.test/v1/")).toBe("https://example.test/v1/chat/completions");
  });

  it("sends only composer cursor context with authentication", async () => {
    const fetchApi = vi.fn(async () => response(" next"));
    const { service } = createHarness(fetchApi);
    await expect(service.complete({ sessionId: "s1", draft: "hello tail", cursor: 5 })).resolves.toEqual({ completion: " next" });
    const [url, options] = fetchApi.mock.calls[0];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer secret");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("test-model");
    expect(body.messages[1].content).toContain('"textBeforeCursor":"hello"');
    expect(body.messages[1].content).toContain('"textAfterCursor":" tail"');
    expect(options.body).not.toContain("recentTerminalOutput");
    expect(options.body).not.toContain("error\\noutput");
    expect(body.messages[0].content).toContain("补全用户正在编辑的输入");
    expect(body.messages[0].content).toContain("仅返回待插入文本");
  });

  it("rejects HTTP and malformed model responses", async () => {
    const failed = createHarness(vi.fn(async () => ({ ok: false, status: 401, text: vi.fn(async () => "denied") })));
    await expect(failed.service.complete({ sessionId: "s1", draft: "hello", cursor: 5 })).rejects.toThrow("HTTP 401");
    expect(() => extractCompletion({ choices: [] })).toThrow("无效");
  });

  it("removes Markdown fences and supports a disabled connection test", async () => {
    const fetchApi = vi.fn(async () => response("```text\nOK\n```"));
    const { service, configStore } = createHarness(fetchApi);
    configStore.getConfig.mockReturnValue({ enabled: false, baseUrl: "https://example.test/v1", model: "model", hasApiKey: true });
    await expect(service.testConnection()).resolves.toEqual({ ok: true });
  });

  it("aborts requests that exceed the timeout", async () => {
    const fetchApi = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const { service } = createHarness(fetchApi, { requestTimeoutMs: 5 });
    await expect(service.complete({ sessionId: "s1", draft: "hello", cursor: 5 })).rejects.toThrow("请求超时");
  });

  it("does not emit debug events when debug mode is disabled", async () => {
    const broadcastDebug = vi.fn();
    const { service } = createHarness(vi.fn(async () => response()), {
      isDebugEnabled: () => false,
      broadcastDebug
    });
    await service.complete({ sessionId: "s1", draft: "hello", cursor: 5 });
    expect(broadcastDebug).not.toHaveBeenCalled();
  });

  it("emits a redacted request and the raw successful response", async () => {
    const broadcastDebug = vi.fn();
    const { service } = createHarness(vi.fn(async () => response(" next")), {
      isDebugEnabled: () => true,
      broadcastDebug
    });
    await service.complete({ sessionId: "s1", draft: "hello", cursor: 5 });

    expect(broadcastDebug).toHaveBeenCalledTimes(2);
    const requestEvent = broadcastDebug.mock.calls[0][0];
    const responseEvent = broadcastDebug.mock.calls[1][0];
    expect(requestEvent).toMatchObject({ phase: "request", sessionId: "s1" });
    expect(requestEvent.request.body).toContain('"model":"test-model"');
    expect(JSON.stringify(requestEvent)).not.toContain("secret");
    expect(requestEvent.request.headers).not.toHaveProperty("Authorization");
    expect(responseEvent).toMatchObject({
      requestId: requestEvent.requestId,
      phase: "response",
      status: "success",
      httpStatus: 200,
      completion: " next"
    });
    expect(responseEvent.responseBody).toContain('"content":" next"');
  });

  it("emits HTTP, network, and timeout failures", async () => {
    const cases = [
      {
        fetchApi: vi.fn(async () => ({ ok: false, status: 429, text: vi.fn(async () => "rate limited") })),
        expectedPhase: "response",
        expectedError: "HTTP 429"
      },
      {
        fetchApi: vi.fn(async () => ({ ok: true, status: 200, text: vi.fn(async () => "not json") })),
        expectedPhase: "response",
        expectedError: "无效的 JSON"
      },
      {
        fetchApi: vi.fn(async () => { throw new Error("offline"); }),
        expectedPhase: "error",
        expectedError: "offline"
      },
      {
        fetchApi: vi.fn((_url, options) => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })),
        expectedPhase: "error",
        expectedError: "请求超时",
        requestTimeoutMs: 5
      }
    ];

    for (const item of cases) {
      const broadcastDebug = vi.fn();
      const { service } = createHarness(item.fetchApi, {
        requestTimeoutMs: item.requestTimeoutMs,
        isDebugEnabled: () => true,
        broadcastDebug
      });
      await expect(service.complete({ sessionId: "s1", draft: "hello", cursor: 5 })).rejects.toThrow(item.expectedError);
      expect(broadcastDebug.mock.calls.at(-1)[0]).toMatchObject({ phase: item.expectedPhase, status: "error" });
    }
  });

  it("does not emit debug events for connection tests", async () => {
    const broadcastDebug = vi.fn();
    const { service } = createHarness(vi.fn(async () => response("OK")), {
      isDebugEnabled: () => true,
      broadcastDebug
    });
    await service.testConnection();
    expect(broadcastDebug).not.toHaveBeenCalled();
  });
});
