const fs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const CODEX_INPUT_MODALITIES = ["text", "image", "audio"];
const MODEL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_VERIFICATION_TIMEOUT_MS = 20000;
const MODEL_VERIFICATION_CONCURRENCY = 2;
const MODEL_VERIFICATION_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const VERIFICATION_STAGES = Object.freeze(["responses", "function_tools", "codex_tools"]);
const TRANSIENT_VERIFICATION_ERRORS = new Set(["timeout", "rate_limit", "provider", "network"]);

function toCodexInputModalities(values) {
  const available = new Set(Array.isArray(values) ? values : []);
  const supported = CODEX_INPUT_MODALITIES.filter(value => available.has(value));
  return supported.length ? supported : ["text"];
}

function buildReasoningLevels(model) {
  const parameters = new Set(model.supportedParameters || []);
  if (!parameters.has("reasoning") && !parameters.has("reasoning_effort")) return [];
  return [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth" },
    { effort: "high", description: "Greater reasoning depth for complex tasks" }
  ];
}

function buildCodexModelCatalog(models, providerName = "OpenRouter") {
  return {
    models: models.map((model, index) => {
      const reasoningLevels = buildReasoningLevels(model);
      return {
        slug: model.id,
        display_name: model.name,
        description: model.description || `${providerName} model ${model.id}`,
        base_instructions: "You are Codex, an agentic coding assistant. Follow the developer and user instructions provided in the conversation.",
        context_window: model.contextLength || 128000,
        max_context_window: model.contextLength || 128000,
        default_reasoning_level: reasoningLevels.length ? "medium" : null,
        supported_reasoning_levels: reasoningLevels,
        input_modalities: toCodexInputModalities(model.inputModalities),
        supports_parallel_tool_calls: true,
        apply_patch_tool_type: "freeform",
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: index + 1,
        supports_reasoning_summaries: reasoningLevels.length > 0,
        supports_reasoning_summary_parameter: reasoningLevels.length > 0,
        support_verbosity: false,
        truncation_policy: { mode: "tokens", limit: 10000 },
        experimental_supported_tools: []
      };
    })
  };
}

function extractResponseError(payload) {
  const raw = payload?.error?.metadata?.raw;
  return String(
    raw?.error?.message
    || raw?.message
    || payload?.error?.metadata?.message
    || payload?.error?.message
    || payload?.response?.error?.message
    || payload?.message
    || ""
  ).trim();
}

function buildVerificationRequest(model, stage = "codex_tools") {
  const parameters = new Set(model.supportedParameters || []);
  const request = {
    model: model.id,
    input: "Reply only OK. Do not call any tools.",
    stream: true,
    store: false,
    max_output_tokens: 64
  };
  if (stage === "responses") return request;
  request.parallel_tool_calls = true;
  request.tool_choice = "auto";
  request.tools = [
    {
      type: "function",
      name: "codex_probe",
      description: "A compatibility probe tool. Do not call it.",
      strict: false,
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  ];
  if (stage === "function_tools") return request;
  request.tools.push(
    {
      type: "custom",
      name: "apply_patch",
      description: "A compatibility probe for Codex custom tools. Do not call it.",
      format: { type: "grammar", syntax: "lark", definition: "start: /OK/" }
    }
  );
  return {
    ...request,
    ...(parameters.has("reasoning") || parameters.has("reasoning_effort")
      ? { reasoning: { effort: "medium", summary: "auto" } }
      : {})
  };
}

function parseVerificationStream(text, providerName = "OpenRouter") {
  let completed = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (payload.type === "response.completed") completed = true;
    if (payload.type === "error" || payload.type === "response.failed") {
      throw new Error(extractResponseError(payload) || `${providerName} Responses 流返回失败事件。`);
    }
  }
  if (!completed) throw new Error(`${providerName} Responses 流在完成前断开。`);
}

