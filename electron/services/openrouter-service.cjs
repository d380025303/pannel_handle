const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

function sanitizeModel(model) {
  if (!model || typeof model !== "object") return undefined;
  const id = String(model.id || "").trim();
  if (!id || !Array.isArray(model.supported_parameters) || !model.supported_parameters.includes("tools")) return undefined;
  const outputModalities = model.architecture?.output_modalities;
  if (Array.isArray(outputModalities) && !outputModalities.includes("text")) return undefined;
  return {
    id,
    name: String(model.name || id),
    contextLength: Number.isFinite(model.context_length) ? model.context_length : undefined,
    promptPrice: typeof model.pricing?.prompt === "string" ? model.pricing.prompt : undefined,
    completionPrice: typeof model.pricing?.completion === "string" ? model.pricing.completion : undefined
  };
}

function createOpenRouterService({ configStore, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  let modelCache;

  async function request(path, apiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${OPENROUTER_BASE_URL}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error("OpenRouter API Key 无效。");
        if (response.status === 429) throw new Error("OpenRouter 请求过于频繁，请稍后重试。");
        throw new Error(`OpenRouter 请求失败（HTTP ${response.status}）。`);
      }
      return response.json();
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("OpenRouter 请求超时。");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  function requireApiKey() {
    const apiKey = configStore.getApiKey();
    if (!apiKey) throw new Error("请先在设置中配置 OpenRouter API Key。");
    return apiKey;
  }

  function getConfig() {
    return configStore.getConfig();
  }

  async function setApiKey(apiKey) {
    const value = String(apiKey || "").trim();
    if (!value) throw new Error("OpenRouter API Key 不能为空。");
    const payload = await request("/key", value);
    configStore.setApiKey(value);
    modelCache = undefined;
    return {
      ok: true,
      config: configStore.getConfig(),
      keyLabel: typeof payload?.data?.label === "string" ? payload.data.label : undefined,
      limitRemaining: Number.isFinite(payload?.data?.limit_remaining) ? payload.data.limit_remaining : undefined,
      expiresAt: typeof payload?.data?.expires_at === "string" ? payload.data.expires_at : undefined
    };
  }

  function clearApiKey() {
    modelCache = undefined;
    return configStore.clear();
  }

  async function testConnection() {
    const payload = await request("/key", requireApiKey());
    return {
      ok: true,
      config: configStore.getConfig(),
      keyLabel: typeof payload?.data?.label === "string" ? payload.data.label : undefined,
      limitRemaining: Number.isFinite(payload?.data?.limit_remaining) ? payload.data.limit_remaining : undefined,
      expiresAt: typeof payload?.data?.expires_at === "string" ? payload.data.expires_at : undefined
    };
  }

  async function listModels({ force = false } = {}) {
    if (!force && modelCache && now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
      return modelCache;
    }
    const payload = await request("/models/user", requireApiKey());
    const models = (Array.isArray(payload?.data) ? payload.data : [])
      .map(sanitizeModel)
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
    modelCache = { models, fetchedAt: now() };
    return modelCache;
  }

  return { getConfig, getApiKey: requireApiKey, setApiKey, clearApiKey, testConnection, listModels };
}

module.exports = { OPENROUTER_BASE_URL, createOpenRouterService, sanitizeModel };
