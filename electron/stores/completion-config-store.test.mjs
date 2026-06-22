import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCompletionConfigStore } = require("./completion-config-store.cjs");
const tempDirs = [];

function createHarness(safeStorageOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-completion-"));
  tempDirs.push(dir);
  const safeStorage = safeStorageOverride || {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(value => Buffer.from(`encrypted:${value}`, "utf-8")),
    decryptString: vi.fn(value => value.toString("utf-8").replace(/^encrypted:/, ""))
  };
  return {
    configFile: path.join(dir, "completion.json"),
    safeStorage,
    store: createCompletionConfigStore({ configFile: path.join(dir, "completion.json"), safeStorage })
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("completion-config-store", () => {
  it("defaults to disabled without credentials", () => {
    const { store } = createHarness();
    store.loadConfig();
    expect(store.getConfig()).toEqual({ enabled: false, baseUrl: "https://api.openai.com/v1", model: "", hasApiKey: false });
  });

  it("encrypts the API key and never exposes it from getConfig", () => {
    const { store, configFile } = createHarness();
    expect(store.updateConfig({ enabled: true, baseUrl: "http://localhost:11434/v1", model: "local", apiKey: "secret" }))
      .toEqual({ enabled: true, baseUrl: "http://localhost:11434/v1", model: "local", hasApiKey: true });
    expect(fs.readFileSync(configFile, "utf-8")).not.toContain('"secret"');
    expect(store.getCredentials()).toEqual({ apiKey: "secret" });
  });

  it("reloads and clears credentials", () => {
    const { store, configFile, safeStorage } = createHarness();
    store.updateConfig({ enabled: true, model: "model", apiKey: "secret" });
    const reloaded = createCompletionConfigStore({ configFile, safeStorage });
    reloaded.loadConfig();
    expect(reloaded.getConfig().hasApiKey).toBe(true);
    expect(reloaded.clearCredentials()).toMatchObject({ enabled: false, hasApiKey: false });
  });

  it("refuses to save a key without safe storage", () => {
    const { store } = createHarness({ isEncryptionAvailable: vi.fn(() => false) });
    expect(() => store.updateConfig({ apiKey: "secret" })).toThrow("系统安全存储不可用");
  });
});