function createOpenRouterService({
  store,
  catalogFile,
  fetchImpl = globalThis.fetch,
  spawnSync = defaultSpawnSync,
  now = Date.now,
  verificationTimeoutMs = MODEL_VERIFICATION_TIMEOUT_MS,
  providerId = "openrouter",
  providerName = "OpenRouter",
  baseUrl = OPENROUTER_BASE_URL,
  apiKeyEnv = OPENROUTER_API_KEY_ENV,
  modelsRequireApiKey = false,
  connectionTestPath = "/key",
  verificationHeaders = { "X-OpenRouter-Metadata": "enabled" }
}) {
  const rateLimitCooldowns = new Map();

  function getConfig() {
    return store.getPublicConfig();
  }

  function listModels() {
    const verifications = store.getModelVerifications();
    return store.getCachedModels().map(model => ({
      ...model,
      ...(verifications[model.id] ? { verification: verifications[model.id] } : {})
    }));
  }

  async function requestJson(url, options = {}) {
    if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络请求。");
    const response = await fetchImpl(url, options);
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = String(payload?.error?.message || payload?.message || "").trim();
      } catch {}
      throw new Error(detail || `${providerName} 请求失败（HTTP ${response.status}）。`);
    }
    return response.json();
  }

  async function refreshModels() {
    const apiKey = modelsRequireApiKey ? store.getApiKey() : "";
    if (modelsRequireApiKey && !apiKey) throw new Error(`请先配置 ${providerName} API Key。`);
    const payload = await requestJson(`${baseUrl}/models`, {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      }
    });
    const models = Array.isArray(payload?.data) ? payload.data : [];
    if (!models.length) throw new Error(`${providerName} 未返回可用模型目录。`);
    store.setCachedModels(models, now());
    return listModels();
  }

  function saveApiKey(apiKey) {
    return store.setApiKey(apiKey);
  }

  function clearApiKey() {
    return store.clearApiKey();
  }

  async function testConnection() {
    const apiKey = store.getApiKey();
    if (!apiKey) throw new Error(`请先配置 ${providerName} API Key。`);
    await requestJson(`${baseUrl}${connectionTestPath}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
    });
    return { ok: true };
  }

  async function readErrorResponse(response) {
    const fallback = `${providerName} 请求失败（HTTP ${response.status}）。`;
    const requestId = String(response.headers?.get?.("x-request-id") || response.headers?.get?.("cf-ray") || "").trim();
    try {
      const text = await response.text();
      if (!text.trim()) return { message: fallback, httpStatus: response.status, requestId };
      try {
        const payload = JSON.parse(text);
        const detail = extractResponseError(payload);
        const errorCode = String(payload?.error?.code || payload?.code || "").trim();
        const provider = String(payload?.error?.metadata?.provider_name || payload?.error?.metadata?.provider || payload?.provider || "").trim();
        const context = [provider ? `provider: ${provider}` : "", errorCode ? `code: ${errorCode}` : ""].filter(Boolean).join("，");
        const prefix = context ? `${providerName} 请求失败（HTTP ${response.status}，${context}）` : `${providerName} 请求失败（HTTP ${response.status}）`;
        return {
          message: (detail ? `${prefix}：${detail}` : fallback).slice(0, 1000),
          httpStatus: response.status,
          errorCode,
          provider,
          requestId
        };
      } catch {
        return { message: text.trim() ? `${providerName} 请求失败（HTTP ${response.status}）：${text.trim().slice(0, 500)}` : fallback, httpStatus: response.status, requestId };
      }
    } catch {
      return { message: fallback, httpStatus: response.status, requestId };
    }
  }

  function isVerificationFresh(verification) {
    return (verification?.status === "passed" || verification?.status === "partial")
      && now() - verification.checkedAt < MODEL_VERIFICATION_TTL_MS;
  }

  function getRateLimitCooldown(modelId, existing) {
    const transient = rateLimitCooldowns.get(modelId);
    const persisted = existing?.status === "unavailable" && existing.errorKind === "rate_limit" ? existing : null;
    const cooldown = transient && (!persisted || transient.checkedAt >= persisted.checkedAt) ? transient : persisted;
    if (!cooldown || now() - cooldown.checkedAt >= MODEL_VERIFICATION_RATE_LIMIT_COOLDOWN_MS) {
      rateLimitCooldowns.delete(modelId);
      return null;
    }
    return cooldown;
  }

  function classifyError(error) {
    if (error?.name === "AbortError") return "timeout";
    if (error?.httpStatus === 429) return "rate_limit";
    if (error?.httpStatus === 408 || error?.httpStatus >= 500) return "provider";
    if (error?.httpStatus >= 400) return "unsupported";
    if (error instanceof TypeError || /fetch|network|socket|ECONN|ENOTFOUND/i.test(String(error?.message || error))) return "network";
    return "unknown";
  }

  async function runVerificationStage(model, apiKey, stage) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), verificationTimeoutMs);
    try {
      if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络请求。");
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...verificationHeaders
        },
        body: JSON.stringify(buildVerificationRequest(model, stage)),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await readErrorResponse(response);
        throw Object.assign(new Error(detail.message), detail);
      }
      parseVerificationStream(await response.text(), providerName);
      return { stage, status: "passed" };
    } catch (error) {
      const errorKind = classifyError(error);
      const message = error?.name === "AbortError"
        ? `${providerName} 模型验证超时（${Math.ceil(verificationTimeoutMs / 1000)} 秒）。`
        : String(error?.message || error || `${providerName} 模型验证失败。`);
      return {
        stage,
        status: "failed",
        error: message.slice(0, 1000),
        errorKind,
        ...(Number.isFinite(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
        ...(error?.errorCode ? { errorCode: String(error.errorCode).slice(0, 100) } : {}),
        ...(error?.provider ? { provider: String(error.provider).slice(0, 100) } : {}),
        ...(error?.requestId ? { requestId: String(error.requestId).slice(0, 200) } : {})
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function verifyModel(modelId, { force = false } = {}) {
    const id = String(modelId || "").trim();
    const model = store.getCachedModels().find(item => item.id === id);
    if (!model || !model.compatible) throw new Error(`模型 ${id} 缺少 Codex 所需的 tools/tool_choice 能力。`);
    const existing = store.getModelVerifications()[id];
    if (!force && isVerificationFresh(existing)) return { modelId: id, ...existing };
    const cooldown = getRateLimitCooldown(id, existing);
    if (cooldown) return { modelId: id, ...cooldown };
    const apiKey = store.getApiKey();
    if (!apiKey) throw new Error(`请先在设置中配置 ${providerName} API Key。`);

    const stageResults = new Map();
    const runStage = async stage => {
      const result = await runVerificationStage(model, apiKey, stage);
      stageResults.set(stage, result);
      return result;
    };

    const codexTools = await runStage("codex_tools");
    let status = "passed";
    let failure = null;
    if (codexTools.status === "failed") {
      failure = codexTools;
      status = TRANSIENT_VERIFICATION_ERRORS.has(codexTools.errorKind) ? "unavailable" : "failed";
      if (codexTools.errorKind === "unsupported") {
        const functionTools = await runStage("function_tools");
        if (functionTools.status === "passed") {
          status = "partial";
          failure = codexTools;
        } else if (TRANSIENT_VERIFICATION_ERRORS.has(functionTools.errorKind)) {
          status = "unavailable";
          failure = functionTools;
        } else if (functionTools.errorKind === "unsupported") {
          const responses = await runStage("responses");
          if (responses.status === "passed") {
            status = "failed";
            failure = functionTools;
          } else {
            status = TRANSIENT_VERIFICATION_ERRORS.has(responses.errorKind) ? "unavailable" : "failed";
            failure = responses;
          }
        } else {
          status = "failed";
          failure = functionTools;
        }
      }
    }

    const stages = VERIFICATION_STAGES.map(stage => stageResults.get(stage)).filter(Boolean);
    const verification = {
      status,
      checkedAt: now(),
      stages,
      ...(failure ? {
        failedStage: failure.stage,
        error: failure.error,
        errorKind: failure.errorKind,
        ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
        ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
        ...(failure.provider ? { provider: failure.provider } : {}),
        ...(failure.requestId ? { requestId: failure.requestId } : {})
      } : {})
    };
    if (status === "unavailable" && failure?.errorKind === "rate_limit") {
      rateLimitCooldowns.set(id, verification);
      if (isVerificationFresh(existing)) return { modelId: id, ...verification };
    } else {
      rateLimitCooldowns.delete(id);
    }
    const saved = store.setModelVerification(id, verification);
    return { modelId: id, ...saved };
  }

  async function verifyModels(input = {}) {
    const ids = [...new Set((Array.isArray(input.modelIds) ? input.modelIds : []).map(value => String(value || "").trim()).filter(Boolean))];
    const results = new Array(ids.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < ids.length) {
        const index = nextIndex++;
        results[index] = await verifyModel(ids[index], { force: Boolean(input.force) });
      }
    }
    await Promise.all(Array.from({ length: Math.min(MODEL_VERIFICATION_CONCURRENCY, ids.length) }, () => worker()));
    return results;
  }

  function writeCatalog() {
    const config = store.getPublicConfig();
    const byId = new Map(store.getCachedModels().map(model => [model.id, model]));
    const models = config.favoriteModelIds.map(id => byId.get(id)).filter(Boolean);
    if (!models.length) throw new Error(`请先收藏至少一个兼容的 ${providerName} 模型。`);
    fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
    const tmpPath = `${catalogFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(buildCodexModelCatalog(models, providerName), null, 2), "utf-8");
    fs.renameSync(tmpPath, catalogFile);
    return catalogFile;
  }

  async function setFavorites(input = {}) {
    const ids = Array.isArray(input.favoriteModelIds) ? input.favoriteModelIds : [];
    const verifications = await verifyModels({ modelIds: ids });
    const failures = verifications.filter(item => item.status === "failed" || item.status === "unavailable");
    if (failures.length) {
      throw new Error(failures.map(item => `${item.modelId}：${item.error || "验证失败"}`).join("\n"));
    }
    const config = store.setFavorites(input.favoriteModelIds, input.defaultModelId);
    if (config.favoriteModelIds.length) writeCatalog();
    return config;
  }

  function toWslPath(windowsPath, distro) {
    const result = spawnSync("wsl.exe", ["-d", distro, "--", "wslpath", "-a", "-u", windowsPath], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10000
    });
    const converted = String(result.stdout || "").trim();
    if (result.error || result.status !== 0 || !converted.startsWith("/")) {
      throw new Error(`无法将 ${providerName} 模型目录转换为 WSL 路径。`);
    }
    return converted;
  }

  function assertCodexCompatibility(session) {
    const result = session.type === "wsl"
      ? spawnSync("wsl.exe", ["-d", session.wslDistro, "--", "sh", "-lc", "codex debug models --help"], { encoding: "utf-8", windowsHide: true, timeout: 10000 })
      : spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex debug models --help"], { encoding: "utf-8", windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) {
      throw new Error("当前 Codex CLI 不支持自定义模型目录，请升级 Codex 后重试。");
    }
  }

  async function getLaunchConfig(session) {
    if (session.agentProvider !== "codex" || session.codexBackend !== providerId) return null;
    if (session.type === "ssh") throw new Error(`${providerName} Codex 首期仅支持 Windows 和 WSL 会话。`);
    const apiKey = store.getApiKey();
    if (!apiKey) throw new Error(`请先在设置中配置 ${providerName} API Key。`);
    const publicConfig = store.getPublicConfig();
    const requestedModel = String(session.codexModel || publicConfig.defaultModelId || "").trim();
    if (!publicConfig.favoriteModelIds.includes(requestedModel)) {
      throw new Error(`该会话的 ${providerName} 模型不在当前收藏列表中，请重新选择模型。`);
    }
    const verification = await verifyModel(requestedModel);
    const experimentalAllowed = verification.status === "partial" && session.codexExperimentalAcknowledged === true;
    if (verification.status !== "passed" && !experimentalAllowed) {
      if (verification.status === "partial") {
        throw new Error(`${providerName} 模型 ${requestedModel} 仅部分兼容 Codex；请在会话设置中确认实验风险后重试。`);
      }
      throw new Error(`${providerName} 模型 ${requestedModel} 未通过 Codex 兼容性检测：${verification.error || "未知错误"}`);
    }
    assertCodexCompatibility(session);
    const windowsCatalogPath = writeCatalog();
    return {
      apiKey,
      providerId,
      providerName,
      apiKeyEnv,
      baseUrl,
      model: requestedModel,
      catalogPath: session.type === "wsl" ? toWslPath(windowsCatalogPath, session.wslDistro) : windowsCatalogPath
    };
  }

  return {
    getConfig,
    listModels,
    refreshModels,
    saveApiKey,
    clearApiKey,
    testConnection,
    verifyModels,
    setFavorites,
    writeCatalog,
    getLaunchConfig
  };
}

module.exports = {
  OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY_ENV,
  MODEL_VERIFICATION_TTL_MS,
  MODEL_VERIFICATION_TIMEOUT_MS,
  MODEL_VERIFICATION_RATE_LIMIT_COOLDOWN_MS,
  VERIFICATION_STAGES,
  buildVerificationRequest,
  parseVerificationStream,
  buildCodexModelCatalog,
  createOpenRouterService,
  toCodexInputModalities
};
