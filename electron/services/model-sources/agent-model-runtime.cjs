const SOURCES = Object.freeze({
  openrouter: { id: "openrouter" },
  nararouter: { id: "nararouter", npm: "@ai-sdk/openai-compatible" },
  minimax: { id: "minimax", npm: "@ai-sdk/openai-compatible" }
});

function buildAgentModelEnvironment(agent, launch) {
  if (!SOURCES[launch?.providerId] || !launch.apiKey || !launch.model) throw new Error("模型来源启动配置无效。");
  if (agent === "codebuddy") return {
    CODEBUDDY_API_KEY: launch.apiKey,
    CODEBUDDY_BASE_URL: launch.baseUrl,
    CODEBUDDY_MODEL: launch.model
  };
  if (agent !== "opencode") throw new Error("Unsupported Agent model target.");
  const source = SOURCES[launch.providerId];
  const provider = launch.providerId === "openrouter" ? undefined : {
    [source.id]: {
      name: launch.providerName,
      npm: source.npm,
      options: { baseURL: launch.baseUrl, apiKey: `{env:${launch.apiKeyEnv}}` },
      models: { [launch.model]: { name: launch.model } }
    }
  };
  return {
    [launch.apiKeyEnv]: launch.apiKey,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: `${source.id}/${launch.model}`,
      ...(provider ? { provider } : {}) })
  };
}

module.exports = { buildAgentModelEnvironment };
