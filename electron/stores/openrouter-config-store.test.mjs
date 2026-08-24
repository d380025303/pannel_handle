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
      pricing: { prompt: "0.0000025", completion: "0.00001", request: "0.1" }
    });
    expect(normalized.pricing).toEqual({ prompt: "0.0000025", completion: "0.00001" });

    const { store, configFile } = createStore();
    store.setCachedModels([normalized], 123);
    const persisted = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(persisted.cachedModels[0].pricing).toEqual({ prompt: "0.0000025", completion: "0.00001" });
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

  it("only allows compatible cached models to be favorited", () => {
    const { store } = createStore();
    store.setCachedModels([
      { id: "good", supported_parameters: ["tools", "tool_choice"] },
      { id: "bad", supported_parameters: ["tools"] }
    ], 123);
    expect(store.setFavorites(["good"], "good")).toMatchObject({ favoriteModelIds: ["good"], defaultModelId: "good" });
    expect(() => store.setFavorites(["bad"], "bad")).toThrow("tools/tool_choice");
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
