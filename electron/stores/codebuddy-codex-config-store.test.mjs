import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCodeBuddyCodexConfigStore } = require("./codebuddy-codex-config-store.cjs");
const dirs = [];

function createStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "pannel-codebuddy-codex-"));
  dirs.push(dir);
  const configFile = path.join(dir, "codebuddy-codex.json");
  return { store: createCodeBuddyCodexConfigStore({ configFile }), configFile };
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe("codebuddy-codex-config-store", () => {
  it("persists the cached catalog, favorites, default, and version-bound acknowledgement", () => {
    const { store, configFile } = createStore();
    store.setCachedModels("2.142.0", [{ id: "glm-5.3" }, { id: "kimi-k3" }], 123);
    store.setFavorites(["glm-5.3"], "glm-5.3");
    expect(store.setExperimentalAcknowledged(true)).toMatchObject({
      catalogVersion: "2.142.0",
      favoriteModelIds: ["glm-5.3"],
      defaultModelId: "glm-5.3",
      experimentalAcknowledged: true
    });
    expect(JSON.parse(readFileSync(configFile, "utf-8"))).toMatchObject({ acknowledgedVersion: "2.142.0" });
  });

  it("keeps matching favorites, the default, and acknowledgement when the CLI version changes", () => {
    const { store, configFile } = createStore();
    store.setCachedModels("2.142.0", [{ id: "glm-5.3" }, { id: "removed-model" }]);
    store.setFavorites(["glm-5.3", "removed-model"], "glm-5.3");
    store.setExperimentalAcknowledged(true);
    store.setCachedModels("2.142.1", [{ id: "glm-5.3" }]);
    expect(store.getPublicConfig()).toMatchObject({
      favoriteModelIds: ["glm-5.3"],
      defaultModelId: "glm-5.3",
      experimentalAcknowledged: true,
      catalogVersion: "2.142.1"
    });
    expect(JSON.parse(readFileSync(configFile, "utf-8"))).toMatchObject({ acknowledgedVersion: "2.142.1" });
  });

  it("round-trips safe WorkBuddy model capability and promotion metadata", () => {
    const { store, configFile } = createStore();
    store.setCachedModels("2.142.0", [
      { id: "hy3", name: "混元 3", contextWindow: 1_000_000, promotions: [{ id: "free", badge: { label: "限时免费" }, schedule: {} }] },
      { id: "invalid", contextWindow: 2_000_000 }
    ]);
    const reloaded = createCodeBuddyCodexConfigStore({ configFile });
    reloaded.load();
    expect(reloaded.getCachedModels()).toEqual([
      { id: "hy3", name: "混元 3", contextWindow: 1_000_000, promotions: [{ id: "free", badge: { label: "限时免费" }, schedule: {} }] },
      { id: "invalid", name: "invalid" }
    ]);
  });
});
