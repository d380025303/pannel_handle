import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { MODEL_VERIFICATION_RATE_LIMIT_COOLDOWN_MS, MODEL_VERIFICATION_TTL_MS, buildCodexModelCatalog, buildVerificationRequest, createOpenRouterService, parseVerificationStream } = require("./openrouter-service.cjs");
const dirs = [];

function completedResponse() {
  return new Response('data: {"type":"response.completed"}\n', { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function fixture(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pannel-openrouter-service-"));
  dirs.push(dir);
  const model = { id: "openai/gpt-test", name: "GPT Test", contextLength: 128000, inputModalities: ["text"], supportedParameters: ["tools", "tool_choice"], compatible: true };
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
    const fetchImpl = vi.fn(async url => new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), { status: 200 }));
    const { service, store, catalogFile } = fixture({
      fetchImpl,
      serviceOptions: {
        providerId: "nararouter",
        providerName: "NaraRouter",
        baseUrl: "https://router.bynara.id/v1",
        apiKeyEnv: "NARAROUTER_API_KEY",
        modelsRequireApiKey: true,
        connectionTestPath: "/models",
        verificationHeaders: {}
      }
    });

    await service.refreshModels();
    expect(fetchImpl).toHaveBeenCalledWith("https://router.bynara.id/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-secret" })
    }));
    expect(store.setCachedModels).toHaveBeenCalledWith([{ id: "gpt-test" }], 100000);

    const launch = await service.getLaunchConfig({ type: "windows", agentProvider: "codex", codexBackend: "nararouter" });
    expect(launch).toMatchObject({ providerId: "nararouter", providerName: "NaraRouter", apiKeyEnv: "NARAROUTER_API_KEY", catalogPath: catalogFile });
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

  it("keeps favorites unchanged when any verification fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "provider unavailable" } }), { status: 500 }));
    const { service, store } = fixture({ fetchImpl, verifications: {} });
    await expect(service.setFavorites({ favoriteModelIds: ["openai/gpt-test"], defaultModelId: "openai/gpt-test" })).rejects.toThrow("provider unavailable");
    expect(store.setFavorites).not.toHaveBeenCalled();
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
