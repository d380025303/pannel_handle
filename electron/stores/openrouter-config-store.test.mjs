import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createOpenRouterConfigStore } = require("./openrouter-config-store.cjs");

function createStore(safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, "")
}) {
  const configFile = join(mkdtempSync(join(tmpdir(), "openrouter-store-")), "openrouter.json");
  return { configFile, store: createOpenRouterConfigStore({ configFile, safeStorage, logger: { error: vi.fn() } }) };
}

describe("openrouter-config-store", () => {
  it("persists only an encrypted API key and can reload it", () => {
    const { configFile, store } = createStore();
    store.setApiKey("sk-or-secret");

    expect(store.getConfig()).toEqual({ hasApiKey: true });
    expect(store.getApiKey()).toBe("sk-or-secret");
    expect(readFileSync(configFile, "utf-8")).not.toContain("sk-or-secret");

    const reloaded = createOpenRouterConfigStore({
      configFile,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: (value) => value.toString().replace(/^encrypted:/, "")
      }
    });
    reloaded.load();
    expect(reloaded.getApiKey()).toBe("sk-or-secret");
  });

  it("refuses plaintext fallback and supports clearing", () => {
    const unavailable = createStore({ isEncryptionAvailable: () => false }).store;
    expect(() => unavailable.setApiKey("sk-or-secret")).toThrow("安全存储不可用");

    const { store } = createStore();
    store.setApiKey("sk-or-secret");
    expect(store.clear()).toEqual({ hasApiKey: false });
    expect(store.getApiKey()).toBe("");
  });
});
