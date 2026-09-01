import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge from "./codebuddy-codex-bridge-service.cjs";

const { parseCodeBuddyVersion, parseCodeBuddyModels, buildModelCatalog } = bridge;
const require = createRequire(import.meta.url);
const { createCodeBuddyCodexConfigStore } = require("../stores/codebuddy-codex-config-store.cjs");
const dirs = [];

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe("CodeBuddy Codex bridge metadata", () => {
  it("parses the CLI version and concrete model list", () => {
    expect(parseCodeBuddyVersion("2.143.0\n")).toBe("2.143.0");
    expect(parseCodeBuddyModels("Currently supported: (auto, hy4-preview, hy3, glm-5.3, minimax-m3, kimi-k3-1)")).toEqual(["hy4-preview", "hy3", "glm-5.3", "minimax-m3", "kimi-k3-1"]);
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

  it("builds a conservative Codex model catalog", () => {
    const catalog = buildModelCatalog([{ id: "glm-5.3", name: "glm-5.3" }]);
    expect(catalog.models[0]).toMatchObject({ slug: "glm-5.3", input_modalities: ["text"], context_window: 128000, apply_patch_tool_type: "freeform", shell_type: "shell_command" });
  });

  it("launches an unchanged verified model after the CLI version changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-launch-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    store.setCachedModels("2.142.0", [{ id: "glm-5.3" }]);
    store.setFavorites(["glm-5.3"], "glm-5.3");
    store.setExperimentalAcknowledged(true);
    writeFileSync(path.join(dir, "verifications.json"), JSON.stringify({ "2.142.0:glm-5.3": { status: "passed", checkedAt: 1 } }));
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "2.143.0\n", stderr: "" }));
    const service = bridge.createCodeBuddyCodexBridgeService({
      store,
      verificationFile: path.join(dir, "verifications.json"),
      catalogFile: path.join(dir, "catalog.json"),
      preloadFile: path.join(dir, "preload.cjs"),
      spawnSync
    });

    const launch = await service.getLaunchConfig({ agentProvider: "codex", codexBackend: "codebuddy", codexModel: "glm-5.3", type: "windows" });
    expect(launch.model).toBe("glm-5.3");
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 10000 }));
    expect(spawnSync.mock.calls[0][1]).toContain("codebuddy --version");
    await service.shutdown();
  });

  it("inherits passed checks for unchanged models while leaving new models pending", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-upgrade-"));
    dirs.push(dir);
    const store = createCodeBuddyCodexConfigStore({ configFile: path.join(dir, "config.json") });
    store.setCachedModels("2.142.0", [{ id: "glm-5.3" }]);
    writeFileSync(path.join(dir, "verifications.json"), JSON.stringify({ "2.142.0:glm-5.3": { status: "passed", checkedAt: 1 } }));
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
      "2.142.0:glm-5.3": { status: "passed", checkedAt: 1 },
      "2.143.0:glm-5.3": { status: "failed", checkedAt: 2, error: "probe failed" }
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
});
