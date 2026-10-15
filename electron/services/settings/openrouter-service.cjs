const fs = require("node:fs");
const path = require("node:path");
const { execFile: defaultExecFile } = require("node:child_process");

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

function buildCodexModelCatalog(models, providerName = "OpenRouter", capabilities = {}) {
  return {
    models: models.map((model, index) => {
      const reasoningLevels = buildReasoningLevels(model);
      return {
        slug: model.id,
        display_name: model.name,
        description: model.description || `${providerName} model ${model.id}`,
        base_instructions: "You are Codex, an agentic coding assistant. Follow the developer and user instructions provided in the conversation.",
        context_window: model.contextLength || capabilities.defaultContextWindow || 128000,
        max_context_window: model.contextLength || capabilities.defaultContextWindow || 128000,
        default_reasoning_level: reasoningLevels.length ? "medium" : null,
        supported_reasoning_levels: reasoningLevels,
        input_modalities: capabilities.textOnly ? ["text"] : toCodexInputModalities(model.inputModalities),
        supports_parallel_tool_calls: true,
        apply_patch_tool_type: "freeform",
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: index + 1,
        supports_reasoning_summaries: capabilities.reasoningSummaries !== false && reasoningLevels.length > 0,
        supports_reasoning_summary_parameter: capabilities.reasoningSummaries !== false && reasoningLevels.length > 0,
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

function buildChatBridgeVerificationRequest(model, stage = "codex_tools") {
  const base = {
    model: model.id,
    stream: true,
    store: false,
    max_output_tokens: 64,
    ...(model.supportedParameters?.includes("reasoning") || model.supportedParameters?.includes("reasoning_effort")
      ? { reasoning: { effort: "medium" } }
      : {})
  };
  if (stage === "responses") return { ...base, input: "Reply only OK." };
  if (stage === "function_tools") {
    return [
      {
        ...base,
        input: "Call mcp__codex_probe__echo exactly once with value OK.",
        tool_choice: { type: "function", name: "mcp__codex_probe__echo" },
        tools: [{ type: "function", name: "mcp__codex_probe__echo", description: "MCP compatibility probe", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }]
      },
      {
        ...base,
        input: "Call tool_search exactly once with query MCP tools.",
        tool_choice: { type: "tool_search" },
        tools: [{ type: "tool_search", execution: "client", description: "Search deferred MCP tool metadata.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }]
      }
    ];
  }
  return {
    ...base,
    input: "Call codex_probe_custom exactly once with input OK.",
    tool_choice: { type: "custom", name: "codex_probe_custom" },
    tools: [{ type: "custom", name: "codex_probe_custom", description: "Codex custom tool compatibility probe", format: { type: "text" } }]
  };
}

function parseVerificationStream(text, providerName = "OpenRouter") {
  let completedResponse;
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
    if (payload.type === "response.completed") completedResponse = payload.response || {};
    if (payload.type === "error" || payload.type === "response.failed") {
      const responseError = payload?.response?.error;
      const payloadError = payload?.error;
      const rawError = payloadError?.metadata?.raw?.error;
      const errorCode = String(
        responseError?.type
        || responseError?.code
        || payloadError?.type
        || payloadError?.code
        || rawError?.type
        || rawError?.code
        || payload?.code
        || ""
      ).trim();
      const requestId = String(
        responseError?.request_id
        || payloadError?.request_id
        || rawError?.request_id
        || payload?.request_id
        || ""
      ).trim();
      throw Object.assign(
        new Error(extractResponseError(payload) || `${providerName} Responses 流返回失败事件。`),
        {
          responseStreamFailure: true,
          ...(errorCode ? { errorCode } : {}),
          ...(requestId ? { requestId } : {})
        }
      );
    }
  }
  if (!completedResponse) throw new Error(`${providerName} Responses 流在完成前断开。`);
  return completedResponse;
}

function validateChatBridgeVerification(response, stage, requestIndex = 0) {
  const output = Array.isArray(response?.output) ? response.output : [];
  if (stage === "responses" && !output.some(item => item.type === "message" && item.content?.some(part => typeof part.text === "string"))) {
    throw new Error("模型未通过桥返回文本输出。");
  }
  if (stage === "function_tools" && requestIndex === 0 && !output.some(item => item.type === "function_call" && item.name === "mcp__codex_probe__echo")) {
    throw new Error("模型未通过桥返回 MCP 函数工具调用。");
  }
  if (stage === "function_tools" && requestIndex === 1 && !output.some(item => item.type === "tool_search_call" && item.execution === "client")) {
    throw new Error("模型未通过桥返回 MCP 延迟工具搜索调用。");
  }
  if (stage === "codex_tools" && !output.some(item => item.type === "custom_tool_call" && item.name === "codex_probe_custom")) {
    throw new Error("模型未通过桥返回 Codex custom 工具调用。");
  }
}

function normalizeNaraRouterPrice(value, usdToIdr) {
  const creditsPerThousand = Number(value);
  const exchangeRate = Number(usdToIdr);
  if (!Number.isFinite(creditsPerThousand) || creditsPerThousand < 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return undefined;
  return String(creditsPerThousand / exchangeRate / 1000);
}

function enrichNaraRouterModels(models, plansPayload, pricingPayload) {
  const plans = Array.isArray(plansPayload?.data) ? plansPayload.data : [];
  const prices = Array.isArray(pricingPayload?.data) ? pricingPayload.data : [];
  const usdToIdr = Number(pricingPayload?.usd_to_idr);
  const freePlan = plans.find(plan => String(plan?.code || "").toLowerCase() === "free");
  if (!freePlan || !Array.isArray(freePlan.models)) throw new Error("NaraRouter 未返回有效的免费套餐模型目录。");
  if (!prices.length || !Number.isFinite(usdToIdr) || usdToIdr <= 0) throw new Error("NaraRouter 未返回有效的模型价格目录。");

  const freeModelIds = new Set(freePlan.models.map(value => String(value || "").trim()).filter(Boolean));
  const pricesById = new Map(prices.map(price => [String(price?.alias || "").trim(), price]).filter(([id]) => id));
  return models.map(model => {
    const id = String(model?.id || "").trim();
    const price = pricesById.get(id);
    const prompt = normalizeNaraRouterPrice(price?.input_credit_per_1k, usdToIdr);
    const completion = normalizeNaraRouterPrice(price?.output_credit_per_1k, usdToIdr);
    return {
      ...model,
      freeTierEligible: freeModelIds.has(id),
      ...(prompt !== undefined || completion !== undefined ? {
        pricing: {
          ...(model?.pricing || {}),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(completion !== undefined ? { completion } : {})
        }
      } : {})
    };
  });
}

function createOpenRouterService({
  store,
  catalogFile,
  fetchImpl = globalThis.fetch,
  execFile = defaultExecFile,
  now = Date.now,
  verificationTimeoutMs = MODEL_VERIFICATION_TIMEOUT_MS,
  providerId = "openrouter",
  providerName = "OpenRouter",
  baseUrl = OPENROUTER_BASE_URL,
  apiKeyEnv = OPENROUTER_API_KEY_ENV,
  modelsRequireApiKey = false,
  connectionTestPath = "/key",
  verificationHeaders = { "X-OpenRouter-Metadata": "enabled" },
  metadataBaseUrl = "",
  responsesTransport,
  launchAdapter,
  catalogCapabilities = {},
  verificationRequestBuilder = buildVerificationRequest,
  verificationResultValidator = () => {},
  verificationStrategy = "fallback",
  transformModels = models => models,
  onOpenCodeModelsChanged = () => {}
}) {
  const rateLimitCooldowns = new Map();
  let credentialVersion = 0;

  function assertCurrentCredentials(version) {
    if (version !== credentialVersion) throw new Error(`${providerName} API Key 已变更，请重新验证模型。`);
  }

  function getConfig() {
    return store.getPublicConfig();
  }

  function listModels() {
    const verifications = store.getModelVerifications();
    const openCodeVerifications = store.getAgentModelVerifications?.("opencode") || {};
    const codeBuddyVerifications = store.getAgentModelVerifications?.("codebuddy") || {};
    return store.getCachedModels().map(model => ({
      ...model,
      ...(verifications[model.id] ? { verification: verifications[model.id] } : {}),
      agentVerifications: { ...(openCodeVerifications[model.id] ? { opencode: openCodeVerifications[model.id] } : {}),
        ...(codeBuddyVerifications[model.id] ? { codebuddy: codeBuddyVerifications[model.id] } : {}) }
    }));
  }

  function getAgentLaunchConfig(agent, requestedModel) {
    if (agent !== "opencode" && agent !== "codebuddy") throw new Error("Unsupported Agent model target.");
    const model = String(requestedModel || "").trim();
    if (!model) throw new Error(`请选择 ${providerName} 模型。`);
    if (agent === "codebuddy" && !store.getCachedModels().some(item => item.id === model))
      throw new Error(`${providerName} 模型不存在：${model}`);
    const verification = store.getAgentModelVerifications?.(agent)?.[model];
    if (verification?.status !== "passed") throw new Error(`${providerName} 模型尚未通过 ${agent === "opencode" ? "OpenCode" : "CodeBuddy"} 验证：${model}`);
    const apiKey = store.getApiKey();
    if (!apiKey) throw new Error(`请先配置 ${providerName} API Key。`);
    return { providerId, providerName, model, baseUrl, apiKey, apiKeyEnv };
  }

  function getOpenCodeRuntimeEnv() {
    const verified = store.getAgentModelVerifications?.("opencode") || {};
    if (!store.getCachedModels().some(model => verified[model.id]?.status === "passed")) return {};
    const apiKey = store.getApiKey();
    return apiKey ? { [providerId === "minimax" ? "MINIMAX_API_KEY" : apiKeyEnv]: apiKey } : {};
  }

  async function verifyAgentModels(input = {}) {
    const agent = input.agent;
    if (agent !== "opencode" && agent !== "codebuddy") throw new Error("Unsupported Agent model target.");
    const ids = [...new Set((Array.isArray(input.modelIds) ? input.modelIds : []).map(value => String(value || "").trim()).filter(Boolean))];
    const { runAgentModelProbe } = require("../model-sources/agent-model-probe.cjs");
    const version = credentialVersion;
    const results = [];
    for (const modelId of ids) {
      if (!store.getCachedModels().some(model => model.id === modelId)) throw new Error(`${providerName} 模型不存在：${modelId}`);
      const previous = store.getAgentModelVerifications?.(agent)?.[modelId];
      if (!input.force && previous?.status === "passed" && Date.now() - previous.checkedAt < MODEL_VERIFICATION_TTL_MS) {
        results.push({ modelId, ...previous });
        continue;
      }
      const apiKey = store.getApiKey();
      if (!apiKey) throw new Error(`请先配置 ${providerName} API Key。`);
      const result = await runAgentModelProbe({ agent, providerId, modelId, baseUrl, apiKey, apiKeyEnv });
      assertCurrentCredentials(version);
      results.push({ modelId, ...store.setAgentModelVerification(agent, modelId, result) });
    }
    if (agent === "opencode" && results.length) await onOpenCodeModelsChanged();
    return results;
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
    const [payload, plansPayload, pricingPayload] = await Promise.all([
      requestJson(`${baseUrl}/models`, {
        headers: {
          Accept: "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        }
      }),
      ...(metadataBaseUrl ? [
        requestJson(`${metadataBaseUrl}/plans`, { headers: { Accept: "application/json" } }),
        requestJson(`${metadataBaseUrl}/pricing`, { headers: { Accept: "application/json" } })
      ] : [])
    ]);
    let models = Array.isArray(payload?.data) ? payload.data : [];
    if (!models.length) throw new Error(`${providerName} 未返回可用模型目录。`);
    if (metadataBaseUrl) models = enrichNaraRouterModels(models, plansPayload, pricingPayload);
    models = transformModels(models);
    store.setCachedModels(models, now());
    await onOpenCodeModelsChanged();
    return listModels();
  }

  async function syncOpenCodeModels() {
    try {
      await onOpenCodeModelsChanged();
      return {};
    } catch (error) {
      return { openCodeSyncError: String(error?.message || error) };
    }
  }

  async function saveApiKey(apiKey) {
    const config = store.setApiKey(apiKey);
    credentialVersion += 1;
    rateLimitCooldowns.clear();
    return { ...config, ...await syncOpenCodeModels() };
  }

  async function clearApiKey() {
    const config = store.clearApiKey();
    credentialVersion += 1;
    rateLimitCooldowns.clear();
    return { ...config, ...await syncOpenCodeModels() };
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
    const headerRequestId = String(response.headers?.get?.("x-request-id") || response.headers?.get?.("cf-ray") || "").trim();
    try {
      const text = await response.text();
      if (!text.trim()) return { message: fallback, httpStatus: response.status, requestId: headerRequestId };
      try {
        const payload = JSON.parse(text);
        const detail = extractResponseError(payload);
        const errorCode = String(payload?.error?.code || payload?.error?.type || payload?.code || payload?.type || "").trim();
        const provider = String(payload?.error?.metadata?.provider_name || payload?.error?.metadata?.provider || payload?.provider || "").trim();
        const requestId = String(payload?.error?.request_id || payload?.request_id || headerRequestId).trim();
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
        return { message: text.trim() ? `${providerName} 请求失败（HTTP ${response.status}）：${text.trim().slice(0, 500)}` : fallback, httpStatus: response.status, requestId: headerRequestId };
      }
    } catch {
      return { message: fallback, httpStatus: response.status, requestId: headerRequestId };
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
    const errorCode = String(error?.errorCode || "").trim().toLowerCase();
    if (error?.name === "AbortError") return "timeout";
    if (error?.httpStatus === 429) return "rate_limit";
    if (/rate[_ -]?limit|quota/.test(errorCode)) return "rate_limit";
    if (error?.httpStatus === 408 || error?.httpStatus >= 500) return "provider";
    if (/service[_ -]?unavailable|internal[_ -]?error|server[_ -]?error/.test(errorCode)) return "provider";
    if (error?.httpStatus >= 400) return "unsupported";
    if (/validation[_ -]?error|bad[_ -]?request|unsupported|invalid/.test(errorCode)) return "unsupported";
    if (error instanceof TypeError || /fetch|network|socket|ECONN|ENOTFOUND/i.test(String(error?.message || error))) return "network";
    return "unknown";
  }

  async function runVerificationStage(model, apiKey, stage) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), verificationTimeoutMs);
    try {
      if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络请求。");
      const requests = verificationRequestBuilder(model, stage);
      const requestList = Array.isArray(requests) ? requests : [requests];
      for (let requestIndex = 0; requestIndex < requestList.length; requestIndex += 1) {
        const body = requestList[requestIndex];
        const response = responsesTransport
          ? await responsesTransport({ apiKey, body, signal: controller.signal })
          : await fetchImpl(`${baseUrl}/responses`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: "text/event-stream",
              "Content-Type": "application/json",
              ...verificationHeaders
            },
            body: JSON.stringify(body),
            signal: controller.signal
          });
        if (!response.ok) {
          const detail = await readErrorResponse(response);
          throw Object.assign(new Error(detail.message), detail);
        }
        verificationResultValidator(parseVerificationStream(await response.text(), providerName), stage, requestIndex);
      }
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

    const version = credentialVersion;
    const stageResults = new Map();
    const runStage = async stage => {
      const result = await runVerificationStage(model, apiKey, stage);
      assertCurrentCredentials(version);
      stageResults.set(stage, result);
      return result;
    };

    let status = "passed";
    let failure = null;
    const isOpenRouterFreeModel = providerName === "OpenRouter" && (id === "openrouter/free" || id.endsWith(":free"));
    if (verificationStrategy === "all") {
      for (const stage of VERIFICATION_STAGES) {
        const result = await runStage(stage);
        if (result.status === "failed") {
          failure = result;
          status = TRANSIENT_VERIFICATION_ERRORS.has(result.errorKind) ? "unavailable" : "failed";
          break;
        }
      }
    } else if (isOpenRouterFreeModel) {
      const functionTools = await runStage("function_tools");
      if (functionTools.status === "passed") {
        const codexTools = await runStage("codex_tools");
        if (codexTools.status === "failed") {
          status = "partial";
          failure = codexTools;
        }
      } else {
        failure = functionTools;
        status = TRANSIENT_VERIFICATION_ERRORS.has(functionTools.errorKind) ? "unavailable" : "failed";
        if (!TRANSIENT_VERIFICATION_ERRORS.has(functionTools.errorKind)) {
          const responses = await runStage("responses");
          if (responses.status === "failed") {
            status = TRANSIENT_VERIFICATION_ERRORS.has(responses.errorKind) ? "unavailable" : "failed";
            failure = responses;
          }
        }
      }
    } else {
      const codexTools = await runStage("codex_tools");
      if (codexTools.status === "failed") {
        failure = codexTools;
        status = TRANSIENT_VERIFICATION_ERRORS.has(codexTools.errorKind) ? "unavailable" : "failed";
        if (!TRANSIENT_VERIFICATION_ERRORS.has(codexTools.errorKind)) {
          const functionTools = await runStage("function_tools");
          if (functionTools.status === "passed") {
            status = "partial";
            failure = codexTools;
          } else if (TRANSIENT_VERIFICATION_ERRORS.has(functionTools.errorKind)) {
            status = "unavailable";
            failure = functionTools;
          } else {
            const responses = await runStage("responses");
            if (responses.status === "passed") {
              status = "failed";
              failure = functionTools;
            } else {
              status = TRANSIENT_VERIFICATION_ERRORS.has(responses.errorKind) ? "unavailable" : "failed";
              failure = responses;
            }
          }
        }
      }
    }

    assertCurrentCredentials(version);
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
    const verifications = store.getModelVerifications();
    const models = store.getCachedModels().filter(model => model.compatible &&
      ["passed", "partial"].includes(verifications[model.id]?.status));
    if (!models.length) throw new Error(`请先验证至少一个兼容的 ${providerName} 模型。`);
    fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
    const tmpPath = `${catalogFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(buildCodexModelCatalog(models, providerName, catalogCapabilities), null, 2), "utf-8");
    fs.renameSync(tmpPath, catalogFile);
    return catalogFile;
  }

  function runCommand(file, args, options) {
    return new Promise(resolve => {
      execFile(file, args, options, (error, stdout) => {
        resolve({ error, stdout, status: error ? error.code : 0 });
      });
    });
  }

  async function toWslPath(windowsPath, distro) {
    const result = await runCommand("wsl.exe", ["-d", distro, "--", "wslpath", "-a", "-u", windowsPath], {
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

  async function assertCodexCompatibility(session) {
    const result = session.type === "wsl"
      ? await runCommand("wsl.exe", ["-d", session.wslDistro, "--", "sh", "-lc", "codex debug models --help"], { encoding: "utf-8", windowsHide: true, timeout: 10000 })
      : await runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex debug models --help"], { encoding: "utf-8", windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) {
      throw new Error("当前 Codex CLI 不支持自定义模型目录，请升级 Codex 后重试。");
    }
  }

  async function getLaunchConfig(session) {
    if (session.agentProvider !== "codex" || session.codexBackend !== providerId) return null;
    if (session.type === "ssh") throw new Error(`${providerName} Codex 首期仅支持 Windows 和 WSL 会话。`);
    const apiKey = store.getApiKey();
    if (!apiKey) throw new Error(`请先在设置中配置 ${providerName} API Key。`);
    const requestedModel = String(session.codexModel || "").trim();
    if (!requestedModel) throw new Error(`请选择 ${providerName} 模型。`);
    const verification = await verifyModel(requestedModel);
    const experimentalAllowed = verification.status === "partial" && session.codexExperimentalAcknowledged === true;
    if (verification.status !== "passed" && !experimentalAllowed) {
      if (verification.status === "partial") {
        throw new Error(`${providerName} 模型 ${requestedModel} 仅部分兼容 Codex；请在会话设置中确认实验风险后重试。`);
      }
      throw new Error(`${providerName} 模型 ${requestedModel} 未通过 Codex 兼容性检测：${verification.error || "未知错误"}`);
    }
    await assertCodexCompatibility(session);
    const windowsCatalogPath = writeCatalog();
    const config = {
      apiKey,
      providerId,
      providerName,
      apiKeyEnv,
      baseUrl,
      model: requestedModel,
      catalogPath: session.type === "wsl" ? await toWslPath(windowsCatalogPath, session.wslDistro) : windowsCatalogPath
    };
    return launchAdapter ? launchAdapter(session, config) : config;
  }

  return {
    getConfig,
    listModels,
    refreshModels,
    saveApiKey,
    clearApiKey,
    syncOpenCodeModels,
    testConnection,
    verifyModels,
    verifyAgentModels,
    getAgentLaunchConfig,
    getOpenCodeRuntimeEnv,
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
  buildChatBridgeVerificationRequest,
  validateChatBridgeVerification,
  parseVerificationStream,
  buildCodexModelCatalog,
  normalizeNaraRouterPrice,
  enrichNaraRouterModels,
  createOpenRouterService,
  toCodexInputModalities
};
