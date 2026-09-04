import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge from "./codebuddy-bridge-service.cjs";

const { VERIFICATION_PROTOCOL_VERSION, parseCodeBuddyVersion, parseCodeBuddyModels, parseVerificationStream, clearRequestEstablishmentTimeout, readCodeBuddyProductModels, buildModelCatalog } = bridge;
const require = createRequire(import.meta.url);
const { createCodeBuddyCodexConfigStore } = require("../../stores/codebuddy-codex-config-store.cjs");
const dirs = [];

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe("CodeBuddy Codex bridge metadata", () => {
  it("parses the CLI version and concrete model list", () => {
    expect(parseCodeBuddyVersion("2.143.0\n")).toBe("2.143.0");
    expect(parseCodeBuddyModels("Currently supported: (auto, hy4-preview, hy3, glm-5.3, minimax-m3, kimi-k3-1)")).toEqual(["hy4-preview", "hy3", "glm-5.3", "minimax-m3", "kimi-k3-1"]);
  });

  it("keeps an established request alive beyond the 30-second startup deadline", () => {
    vi.useFakeTimers();
    try {
      let timedOut = false;
      const record = { establishmentTimeout: setTimeout(() => { timedOut = true; }, 30000) };
      clearRequestEstablishmentTimeout(record);
      vi.advanceTimersByTime(60000);
      expect(timedOut).toBe(false);
      expect(record.establishmentTimeout).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses completed verification streams and surfaces explicit stream errors", () => {
    const completed = { id: "resp_test", status: "completed", output: [] };
    expect(parseVerificationStream(`data: ${JSON.stringify({ type: "response.created" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`)).toEqual(completed);
    expect(() => parseVerificationStream(`data: ${JSON.stringify({ type: "error", error: { message: "CodeBuddy 模型流中断：socket closed" } })}\n\n`)).toThrow("CodeBuddy 模型流中断：socket closed");
    expect(() => parseVerificationStream("data: not-json\n\ndata: [DONE]\n\n")).toThrow("Codex Responses 流未完成");
  });

  it("refreshes models for any valid CLI version without a version allowlist", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-refresh-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    const spawnSync = vi.fn((_command, args) => args.includes("codebuddy --version")
      ? { status: 0, stdout: "3.0.0-preview.1\n", stderr: "" }
      : { status: 0, stdout: "--model <model> Currently supported: (auto, hy4-preview, glm-5.3)\n", stderr: "" });
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs"),
      spawnSync
    });

    expect(await service.refreshModels()).toEqual([
      { id: "hy4-preview", name: "hy4-preview", verification: undefined },
      { id: "glm-5.3", name: "glm-5.3", verification: undefined }
    ]);
    expect(store.getPublicConfig()).toMatchObject({ catalogVersion: "3.0.0-preview.1" });
  });

  it("uses model context metadata with a conservative fallback", () => {
    const catalog = buildModelCatalog([{ id: "glm-5.3", name: "glm-5.3", contextWindow: 1_000_000 }, { id: "legacy" }]);
    expect(catalog.models[0]).toMatchObject({ slug: "glm-5.3", input_modalities: ["text"], context_window: 1_000_000, max_context_window: 1_000_000, apply_patch_tool_type: "freeform", shell_type: "shell_command" });
    expect(catalog.models[1]).toMatchObject({ slug: "legacy", context_window: 128000, max_context_window: 128000 });
  });

  it("reads bounded model metadata beside the installed CodeBuddy shim", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-product-"));
    dirs.push(dir);
    const shim = path.join(dir, "codebuddy.cmd");
    const packageDir = path.join(dir, "node_modules", "@tencent-ai", "codebuddy-code");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(shim, "@echo off\n");
    writeFileSync(path.join(packageDir, "product.json"), JSON.stringify({
      models: [
        { id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 1_000_000, maxAllowedSize: 1_000_000 },
        { id: "invalid-large", maxInputTokens: 2_000_000 }
      ]
    }));
    const spawnSync = vi.fn(() => ({ status: 0, stdout: `${shim}\r\n`, stderr: "" }));

    expect(readCodeBuddyProductModels({ spawnSync })).toEqual([
      { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, promotions: [] },
      { id: "invalid-large", name: "invalid-large", promotions: [] }
    ]);
    expect(spawnSync).toHaveBeenCalledWith("where.exe", ["codebuddy.cmd"], expect.objectContaining({ timeout: 10000 }));
  });

  it("launches an unchanged verified model after the CLI version changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-launch-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    store.setCachedModels("2.142.0", [{ id: "glm-5.3" }]);
    store.setFavorites(["glm-5.3"], "glm-5.3");
    store.setExperimentalAcknowledged(true);
    writeFileSync(path.join(dir, "verifications.json"), JSON.stringify({ [`2.142.0:${VERIFICATION_PROTOCOL_VERSION}:glm-5.3`]: { status: "passed", checkedAt: 1 } }));
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "2.143.0\n", stderr: "" }));
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs"),
      spawnSync,
      readLocalProductModels: () => [{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000 }]
    });

    const launch = await service.getLaunchConfig({ agentProvider: "codex", codexBackend: "codebuddy", codexModel: "glm-5.3", type: "windows" });
    expect(launch.model).toBe("glm-5.3");
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 10000 }));
    expect(spawnSync.mock.calls[0][1]).toContain("codebuddy --version");
    expect(JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf-8")).models[0]).toMatchObject({
      slug: "glm-5.3",
      context_window: 1_000_000,
      max_context_window: 1_000_000
    });
    await service.shutdown();
  });

  it("inherits passed checks for unchanged models while leaving new models pending", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-upgrade-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    store.setCachedModels("2.142.0", [{ id: "glm-5.3" }]);
    writeFileSync(path.join(dir, "verifications.json"), JSON.stringify({ [`2.142.0:${VERIFICATION_PROTOCOL_VERSION}:glm-5.3`]: { status: "passed", checkedAt: 1 } }));
    const spawnSync = vi.fn((_command, args) => args.includes("codebuddy --version")
      ? { status: 0, stdout: "2.143.0\n", stderr: "" }
      : { status: 0, stdout: "Currently supported: (auto, glm-5.3, new-model)\n", stderr: "" });
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs"),
      spawnSync
    });

    expect(await service.refreshModels()).toEqual([
      { id: "glm-5.3", name: "glm-5.3", verification: { status: "passed", checkedAt: 1 } },
      { id: "new-model", name: "new-model", verification: undefined }
    ]);
  });

  it("enriches CLI models with WorkBuddy names and current promotion display", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-promotions-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    const spawnSync = vi.fn((_command, args) => args.includes("codebuddy --version")
      ? { status: 0, stdout: "3.0.0\n", stderr: "" }
      : { status: 0, stdout: "Currently supported: (auto, hy3)\n", stderr: "" });
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs"),
      spawnSync,
      now: () => Date.parse("2026-09-01T12:00:00+08:00"),
      workBuddyModelCatalogService: { readCatalog: async () => [{ id: "hy3", name: "混元 3", promotions: [{ id: "free", priority: 2, badge: { label: "限时免费", color: "#FF0000" }, hover: { textZh: "每日赠送免费额度。" }, schedule: {} }] }] }
    });

    expect(await service.refreshModels()).toEqual([expect.objectContaining({
      id: "hy3",
      name: "混元 3",
      promotions: [{ id: "free", label: "限时免费", color: "#FF0000", descriptionZh: "每日赠送免费额度。" }]
    })]);
  });

  it("preserves prior metadata when WorkBuddy cache refresh is unavailable", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-promotion-fallback-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    store.setCachedModels("2.0.0", [{ id: "hy3", name: "混元 3", promotions: [{ id: "free", priority: 1, badge: { label: "限时免费" }, hover: {}, schedule: {} }] }]);
    const spawnSync = vi.fn((_command, args) => args.includes("codebuddy --version")
      ? { status: 0, stdout: "2.0.1\n", stderr: "" }
      : { status: 0, stdout: "Currently supported: (auto, hy3)\n", stderr: "" });
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs"),
      spawnSync,
      workBuddyModelCatalogService: { readCatalog: async () => { throw new Error("missing"); } }
    });

    expect(await service.refreshModels()).toEqual([expect.objectContaining({ name: "混元 3", promotions: [{ id: "free", label: "限时免费" }] })]);
  });

  it("prefers an explicit failed check for the current version over an older pass", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-failed-upgrade-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    store.setCachedModels("2.143.0", [{ id: "glm-5.3" }]);
    writeFileSync(path.join(dir, "verifications.json"), JSON.stringify({
      [`2.142.0:${VERIFICATION_PROTOCOL_VERSION}:glm-5.3`]: { status: "passed", checkedAt: 1 },
      [`2.143.0:${VERIFICATION_PROTOCOL_VERSION}:glm-5.3`]: { status: "failed", checkedAt: 2, error: "probe failed" }
    }));
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs")
    });

    expect(service.listModels()[0].verification).toMatchObject({ status: "failed", error: "probe failed" });
    expect(() => service.setFavorites({ favoriteModelIds: ["glm-5.3"] })).toThrow("尚未通过");
  });

  it("does not reuse verification results from the restricted tool protocol", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-old-protocol-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    store.setCachedModels("2.143.0", [{ id: "glm-5.3" }]);
    store.setFavorites(["glm-5.3"], "glm-5.3");
    writeFileSync(path.join(dir, "verifications.json"), JSON.stringify({ "2.143.0:glm-5.3": { status: "passed", checkedAt: 1 } }));
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs")
    });

    expect(service.listModels()[0].verification).toBeUndefined();
    expect(() => service.setFavorites({ favoriteModelIds: ["glm-5.3"] })).toThrow("尚未通过");
    expect(service.setFavorites({ favoriteModelIds: [] })).toMatchObject({ favoriteModelIds: [], defaultModelId: undefined });
  });
});
