import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeModelSelection } = require("./model-selection.cjs");
const { buildAgentModelEnvironment } = require("./agent-model-runtime.cjs");

describe("shared Agent model selection", () => {
  it("migrates legacy Codex selections while preserving native defaults", () => {
    expect(normalizeModelSelection({ agentProvider: "codex", type: "windows", codexBackend: "openrouter", codexModel: "vendor/coder" }))
      .toMatchObject({ modelSource: "openrouter", modelId: "vendor/coder", codexBackend: "openrouter", codexModel: "vendor/coder" });
    expect(normalizeModelSelection({ agentProvider: "opencode", type: "windows" })).toEqual({ modelSource: "native", modelId: undefined });
    expect(normalizeModelSelection({ agentProvider: "codebuddy", type: "ssh", modelSource: "openrouter" })).toEqual({});
  });

  it("keeps credentials out of OpenCode config and selects a custom source", () => {
    const env = buildAgentModelEnvironment("opencode", { providerId: "nararouter", providerName: "NaraRouter", model: "vendor/coder", baseUrl: "https://router.bynara.id/v1", apiKey: "secret", apiKeyEnv: "NARAROUTER_API_KEY" });
    expect(env.NARAROUTER_API_KEY).toBe("secret");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toMatchObject({ model: "nararouter/vendor/coder", providers: { nararouter: { env: ["NARAROUTER_API_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://router.bynara.id/v1" }, models: { "vendor/coder": { name: "vendor/coder" } } } } });
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("secret");
  });

  it("uses CodeBuddy per-process third-party settings", () => {
    expect(buildAgentModelEnvironment("codebuddy", { providerId: "openrouter", model: "vendor/coder", baseUrl: "https://openrouter.ai/api/v1", apiKey: "secret" }))
      .toEqual({ CODEBUDDY_API_KEY: "secret", CODEBUDDY_BASE_URL: "https://openrouter.ai/api/v1", CODEBUDDY_MODEL: "vendor/coder" });
  });
});
