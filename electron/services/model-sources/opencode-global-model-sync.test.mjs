import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createOpenCodeGlobalModelSync } = require("./opencode-global-model-sync.cjs");
const directories = [];
afterEach(() => { while (directories.length) rmSync(directories.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pannel-opencode-sync-"));
  directories.push(root);
  const home = path.join(root, "home");
  const userDataDir = path.join(root, "app");
  const configDir = path.join(home, ".config", "opencode");
  const authDir = path.join(home, ".local", "share", "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  const config = path.join(configDir, "opencode.jsonc");
  const auth = path.join(authDir, "auth.json");
  writeFileSync(config, '{\n  // user setting\n  "theme": "dark"\n}\n');
  writeFileSync(auth, '{"another":{"type":"api","key":"unrelated"}}\n');
  const state = { models: [{ id: "vendor/coder", name: "Coder" }], verified: { "vendor/coder": { status: "passed" } }, key: "secret" };
  const store = { getCachedModels: () => state.models, getAgentModelVerifications: () => state.verified, getApiKey: () => state.key };
  const empty = { getCachedModels: () => [], getAgentModelVerifications: () => ({}), getApiKey: () => "" };
  const sync = createOpenCodeGlobalModelSync({ home, userDataDir, stores: { openrouter: store, nararouter: empty, minimax: empty } });
  return { root, state, sync, config, auth };
}

describe("OpenCode global model sync", () => {
  it("registers verified models without favorites and preserves user configuration and credentials", () => {
    const f = fixture();
    f.sync.syncWindows();
    const config = readFileSync(f.config, "utf8");
    expect(config).toContain("// user setting");
    expect(JSON.parse(readFileSync(f.auth, "utf8"))).toEqual({ another: { type: "api", key: "unrelated" }, openrouter: { type: "api", key: "secret" } });
    expect(config).toContain('"vendor/coder"');
    expect(config).not.toContain("secret");
    f.state.verified["vendor/coder"] = { status: "failed" };
    f.sync.syncWindows();
    expect(readFileSync(f.config, "utf8")).not.toContain('"vendor/coder"');
    expect(JSON.parse(readFileSync(f.auth, "utf8"))).toEqual({ another: { type: "api", key: "unrelated" } });
  });

  it("refuses to overwrite an existing user's provider credential", () => {
    const f = fixture();
    writeFileSync(f.auth, '{"openrouter":{"type":"api","key":"other"}}\n');
    expect(() => f.sync.syncWindows()).toThrow("已有 openrouter 凭据");
    expect(readFileSync(f.config, "utf8")).not.toContain('"vendor/coder"');
  });

  it("uses OpenCode v2 provider fields for a custom model service", () => {
    const f = fixture();
    f.state.verified = {};
    const custom = { getCachedModels: () => [{ id: "coder", name: "Coder" }],
      getAgentModelVerifications: () => ({ coder: { status: "passed" } }), getApiKey: () => "custom-key" };
    const empty = { getCachedModels: () => [], getAgentModelVerifications: () => ({}), getApiKey: () => "" };
    const sync = createOpenCodeGlobalModelSync({ home: path.join(f.root, "home"), userDataDir: path.join(f.root, "app2"),
      stores: { openrouter: empty, nararouter: custom, minimax: empty } });
    sync.syncWindows();
    const config = readFileSync(f.config, "utf8");
    expect(config).toContain('"providers"');
    expect(config).toContain('"package": "@opencode/ai/providers/openai-compatible"');
    expect(config).toContain('"baseURL": "https://router.bynara.id/v1"');
    expect(config).not.toContain("custom-key");
    expect(JSON.parse(readFileSync(f.auth, "utf8")).nararouter).toEqual({ type: "api", key: "custom-key" });
  });
});
