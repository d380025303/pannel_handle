import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createOpenRouterConfigStore, normalizeModel } = require("./openrouter-config-store.cjs");
const { createOpenRouterService } = require("../services/settings/openrouter-service.cjs");
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
  it.each(["OpenRouter", "NaraRouter", "MiniMax"])("preserves %s's cache and verifications on SQLITE_READONLY, then persists a retry", providerName => {
    let persisted;
    const dataStore = {
      read: () => structuredClone(persisted),
      write: vi.fn((_file, value) => { persisted = structuredClone(value); })
    };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    };
    const options = { configFile: "provider.json", dataStore, safeStorage, providerName };
    const store = createOpenRouterConfigStore(options);
    store.setApiKey("old-key");
    store.setCachedModels([{ id: "old" }, { id: "retained" }], 123);
    for (const id of ["old", "retained"]) {
      store.setModelVerification(id, { status: "passed", checkedAt: 456, stages: [{ stage: "responses", status: "passed" }] });
      for (const agent of ["opencode", "codebuddy"]) store.setAgentModelVerification(agent, id, { status: "passed" });
    }
    const service = createOpenRouterService({ store, providerName });
    const launchBefore = service.getAgentLaunchConfig("codebuddy", "old");
    const before = structuredClone(persisted);
    const failure = Object.assign(new Error("attempt to write a readonly database"), { code: "SQLITE_READONLY" });
    dataStore.write.mockImplementationOnce(() => { throw failure; });

    expect(() => store.setCachedModels([{ id: "new" }], 789)).toThrow(failure);
    expect(persisted).toEqual(before);
    const reloaded = createOpenRouterConfigStore(options);
    reloaded.load();
    for (const current of [store, reloaded]) {
      expect(current.getCachedModels()).toEqual(before.cachedModels);
      expect(current.getPublicConfig()).toEqual({ hasApiKey: true, fetchedAt: 123 });
      expect(current.getModelVerifications()).toEqual(before.modelVerifications);
      for (const agent of ["opencode", "codebuddy"]) {
        expect(current.getAgentModelVerifications(agent)).toEqual(before.agentModelVerifications[agent]);
      }
    }
    expect(service.getAgentLaunchConfig("codebuddy", "old")).toEqual(launchBefore);

    const updated = store.setCachedModels([{ id: "new" }, { id: "retained" }], 789);
    reloaded.load();
    for (const current of [store, reloaded]) {
      expect(current.getCachedModels()).toEqual(updated);
      expect(current.getCachedModels().map(model => model.id)).toEqual(["new", "retained"]);
      expect(current.getPublicConfig()).toEqual({ hasApiKey: true, fetchedAt: 789 });
      expect(current.getModelVerifications()).toEqual({ retained: before.modelVerifications.retained });
      for (const agent of ["opencode", "codebuddy"]) {
        expect(current.getAgentModelVerifications(agent)).toEqual({ retained: before.agentModelVerifications[agent].retained });
      }
    }
    expect(() => service.getAgentLaunchConfig("codebuddy", "old")).toThrow("模型不存在");
  });

  it.each(["codebuddy", "opencode", "codex"].flatMap(target => [true, false].map(existing => ({ target, existing }))))(
    "rolls back $target verification on SQLITE_FULL (existing: $existing) and allows retry",
    ({ target, existing }) => {
      let persisted;
      const dataStore = {
        read: () => structuredClone(persisted),
        write: vi.fn((_file, value) => { persisted = structuredClone(value); })
      };
      const options = { configFile: "openrouter.json", dataStore };
      const store = createOpenRouterConfigStore(options);
      const set = value => target === "codex"
        ? store.setModelVerification("model", value)
        : store.setAgentModelVerification(target, "model", value);
      const get = current => target === "codex"
        ? current.getModelVerifications()
        : current.getAgentModelVerifications(target);
      store.setCachedModels([{ id: "model", supported_parameters: ["tools", "tool_choice"] }], 123);
      if (existing) set({ status: "passed", checkedAt: 456, stages: [{ stage: "responses", status: "passed" }] });
      const before = structuredClone(persisted);
      const previous = get(store);
      const failure = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      dataStore.write.mockImplementationOnce(() => { throw failure; });

      let thrown;
      try { set({ status: "failed", checkedAt: 789, error: "unsupported" }); }
      catch (error) { thrown = error; }
      expect(thrown).toBe(failure);
      expect(get(store)).toEqual(previous);
      expect(Object.hasOwn(get(store), "model")).toBe(existing);
      expect(persisted).toEqual(before);
      const reloaded = createOpenRouterConfigStore(options);
      reloaded.load();
      expect(get(reloaded)).toEqual(previous);
      expect(get(store).model?.status === "passed").toBe(existing);

      const saved = set({ status: "failed", checkedAt: 789, error: "unsupported" });
      reloaded.load();
      expect(get(store).model).toEqual(saved);
      expect(get(reloaded).model).toEqual(saved);
      expect(saved.status).toBe("failed");
    }
  );

  it.each(["setApiKey", "clearApiKey"])("restores credentials and all verifications when %s fails, then persists a successful retry", operation => {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`encrypted:${value}`),
      decryptString: value => value.toString().replace(/^encrypted:/, "")
    };
    let persisted;
    const dataStore = {
      read: () => structuredClone(persisted),
      write: vi.fn((_file, value) => { persisted = structuredClone(value); })
    };
    const options = { configFile: "openrouter.json", safeStorage, dataStore };
    const initial = createOpenRouterConfigStore(options);
    initial.setApiKey("old-key");
    initial.setCachedModels([{ id: "model", supported_parameters: ["tools", "tool_choice"] }], 123);
    initial.setModelVerification("model", { status: "passed", checkedAt: 456, stages: [{ stage: "responses", status: "passed" }] });
    initial.setAgentModelVerification("opencode", "model", { status: "passed" });
    initial.setAgentModelVerification("codebuddy", "model", { status: "failed", error: "unsupported" });
    const store = createOpenRouterConfigStore(options);
    store.load();
    const before = structuredClone(persisted);
    const failure = new Error("attempt to write a readonly database");
    dataStore.write.mockImplementationOnce(() => { throw failure; });

    expect(() => store[operation]("new-key")).toThrow(failure);
    expect(store.getApiKey()).toBe("old-key");
    expect(store.getPublicConfig()).toEqual({ hasApiKey: true, fetchedAt: 123 });
    expect(store.getModelVerifications()).toEqual(before.modelVerifications);
    for (const agent of ["opencode", "codebuddy"]) {
      expect(store.getAgentModelVerifications(agent)).toEqual(before.agentModelVerifications[agent]);
    }
    expect(persisted).toEqual(before);
    const reloaded = createOpenRouterConfigStore(options);
    reloaded.load();
    expect(reloaded.getApiKey()).toBe("old-key");
    expect(reloaded.getModelVerifications()).toEqual(store.getModelVerifications());

    expect(store[operation]("new-key").hasApiKey).toBe(operation === "setApiKey");
    reloaded.load();
    expect(store.getApiKey()).toBe(operation === "setApiKey" ? "new-key" : "");
    expect(reloaded.getApiKey()).toBe(store.getApiKey());
    expect(store.getCachedModels()).toEqual(before.cachedModels);
    for (const current of [store, reloaded]) {
      expect(current.getModelVerifications()).toEqual({});
      expect(current.getAgentModelVerifications("opencode")).toEqual({});
      expect(current.getAgentModelVerifications("codebuddy")).toEqual({});
    }
  });

  it("tracks each Agent verification independently when Codex is incompatible", () => {
    const { store, configFile } = createStore();
    store.setCachedModels([{ id: "vendor/model", name: "Model", supported_parameters: [] }]);
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

  it("ignores legacy favorites and defaults and removes them on the next save", () => {
    const { store, configFile } = createStore();
    writeFileSync(configFile, JSON.stringify({ cachedModels: [{ id: "legacy" }], favoriteModelIds: ["legacy"], defaultModelId: "legacy" }));
    store.load();
    expect(store.getPublicConfig()).not.toHaveProperty("favoriteModelIds");
    expect(store.getPublicConfig()).not.toHaveProperty("defaultModelId");
    store.setCachedModels(store.getCachedModels());
    const saved = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(saved).not.toHaveProperty("favoriteModelIds");
    expect(saved).not.toHaveProperty("defaultModelId");
  });

  it("keeps cached models independently of Codex compatibility", () => {
    const { store } = createStore();
    store.setCachedModels([
      { id: "good", supported_parameters: ["tools", "tool_choice"] },
      { id: "bad", supported_parameters: ["tools"] }
    ], 123);
    expect(Object.fromEntries(store.getCachedModels().map(model => [model.id, model.compatible]))).toEqual({ good: true, bad: false });
    expect(store.getPublicConfig()).not.toHaveProperty("defaultModelId");
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
    bridgeStore.setCachedModels(bridgeStore.getCachedModels());
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
