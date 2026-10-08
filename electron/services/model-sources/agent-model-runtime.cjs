const SOURCES = Object.freeze({
  openrouter: { id: "openrouter" },
  nararouter: { id: "nararouter", package: "@opencode/ai/providers/openai-compatible" },
  minimax: { id: "minimax", package: "@opencode/ai/providers/openai-compatible" }
});

function buildAgentModelEnvironment(agent, launch, inheritedEnv = process.env) {
  if (!SOURCES[launch?.providerId] || !launch.apiKey || !launch.model) throw new Error("模型来源启动配置无效。");
  if (agent === "codebuddy") {
    const env = {
      CODEBUDDY_API_KEY: launch.apiKey,
      CODEBUDDY_BASE_URL: launch.baseUrl,
      CODEBUDDY_MODEL: launch.model
    };
    if (launch.providerId === "minimax") {
      // An exact ID wins over CodeBuddy's built-in display-name aliases.
      // Keep credentials in CODEBUDDY_API_KEY, never in the product snapshot.
      let config = {};
      const configName = ["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2", "ACC_PRODUCT_CONFIG"]
        .find(name => inheritedEnv[name]);
      if (configName) {
        try { config = JSON.parse(inheritedEnv[configName]); }
        catch { throw new Error("CodeBuddy 产品配置不是有效 JSON。"); }
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("CodeBuddy 产品配置必须是对象。");
        // Match CodeBuddy's legacy snapshot rules when promoting it to V3.
        if (configName !== "ACC_PRODUCT_CONFIG_V3") delete config.models;
        if (configName === "ACC_PRODUCT_CONFIG") delete config.authentication;
      }
      env.ACC_PRODUCT_CONFIG_V3 = JSON.stringify({
        ...config,
        models: [
          ...(Array.isArray(config.models) ? config.models.filter(model => model?.id !== launch.model) : []),
          { id: launch.model, name: launch.model, url: launch.baseUrl, tags: ["custom"] }
        ]
      });
    }
    return env;
  }
  if (agent !== "opencode") throw new Error("Unsupported Agent model target.");
  const source = SOURCES[launch.providerId];
  const provider = launch.providerId === "openrouter" ? undefined : {
    [source.id]: {
      name: launch.providerName,
      env: [launch.apiKeyEnv],
      package: source.package,
      settings: { baseURL: launch.baseUrl },
      models: { [launch.model]: { name: launch.model } }
    }
  };
  return {
    [launch.apiKeyEnv]: launch.apiKey,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: `${source.id}/${launch.model}`,
      ...(provider ? { providers: provider } : {}) })
  };
}

module.exports = { buildAgentModelEnvironment };
