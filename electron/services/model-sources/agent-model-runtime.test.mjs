import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildAgentModelEnvironment } = require("./agent-model-runtime.cjs");

describe("agent model runtime", () => {
  it("uses OpenCode custom provider configuration with an environment key reference", () => {
    const env = buildAgentModelEnvironment("opencode", {
      providerId: "nararouter", providerName: "NaraRouter", model: "test/model",
      baseUrl: "https://example.com/v1", apiKey: "secret", apiKeyEnv: "NARAROUTER_API_KEY"
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(config).toEqual({
      model: "nararouter/test/model",
      provider: { nararouter: {
        name: "NaraRouter", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.com/v1", apiKey: "{env:NARAROUTER_API_KEY}" },
        models: { "test/model": { name: "test/model" } }
      } }
    });
    expect(env.NARAROUTER_API_KEY).toBe("secret");
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("secret");
  });

  it("uses native OpenRouter provider selection", () => {
    const env = buildAgentModelEnvironment("opencode", {
      providerId: "openrouter", model: "test/model", apiKey: "secret", apiKeyEnv: "OPENROUTER_API_KEY"
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ model: "openrouter/test/model" });
  });
});
