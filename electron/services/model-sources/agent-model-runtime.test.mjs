import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildAgentModelEnvironment } = require("./agent-model-runtime.cjs");

describe("agent model runtime", () => {
  it.each(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2"])("registers %s as an exact external CodeBuddy ID", model => {
    const env = buildAgentModelEnvironment("codebuddy", {
      providerId: "minimax", model, baseUrl: "https://api.minimaxi.com/v1", apiKey: "private-key"
    }, {});
    expect(JSON.parse(env.ACC_PRODUCT_CONFIG_V3).models).toEqual([
      { id: model, name: model, url: "https://api.minimaxi.com/v1", tags: ["custom"] }
    ]);
    expect(env.CODEBUDDY_MODEL).toBe(model);
    expect(env.CODEBUDDY_API_KEY).toBe("private-key");
    expect(env.ACC_PRODUCT_CONFIG_V3).not.toContain("private-key");
  });

  it("preserves product settings and replaces the selected model registration", () => {
    const env = buildAgentModelEnvironment("codebuddy", {
      providerId: "minimax", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "private-key"
    }, { ACC_PRODUCT_CONFIG_V3: JSON.stringify({ config: { theme: "dark" }, agents: [{ name: "cli" }],
      models: [{ id: "other" }, { id: "MiniMax-M3", url: "https://stale.example" }] }) });
    const config = JSON.parse(env.ACC_PRODUCT_CONFIG_V3);
    expect(config).toMatchObject({ config: { theme: "dark" }, agents: [{ name: "cli" }] });
    expect(config.models).toHaveLength(2);
    expect(config.models[0]).toEqual({ id: "other" });
    expect(config.models[1].url).toBe("https://api.minimaxi.com/v1");
  });

  it.each(["invalid", "[]", "null"])("rejects malformed inherited product settings without exposing them", value => {
    expect(() => buildAgentModelEnvironment("codebuddy", {
      providerId: "minimax", model: "MiniMax-M3", apiKey: "private-key"
    }, { ACC_PRODUCT_CONFIG_V3: value })).toThrow(/CodeBuddy 产品配置/);
  });

  it.each(["ACC_PRODUCT_CONFIG_V2", "ACC_PRODUCT_CONFIG"])("preserves %s with CodeBuddy's legacy snapshot rules", name => {
    const env = buildAgentModelEnvironment("codebuddy", {
      providerId: "minimax", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "private-key"
    }, { [name]: JSON.stringify({ endpoint: "https://gateway.example", authentication: { type: "test" }, models: [{ id: "legacy" }] }) });
    const config = JSON.parse(env.ACC_PRODUCT_CONFIG_V3);
    expect(config.endpoint).toBe("https://gateway.example");
    expect(config.models.map(model => model.id)).toEqual(["MiniMax-M3"]);
    expect(config.authentication).toEqual(name === "ACC_PRODUCT_CONFIG" ? undefined : { type: "test" });
  });

  it("uses OpenCode V2 custom provider configuration with an environment key reference", () => {
    const env = buildAgentModelEnvironment("opencode", {
      providerId: "nararouter", providerName: "NaraRouter", model: "test/model",
      baseUrl: "https://example.com/v1", apiKey: "secret", apiKeyEnv: "NARAROUTER_API_KEY"
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(config).toEqual({
      model: "nararouter/test/model",
      providers: { nararouter: {
        name: "NaraRouter", env: ["NARAROUTER_API_KEY"], package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://example.com/v1" },
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
