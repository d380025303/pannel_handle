import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createOpenRouterConfigStore, normalizeModel } = require("./openrouter-config-store.cjs");
const dirs = [];

function createStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "pannel-openrouter-"));
  dirs.push(dir);
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(value => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn(value => value.toString().replace(/^encrypted:/, ""))
  };
  return { store: createOpenRouterConfigStore({ configFile: path.join(dir, "openrouter.json"), safeStorage }), configFile: path.join(dir, "openrouter.json") };
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe("openrouter-config-store", () => {
  it("keeps shared favorites when Codex is incompatible and tracks each Agent independently", () => {
    const { store, configFile } = createStore();
    store.setCachedModels([{ id: "vendor/model", name: "Model", supported_parameters: [] }]);
    expect(store.setFavorites(["vendor/model"], "vendor/model").favoriteModelIds).toEqual(["vendor/model"]);
    store.setAgentModelVerification("opencode", "vendor/model", { status: "passed" });
    store.setAgentModelVerification("codebuddy", "vendor/model", { status: "failed", error: "unsupported" });
    expect(store.getAgentModelVerifications("opencode")["vendor/model"].status).toBe("passed");
    const reloaded = createOpenRouterConfigStore({ configFile, safeStorage: { isEncryptionAvailable: () => true } });
    reloaded.load();
    expect(reloaded.getAgentModelVerifications("codebuddy")["vendor/model"].error).toBe("unsupported");
    store.setApiKey("new-key");
    expect(store.getAgentModelVerifications("opencode")).toEqual({});
  });
  it("filters OpenRouter-only modalities before caching models", () => {
    expect(normalizeModel({
      id: "vendor/multimodal",
      architecture: { input_modalities: ["video", "image", "audio", "text", "file"] }
    }).inputModalities).toEqual(["text", "image", "audio"]);
    expect(normalizeModel({ id: "vendor/video", architecture: { input_modalities: ["video"] } }).inputModalities).toEqual(["text"]);
  });

  it("normalizes and persists OpenRouter token pricing", () => {
    const normalized = normalizeModel({
      id: "vendor/priced",
      freeTierEligible: true,
      pricing: { prompt: "0.0000025", completion: "0.00001", request: "0.1" }
    });
    expect(normalized.pricing).toEqual({ prompt: "0.0000025", completion: "0.00001" });
    expect(normalized.freeTierEligible).toBe(true);

    const { store, configFile } = createStore();
    store.setCachedModels([normalized], 123);
    const persisted = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(persisted.cachedModels[0].pricing).toEqual({ prompt: "0.0000025", completion: "0.00001" });
    expect(persisted.cachedModels[0].freeTierEligible).toBe(true);
    store.load();
    expect(store.getCachedModels()[0].freeTierEligible).toBe(true);
  });

  it("keeps old caches compatible and rejects invalid prices", () => {
    expect(normalizeModel({ id: "legacy" }).pricing).toEqual({});
    expect(normalizeModel({ id: "invalid", pricing: { prompt: "nope", completion: "-1" } }).pricing).toEqual({});
  });

  it("encrypts the API key and never exposes it through public config", () => {
    const { store, configFile } = createStore();
    store.setApiKey("sk-secret");
    expect(store.getApiKey()).toBe("sk-secret");
    expect(store.getPublicConfig()).toEqual(expect.objectContaining({ hasApiKey: true }));
    expect(store.getPublicConfig()).not.toHaveProperty("apiKey");
    expect(readFileSync(configFile, "utf-8")).not.toContain("sk-secret");
  });

  it("allows cached models to be favorited independently of Codex compatibility", () => {
    const { store } = createStore();
    store.setCachedModels([
      { id: "good", supported_parameters: ["tools", "tool_choice"] },
      { id: "bad", supported_parameters: ["tools"] }
    ], 123);
    expect(store.setFavorites(["good"], "good")).toMatchObject({ favoriteModelIds: ["good"], defaultModelId: "good" });
    expect(store.setFavorites(["bad"], "bad").favoriteModelIds).toEqual(["bad"]);
  });

  it("lets NaraRouter models without capability metadata proceed to live verification", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-nararouter-"));
    dirs.push(dir);
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    };
    const store = createOpenRouterConfigStore({
      configFile: path.join(dir, "nararouter.json"),
      safeStorage,
      providerName: "NaraRouter",
      assumeCompatibleWhenCapabilitiesMissing: true
    });
    store.setCachedModels([{ id: "gpt-test", pricing: { prompt: "0.000001" } }], 123);
    expect(store.getCachedModels()[0]).toMatchObject({ compatible: true, pricing: { prompt: "0.000001" } });
    expect(store.setFavorites(["gpt-test"], "gpt-test")).toMatchObject({ favoriteModelIds: ["gpt-test"], defaultModelId: "gpt-test" });
  });

  it("persists model verification results and clears them when the API key changes", () => {
    const { store, configFile } = createStore();
    store.setCachedModels([{ id: "good", supported_parameters: ["tools", "tool_choice"] }], 123);
    store.setModelVerification("good", { status: "failed", checkedAt: 456, error: "Internal Server Error" });
    expect(store.getModelVerifications()).toEqual({ good: { status: "failed", checkedAt: 456, error: "Internal Server Error" } });
    expect(JSON.parse(readFileSync(configFile, "utf-8")).modelVerifications.good).toMatchObject({ status: "failed", checkedAt: 456 });

    store.setApiKey("sk-new");
    expect(store.getModelVerifications()).toEqual({});
  });

  it("invalidates old verification results when the transport profile changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-nara-profile-"));
    dirs.push(dir);
    const configFile = path.join(dir, "nararouter.json");
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
    const oldStore = createOpenRouterConfigStore({ configFile, safeStorage, verificationProfile: "responses-v1" });
    oldStore.setCachedModels([{ id: "model-a", supported_parameters: ["tools", "tool_choice"] }], 123);
    oldStore.setModelVerification("model-a", { status: "passed", checkedAt: 456 });

    const bridgeStore = createOpenRouterConfigStore({ configFile, safeStorage, verificationProfile: "chat-completions-bridge-v1" });
    bridgeStore.load();
    expect(bridgeStore.getCachedModels()).toHaveLength(1);
    expect(bridgeStore.getModelVerifications()).toEqual({});
    bridgeStore.setFavorites(["model-a"], "model-a");
    expect(JSON.parse(readFileSync(configFile, "utf-8")).verificationProfile).toBe("chat-completions-bridge-v1");
  });

  it("normalizes staged partial verification details without exposing unbounded provider data", () => {
    const { store } = createStore();
    store.setCachedModels([{ id: "good", supported_parameters: ["tools", "tool_choice"] }], 123);
    store.setModelVerification("good", {
      status: "partial",
      checkedAt: 456,
      failedStage: "codex_tools",
      errorKind: "unsupported",
      httpStatus: 400,
      provider: "Nvidia",
      stages: [
        { stage: "responses", status: "passed" },
        { stage: "function_tools", status: "passed" },
        { stage: "codex_tools", status: "failed", error: "x".repeat(1200), errorKind: "unsupported", httpStatus: 400 }
      ]
    });

    expect(store.getModelVerifications().good).toMatchObject({
      status: "partial",
      failedStage: "codex_tools",
      errorKind: "unsupported",
      httpStatus: 400,
      provider: "Nvidia"
    });
    expect(store.getModelVerifications().good.stages[2].error).toHaveLength(1000);
  });
});
