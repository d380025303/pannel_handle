import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createDingTalkConfigStore } = require("./ding-talk-config-store.cjs");

const tempDirs = [];

function createHarness(safeStorageOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-dingtalk-"));
  tempDirs.push(dir);
  const safeStorage = safeStorageOverride || {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value) => Buffer.from(`encrypted:${value}`, "utf-8")),
    decryptString: vi.fn((value) => value.toString("utf-8").replace(/^encrypted:/, ""))
  };
  const configFile = path.join(dir, "dingtalk.json");
  return {
    configFile,
    safeStorage,
    store: createDingTalkConfigStore({ configFile, safeStorage })
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ding-talk-config-store", () => {
  it("defaults to disabled without credentials", () => {
    const { store } = createHarness();
    store.loadConfig();
    expect(store.getConfig()).toEqual({ enabled: false, hasWebhook: false, hasSecret: false });
  });

  it("encrypts credentials and only exposes presence flags", () => {
    const { store, configFile, safeStorage } = createHarness();
    const result = store.updateConfig({
      enabled: true,
      webhook: "https://oapi.dingtalk.com/robot/send?access_token=token",
      secret: "signing-secret"
    });

    expect(result).toEqual({ enabled: true, hasWebhook: true, hasSecret: true });
    const saved = fs.readFileSync(configFile, "utf-8");
    expect(saved).not.toContain("access_token=token");
    expect(saved).not.toContain("signing-secret");
    expect(safeStorage.encryptString).toHaveBeenCalledTimes(2);
    expect(store.getCredentials()).toEqual({
      webhook: "https://oapi.dingtalk.com/robot/send?access_token=token",
      secret: "signing-secret"
    });
  });

  it("loads encrypted credentials after restart and can clear them", () => {
    const { store, configFile, safeStorage } = createHarness();
    store.updateConfig({ enabled: true, webhook: "https://oapi.dingtalk.com/robot/send?access_token=token" });
    const reloaded = createDingTalkConfigStore({ configFile, safeStorage });
    reloaded.loadConfig();

    expect(reloaded.getConfig()).toEqual({ enabled: true, hasWebhook: true, hasSecret: false });
    expect(reloaded.clearCredentials()).toEqual({ enabled: false, hasWebhook: false, hasSecret: false });
    expect(reloaded.getCredentials()).toEqual({ webhook: "", secret: "" });
  });

  it("refuses to save credentials when safeStorage is unavailable", () => {
    const { store } = createHarness({
      isEncryptionAvailable: vi.fn(() => false)
    });
    expect(() => store.updateConfig({ webhook: "https://oapi.dingtalk.com/robot/send?access_token=token" }))
      .toThrow("系统安全存储不可用");
  });
});
