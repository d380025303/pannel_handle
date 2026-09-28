import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { MODEL_VERIFICATION_RATE_LIMIT_COOLDOWN_MS, MODEL_VERIFICATION_TTL_MS, buildCodexModelCatalog, buildVerificationRequest, buildChatBridgeVerificationRequest, validateChatBridgeVerification, createOpenRouterService, parseVerificationStream } = require("./openrouter-service.cjs");
const dirs = [];

function completedResponse() {
  return new Response('data: {"type":"response.completed"}\n', { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function fixture(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pannel-openrouter-service-"));
  dirs.push(dir);
  const model = overrides.model || { id: "openai/gpt-test", name: "GPT Test", contextLength: 128000, inputModalities: ["text"], supportedParameters: ["tools", "tool_choice"], compatible: true };
  let verifications = overrides.verifications === undefined
    ? { [model.id]: { status: "passed", checkedAt: 100000 } }
    : { ...overrides.verifications };
  const store = {
    getPublicConfig: vi.fn(() => ({ hasApiKey: true, favoriteModelIds: [model.id], defaultModelId: model.id })),
    getCachedModels: vi.fn(() => [model]),
    getApiKey: vi.fn(() => "sk-secret"),
    getModelVerifications: vi.fn(() => ({ ...verifications })),
    setModelVerification: vi.fn((id, verification) => {
      verifications[id] = { ...verification };
      return { ...verification };
    }),
    setFavorites: vi.fn((favoriteModelIds, defaultModelId) => ({ hasApiKey: true, favoriteModelIds, defaultModelId })),
    setCachedModels: vi.fn(models => models),
    setApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    ...overrides.store
  };
  const spawnSync = overrides.spawnSync || vi.fn(() => ({ status: 0, stdout: "supported" }));
  const fetchImpl = overrides.fetchImpl || vi.fn(async () => completedResponse());
  const catalogFile = path.join(dir, "catalog.json");
  return { service: createOpenRouterService({ store, catalogFile, spawnSync, fetchImpl, now: overrides.now || (() => 100000), verificationTimeoutMs: overrides.verificationTimeoutMs, ...overrides.serviceOptions }), store, spawnSync, fetchImpl, catalogFile, model };
}

describe("openrouter-service", () => {
  it("requires the target Agent's own verification before releasing its launch key", () => {
    const verification = { opencode: {}, codebuddy: {} };
    const { service, store, model } = fixture({ store: { getAgentModelVerifications: vi.fn(agent => verification[agent]) } });
    expect(() => service.getAgentLaunchConfig("opencode", model.id)).toThrow("尚未通过 OpenCode 验证");
    verification.opencode[model.id] = { status: "passed", checkedAt: Date.now() };
    expect(service.getAgentLaunchConfig("opencode", model.id)).toMatchObject({ apiKey: "sk-secret", model: model.id });
    expect(() => service.getAgentLaunchConfig("codebuddy", model.id)).toThrow("尚未通过 CodeBuddy 验证");
    expect(store.getApiKey).toHaveBeenCalledTimes(1);
  });
  it("generates a Codex catalog from favorite models", () => {
    const catalog = buildCodexModelCatalog([{ id: "vendor/model", name: "Model", contextLength: 64000, inputModalities: ["video", "image", "text", "file"], supportedParameters: [] }]);
    expect(catalog.models[0]).toMatchObject({ slug: "vendor/model", context_window: 64000, input_modalities: ["text", "image"], shell_type: "shell_command" });
  });

  it("falls back to text when OpenRouter exposes only unsupported modalities", () => {
    const catalog = buildCodexModelCatalog([{ id: "vendor/video", name: "Video", inputModalities: ["video"], supportedParameters: [] }]);
    expect(catalog.models[0].input_modalities).toEqual(["text"]);
  });

  it("returns a Windows launch config while keeping the key out of the catalog", async () => {
    const { service, catalogFile } = fixture();
    const launch = await service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "openrouter" });
    expect(launch).toMatchObject({ apiKey: "sk-secret", apiKeyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-test", catalogPath: catalogFile });
    expect(readFileSync(catalogFile, "utf-8")).not.toContain("sk-secret");
  });

  it("supports an authenticated NaraRouter catalog and isolated launch provider", async () => {
    const fetchImpl = vi.fn(async url => {
      if (url.endsWith("/plans")) return new Response(JSON.stringify({ data: [{ code: "free", models: ["gpt-test"] }] }), { status: 200 });
      if (url.endsWith("/pricing")) return new Response(JSON.stringify({ data: [{ alias: "gpt-test", input_credit_per_1k: 2, output_credit_per_1k: 6 }], usd_to_idr: 20000 }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 });
    });
    const { service, store, catalogFile } = fixture({
      fetchImpl,
      serviceOptions: {
        providerId: "nararouter",
        providerName: "NaraRouter",
        baseUrl: "https://router.bynara.id/v1",
        apiKeyEnv: "NARAROUTER_API_KEY",
        modelsRequireApiKey: true,
        connectionTestPath: "/models",
        verificationHeaders: {},
        metadataBaseUrl: "https://router.bynara.id/api"
      }
    });

    await service.refreshModels();
    expect(fetchImpl).toHaveBeenCalledWith("https://router.bynara.id/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-secret" })
    }));
    expect(fetchImpl).toHaveBeenCalledWith("https://router.bynara.id/api/plans", { headers: { Accept: "application/json" } });
    expect(fetchImpl).toHaveBeenCalledWith("https://router.bynara.id/api/pricing", { headers: { Accept: "application/json" } });
    expect(store.setCachedModels).toHaveBeenCalledWith([{
      id: "gpt-test",
      freeTierEligible: true,
      pricing: { prompt: expect.any(String), completion: expect.any(String) }
    }], 100000);
    const [cachedModels] = store.setCachedModels.mock.calls[0];
    expect(Number(cachedModels[0].pricing.prompt)).toBeCloseTo(0.0000001, 12);
    expect(Number(cachedModels[0].pricing.completion)).toBeCloseTo(0.0000003, 12);
    expect(JSON.stringify(fetchImpl.mock.calls.filter(([url]) => !url.endsWith("/models")))).not.toContain("sk-secret");

    const launch = await service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "nararouter" });
    expect(launch).toMatchObject({ providerId: "nararouter", providerName: "NaraRouter", apiKeyEnv: "NARAROUTER_API_KEY", catalogPath: catalogFile });
  });

  it("keeps the old NaraRouter cache when metadata refresh fails", async () => {
    const fetchImpl = vi.fn(async url => {
      if (url.endsWith("/pricing")) return new Response(JSON.stringify({ message: "pricing unavailable" }), { status: 503 });
      if (url.endsWith("/plans")) return new Response(JSON.stringify({ data: [{ code: "free", models: [] }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 });
    });
    const { service, store } = fixture({
      fetchImpl,
      serviceOptions: {
        providerName: "NaraRouter",
        baseUrl: "https://router.bynara.id/v1",
        modelsRequireApiKey: true,
        metadataBaseUrl: "https://router.bynara.id/api"
      }
    });

    await expect(service.refreshModels()).rejects.toThrow("pricing unavailable");
    expect(store.setCachedModels).not.toHaveBeenCalled();
  });

  it("converts the generated catalog path for WSL", async () => {
    const spawnSync = vi.fn((command, args) => String(args).includes("wslpath")
      ? { status: 0, stdout: "/mnt/c/catalog.json\n" }
      : { status: 0, stdout: "supported" });
    const { service } = fixture({ spawnSync });
    expect((await service.getLaunchConfig({ type: "wsl", wslDistro: "Ubuntu", agentProvider: "codex", codexBackend: "openrouter" })).catalogPath).toBe("/mnt/c/catalog.json");
  });

  it("rejects SSH and Codex installations without custom catalog support", async () => {
    const { service } = fixture({ spawnSync: vi.fn(() => ({ status: 1 })) });
    await expect(service.getLaunchConfig({ type: "ssh", agentProvider: "codex", codexBackend: "openrouter" })).rejects.toThrow("Windows 和 WSL");
    await expect(service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "openrouter" })).rejects.toThrow("升级 Codex");
  });

  it("builds a streaming Codex-shaped verification request", () => {
    expect(buildVerificationRequest({ id: "vendor/model", supportedParameters: ["reasoning", "tools", "tool_choice"] })).toMatchObject({
      model: "vendor/model",
      stream: true,
      store: false,
      reasoning: { effort: "medium", summary: "auto" },
      tools: [{ type: "function" }, { type: "custom" }]
    });
    expect(buildVerificationRequest({ id: "vendor/model" }, "responses")).not.toHaveProperty("tools");
    expect(buildVerificationRequest({ id: "vendor/model" }, "function_tools").tools).toEqual([expect.objectContaining({ type: "function" })]);
  });

  it("accepts only completed Responses streams", () => {
    expect(() => parseVerificationStream('data: {"type":"response.completed"}\n')).not.toThrow();
    expect(() => parseVerificationStream('data: {"type":"error","message":"upstream failed"}\n')).toThrow("upstream failed");
    expect(() => parseVerificationStream('data: {"type":"response.created"}\n')).toThrow("完成前断开");
  });

  it("keeps structured metadata from Responses stream failures", () => {
    try {
      parseVerificationStream('data: {"type":"response.failed","response":{"error":{"type":"rate_limited","message":"Retry later","request_id":"req-stream"}}}\n');
      throw new Error("Expected the stream parser to fail");
    } catch (error) {
      expect(error).toMatchObject({ message: "Retry later", responseStreamFailure: true, errorCode: "rate_limited", requestId: "req-stream" });
    }
  });

  it("records an HTTP failure without exposing the API key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), { status: 500 }));
    const { service, store } = fixture({ fetchImpl, verifications: {} });
    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });
    expect(result).toMatchObject({ modelId: "openai/gpt-test", status: "unavailable", failedStage: "codex_tools", errorKind: "provider", error: expect.stringContaining("HTTP 500") });
    expect(result.error).toContain("Internal Server Error");
    expect(JSON.stringify(store.setModelVerification.mock.calls)).not.toContain("sk-secret");
  });

  it("reuses fresh passes and rechecks stale passes", async () => {
    const fresh = fixture();
    expect((await fresh.service.verifyModels({ modelIds: [fresh.model.id] }))[0].status).toBe("passed");
    expect(fresh.fetchImpl).not.toHaveBeenCalled();

    const stale = fixture({ verifications: { "openai/gpt-test": { status: "passed", checkedAt: 1 } }, now: () => MODEL_VERIFICATION_TTL_MS + 2 });
    expect((await stale.service.verifyModels({ modelIds: [stale.model.id] }))[0].status).toBe("passed");
    expect(stale.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("marks a model partial when Responses and function tools pass but the full Codex protocol is rejected", async () => {
    const responses = [
      new Response(JSON.stringify({ error: { message: "Provider returned error", code: "provider_error", metadata: { provider_name: "Nvidia", raw: { error: { message: "custom tools are unsupported" } } } } }), { status: 400, headers: { "x-request-id": "req-123" } }),
      completedResponse()
    ];
    const fetchImpl = vi.fn(async () => responses.shift());
    const { service } = fixture({ fetchImpl, verifications: {} });

    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });

    expect(result).toMatchObject({
      status: "partial",
      failedStage: "codex_tools",
      errorKind: "unsupported",
      httpStatus: 400,
      errorCode: "provider_error",
      provider: "Nvidia",
      requestId: "req-123",
      error: expect.stringContaining("custom tools are unsupported")
    });
    expect(result.stages.map(stage => [stage.stage, stage.status])).toEqual([
      ["function_tools", "passed"],
      ["codex_tools", "failed"]
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks a model partial when a successful SSE connection reports a Codex tool rejection", async () => {
    const rejected = new Response('data: {"type":"response.failed","response":{"error":{"message":"The model rejected this request. It may not support the input you sent or a parameter is invalid."}}}\n\ndata: [DONE]\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(completedResponse());
    const { service } = fixture({ fetchImpl, verifications: {} });

    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });

    expect(result).toMatchObject({
      status: "partial",
      failedStage: "codex_tools",
      errorKind: "unknown",
      error: expect.stringContaining("model rejected this request")
    });
    expect(result.stages.map(stage => [stage.stage, stage.status])).toEqual([
      ["function_tools", "passed"],
      ["codex_tools", "failed"]
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not downgrade a streamed rate limit to partial compatibility", async () => {
    const fetchImpl = vi.fn(async () => new Response('data: {"type":"error","error":{"type":"rate_limited","message":"Rate limit exceeded","request_id":"req-rate"}}\n\ndata: [DONE]\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const { service } = fixture({ fetchImpl, verifications: {} });

    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });

    expect(result).toMatchObject({
      status: "unavailable",
      failedStage: "codex_tools",
      errorKind: "rate_limit",
      errorCode: "rate_limited",
      requestId: "req-rate"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a free model partially compatible when function tools pass before the full Codex probe is rate limited", async () => {
    const model = { id: "z-ai/glm-5.2:free", name: "GLM 5.2 Free", contextLength: 256000, inputModalities: ["text"], supportedParameters: ["tools", "tool_choice"], compatible: true };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(completedResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Provider returned error", code: 429, metadata: { provider_name: "Decart" } } }), { status: 429, headers: { "x-request-id": "req-free-rate" } }));
    const { service, store } = fixture({ fetchImpl, model, verifications: {} });

    const [result] = await service.verifyModels({ modelIds: [model.id] });

    expect(result).toMatchObject({
      status: "partial",
      failedStage: "codex_tools",
      errorKind: "rate_limit",
      httpStatus: 429,
      provider: "Decart",
      requestId: "req-free-rate"
    });
    expect(result.stages.map(stage => [stage.stage, stage.status])).toEqual([
      ["function_tools", "passed"],
      ["codex_tools", "failed"]
    ]);
    expect(fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body).tools?.map(tool => tool.type))).toEqual([
      ["function"],
      ["function", "custom"]
    ]);
    expect(store.setModelVerification).toHaveBeenCalledWith(model.id, expect.objectContaining({ status: "partial", errorKind: "rate_limit" }));
  });

  it("reports a NaraRouter bad_request from the injected Chat Completions bridge", async () => {
    const fetchImpl = vi.fn();
    const responsesTransport = vi.fn(async () => new Response('data: {"type":"response.failed","response":{"error":{"type":"bad_request","message":"The model rejected this request.","request_id":"req-nara"}}}\n\ndata: [DONE]\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const { service } = fixture({
      fetchImpl,
      verifications: {},
      serviceOptions: { providerName: "NaraRouter", baseUrl: "https://router.bynara.id/v1", responsesTransport, verificationRequestBuilder: buildChatBridgeVerificationRequest, verificationResultValidator: validateChatBridgeVerification, verificationStrategy: "all" }
    });

    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });

    expect(result).toMatchObject({
      status: "failed",
      failedStage: "responses",
      errorKind: "unsupported",
      errorCode: "bad_request",
      requestId: "req-nara",
      error: "The model rejected this request."
    });
    expect(result.stages.map(stage => [stage.stage, stage.status])).toEqual([["responses", "failed"]]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(responsesTransport).toHaveBeenCalledTimes(1);
    expect(responsesTransport.mock.calls.every(([input]) => input.body.stream === true && input.body.store === false)).toBe(true);
  });

  it("requires text, function, tool search, and custom tool checks through the NaraRouter bridge", async () => {
    const responsesTransport = vi.fn(async ({ body }) => {
      let output;
      if (!body.tool_choice) output = [{ type: "message", content: [{ type: "output_text", text: "OK" }] }];
      else if (body.tool_choice.type === "tool_search") output = [{ type: "tool_search_call", execution: "client", arguments: { query: "MCP tools" } }];
      else if (body.tool_choice.type === "custom") output = [{ type: "custom_tool_call", name: "codex_probe_custom", input: "OK" }];
      else output = [{ type: "function_call", name: "mcp__codex_probe__echo", arguments: '{"value":"OK"}' }];
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { service } = fixture({
      verifications: {},
      serviceOptions: { providerName: "NaraRouter", responsesTransport, verificationRequestBuilder: buildChatBridgeVerificationRequest, verificationResultValidator: validateChatBridgeVerification, verificationStrategy: "all" }
    });

    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });
    expect(result.status).toBe("passed");
    expect(result.stages.map(stage => stage.stage)).toEqual(["responses", "function_tools", "codex_tools"]);
    expect(responsesTransport).toHaveBeenCalledTimes(4);
  });

  it("passes a verified NaraRouter launch through the bridge adapter", async () => {
    const launchAdapter = vi.fn(async (_session, config) => ({ ...config, apiKey: "bridge-token", apiKeyEnv: "PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY", baseUrl: "http://127.0.0.1:4321/v1", registrationId: "launch-1" }));
    const model = { id: "openai/gpt-test", name: "GPT Test", contextLength: 128000, inputModalities: ["text", "image"], supportedParameters: ["tools", "tool_choice", "reasoning"], compatible: true };
    const { service } = fixture({ model, serviceOptions: { providerId: "nararouter", providerName: "NaraRouter", launchAdapter, catalogCapabilities: { textOnly: true, reasoningSummaries: false } } });
    const result = await service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "nararouter", codexModel: "openai/gpt-test" });

    expect(result).toMatchObject({ apiKey: "bridge-token", apiKeyEnv: "PANNEL_HANDLE_NARAROUTER_BRIDGE_KEY", baseUrl: "http://127.0.0.1:4321/v1", registrationId: "launch-1" });
    expect(launchAdapter).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ apiKey: "sk-secret", baseUrl: "https://openrouter.ai/api/v1" }));
    expect(JSON.parse(readFileSync(result.catalogPath, "utf-8")).models[0]).toMatchObject({ input_modalities: ["text"], supports_reasoning_summaries: false });
  });

  it("checks basic Responses only when both Codex and function tools are unsupported", async () => {
    const unsupported = message => new Response(JSON.stringify({ error: { message } }), { status: 400 });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(unsupported("custom tools unsupported"))
      .mockResolvedValueOnce(unsupported("function tools unsupported"))
      .mockResolvedValueOnce(completedResponse());
    const { service } = fixture({ fetchImpl, verifications: {} });

    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });

    expect(result).toMatchObject({ status: "failed", failedStage: "function_tools", errorKind: "unsupported" });
    expect(result.stages.map(stage => [stage.stage, stage.status])).toEqual([
      ["responses", "passed"],
      ["function_tools", "failed"],
      ["codex_tools", "failed"]
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("allows a partial model to be saved and launched only after per-session acknowledgement", async () => {
    const partial = {
      status: "partial",
      checkedAt: 100000,
      failedStage: "codex_tools",
      error: "custom tools are unsupported",
      errorKind: "unsupported",
      stages: [
        { stage: "responses", status: "passed" },
        { stage: "function_tools", status: "passed" },
        { stage: "codex_tools", status: "failed", error: "custom tools are unsupported", errorKind: "unsupported" }
      ]
    };
    const { service, store } = fixture({ verifications: { "openai/gpt-test": partial } });

    await expect(service.setFavorites({ favoriteModelIds: ["openai/gpt-test"], defaultModelId: "openai/gpt-test" })).resolves.toMatchObject({ defaultModelId: "openai/gpt-test" });
    expect(store.setFavorites).toHaveBeenCalled();
    await expect(service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "openrouter", codexModel: "openai/gpt-test" })).rejects.toThrow("确认实验风险");
    await expect(service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "openrouter", codexModel: "openai/gpt-test", codexExperimentalAcknowledged: true })).resolves.toMatchObject({ model: "openai/gpt-test" });
  });

  it("allows shared favorites independently of Codex verification", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "provider unavailable" } }), { status: 500 }));
    const { service, store } = fixture({ fetchImpl, verifications: {} });
    await expect(service.setFavorites({ favoriteModelIds: ["openai/gpt-test"], defaultModelId: "openai/gpt-test" })).resolves.toMatchObject({ defaultModelId: "openai/gpt-test" });
    expect(store.setFavorites).toHaveBeenCalled();
  });

  it("blocks launch when the selected model fails verification", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), { status: 500 }));
    const { service, spawnSync } = fixture({ fetchImpl, verifications: {} });
    await expect(service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "openrouter" })).rejects.toThrow("未通过 Codex 兼容性检测");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("cools down rate-limited probes without retrying or replacing a fresh pass", async () => {
    let currentTime = 100000;
    const rateLimited = () => new Response(JSON.stringify({ error: { message: "Rate exceeded" } }), { status: 429 });
    const fetchImpl = vi.fn(async () => rateLimited());
    const { service, store } = fixture({ fetchImpl, now: () => currentTime });

    const [first] = await service.verifyModels({ modelIds: ["openai/gpt-test"], force: true });
    const [cooledDown] = await service.verifyModels({ modelIds: ["openai/gpt-test"], force: true });

    expect(first).toMatchObject({ status: "unavailable", errorKind: "rate_limit", httpStatus: 429 });
    expect(cooledDown).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.setModelVerification).not.toHaveBeenCalled();
    await expect(service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "openrouter" })).resolves.toMatchObject({ model: "openai/gpt-test" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentTime += MODEL_VERIFICATION_RATE_LIMIT_COOLDOWN_MS + 1;
    await service.verifyModels({ modelIds: ["openai/gpt-test"], force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("persists an initial rate limit and suppresses repeated probes during cooldown", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Rate exceeded" } }), { status: 429 }));
    const { service, store } = fixture({ fetchImpl, verifications: {} });

    const [first] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });
    const [second] = await service.verifyModels({ modelIds: ["openai/gpt-test"], force: true });

    expect(first).toMatchObject({ status: "unavailable", errorKind: "rate_limit", httpStatus: 429 });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.setModelVerification).toHaveBeenCalledTimes(1);
  });

  it("aborts a compatibility probe after the configured timeout", async () => {
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const { service } = fixture({ fetchImpl, verifications: {}, verificationTimeoutMs: 5 });
    const [result] = await service.verifyModels({ modelIds: ["openai/gpt-test"] });
    expect(result).toMatchObject({ status: "unavailable", failedStage: "codex_tools", errorKind: "timeout", error: "OpenRouter 模型验证超时（1 秒）。" });
  });
});
