import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { it, expect, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createOpenRouterService } = require("./openrouter-service.cjs");
const { createOpenRouterConfigStore } = require("../../stores/openrouter-config-store.cjs");
const { createOpenCodeGlobalModelSync } = require("../model-sources/opencode-global-model-sync.cjs");
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };

it.each(["openrouter", "nararouter", "minimax"])("separates %s persistence from real invalid OpenCode configuration", async providerId => {
  const dir = mkdtempSync(path.join(tmpdir(), "pannel-key-sync-"));
  try {
    const configFile = path.join(dir, "keys.json");
    const store = createOpenRouterConfigStore({ configFile, safeStorage });
    const configHome = path.join(dir, "config");
    mkdirSync(path.join(configHome, "opencode"), { recursive: true });
    const openCodeFile = path.join(configHome, "opencode", "opencode.json");
    writeFileSync(openCodeFile, "{invalid");
    const sync = createOpenCodeGlobalModelSync({ userDataDir: dir, home: dir, xdgConfigHome: configHome, xdgDataHome: path.join(dir, "data"), stores: { [providerId]: store } });
    const service = createOpenRouterService({ store, providerId, onOpenCodeModelsChanged: () => sync.syncWindows() });
    for (const [method, hasApiKey] of [["saveApiKey", true], ["clearApiKey", false]]) {
      const result = await service[method]("test-key");
      expect(result.hasApiKey).toBe(hasApiKey);
      expect(result.openCodeSyncError).toContain("OpenCode 配置格式无效");
      expect(store.getApiKey()).toBe(hasApiKey ? "test-key" : "");
      expect(Boolean(JSON.parse(readFileSync(configFile, "utf8")).encryptedApiKey)).toBe(hasApiKey);
    }
    writeFileSync(openCodeFile, "{}");
    await expect(service.syncOpenCodeModels()).resolves.toEqual({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["saveApiKey", "clearApiKey"])("retains credentials and rejects %s on storage failure", async method => {
  let fail = false;
  let persisted;
  const store = createOpenRouterConfigStore({ configFile: "keys", safeStorage, dataStore: {
    write: (_file, value) => { if (fail) throw new Error("disk failure"); persisted = structuredClone(value); }
  } });
  store.setApiKey("original");
  const previous = structuredClone(persisted);
  fail = true;
  const sync = vi.fn();
  const service = createOpenRouterService({ store, onOpenCodeModelsChanged: sync });
  await expect(service[method]("replacement")).rejects.toThrow("disk failure");
  expect(store.getApiKey()).toBe("original");
  expect(persisted).toEqual(previous);
  expect(sync).not.toHaveBeenCalled();
});
