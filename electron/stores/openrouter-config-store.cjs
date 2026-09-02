const fs = require("node:fs");

const CODEX_INPUT_MODALITIES = ["text", "image", "audio"];

function normalizeInputModalities(values) {
  const available = new Set(Array.isArray(values)
    ? values.map(value => String(value || "").trim().toLowerCase()).filter(Boolean)
    : []);
  const supported = CODEX_INPUT_MODALITIES.filter(value => available.has(value));
  return supported.length ? supported : ["text"];
}

function normalizePrice(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  const numeric = Number(normalized);
  return normalized && Number.isFinite(numeric) && numeric >= 0 ? normalized : undefined;
}

function normalizeModel(model, { assumeCompatibleWhenCapabilitiesMissing = false } = {}) {
  const id = String(model?.id || "").trim();
  if (!id) return null;
  const supportedParameters = Array.isArray(model.supportedParameters || model.supported_parameters)
    ? [...new Set((model.supportedParameters || model.supported_parameters).map(value => String(value || "").trim()).filter(Boolean))]
    : [];
  const promptPrice = normalizePrice(model.pricing?.prompt);
  const completionPrice = normalizePrice(model.pricing?.completion);
  return {
    id,
    name: String(model.name || id).trim() || id,
    description: String(model.description || "").trim(),
    contextLength: Number.isFinite(Number(model.contextLength ?? model.context_length))
      ? Math.max(0, Math.trunc(Number(model.contextLength ?? model.context_length)))
      : 0,
    inputModalities: normalizeInputModalities(model.inputModalities || model.architecture?.input_modalities),
    supportedParameters,
    pricing: {
      ...(promptPrice !== undefined ? { prompt: promptPrice } : {}),
      ...(completionPrice !== undefined ? { completion: completionPrice } : {})
    },
    ...(typeof model.freeTierEligible === "boolean" ? { freeTierEligible: model.freeTierEligible } : {}),
    compatible: (supportedParameters.includes("tools") && supportedParameters.includes("tool_choice"))
      || (assumeCompatibleWhenCapabilitiesMissing && supportedParameters.length === 0)
  };
}

function normalizeVerification(value) {
  const statuses = new Set(["passed", "partial", "failed", "unavailable"]);
  const stageIds = new Set(["responses", "function_tools", "codex_tools"]);
  const errorKinds = new Set(["unsupported", "provider", "rate_limit", "timeout", "network", "unknown"]);
  if (!value || !statuses.has(value.status)) return null;
  const checkedAt = Number(value.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return null;
  const stages = Array.isArray(value.stages)
    ? value.stages.map(stage => {
      if (!stageIds.has(stage?.stage) || (stage.status !== "passed" && stage.status !== "failed")) return null;
      return {
        stage: stage.stage,
        status: stage.status,
        ...(String(stage.error || "").trim() ? { error: String(stage.error).trim().slice(0, 1000) } : {}),
        ...(errorKinds.has(stage.errorKind) ? { errorKind: stage.errorKind } : {}),
        ...(Number.isInteger(stage.httpStatus) ? { httpStatus: stage.httpStatus } : {}),
        ...(String(stage.errorCode || "").trim() ? { errorCode: String(stage.errorCode).trim().slice(0, 100) } : {}),
        ...(String(stage.provider || "").trim() ? { provider: String(stage.provider).trim().slice(0, 100) } : {}),
        ...(String(stage.requestId || "").trim() ? { requestId: String(stage.requestId).trim().slice(0, 200) } : {})
      };
    }).filter(Boolean)
    : [];
  return {
    status: value.status,
    checkedAt,
    ...(stages.length ? { stages } : {}),
    ...(stageIds.has(value.failedStage) ? { failedStage: value.failedStage } : {}),
    ...(String(value.error || "").trim() ? { error: String(value.error).trim().slice(0, 1000) } : {}),
    ...(errorKinds.has(value.errorKind) ? { errorKind: value.errorKind } : {}),
    ...(Number.isInteger(value.httpStatus) ? { httpStatus: value.httpStatus } : {}),
    ...(String(value.errorCode || "").trim() ? { errorCode: String(value.errorCode).trim().slice(0, 100) } : {}),
    ...(String(value.provider || "").trim() ? { provider: String(value.provider).trim().slice(0, 100) } : {}),
    ...(String(value.requestId || "").trim() ? { requestId: String(value.requestId).trim().slice(0, 200) } : {})
  };
}

function createOpenRouterConfigStore({ configFile, safeStorage, logger = console, providerName = "OpenRouter", assumeCompatibleWhenCapabilitiesMissing = false }) {
  let config = {
    encryptedApiKey: "",
    favoriteModelIds: [],
    defaultModelId: "",
    cachedModels: [],
    modelVerifications: {},
    fetchedAt: 0
  };

  function encrypt(value) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error(`系统安全存储不可用，无法保存 ${providerName} API Key。`);
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  function decrypt(value) {
    if (!value) return "";
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error(`系统安全存储不可用，无法读取 ${providerName} API Key。`);
    }
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }

  function serialize() {
    return {
      encryptedApiKey: config.encryptedApiKey,
      favoriteModelIds: [...config.favoriteModelIds],
      defaultModelId: config.defaultModelId,
      cachedModels: config.cachedModels.map(model => ({ ...model, pricing: { ...model.pricing }, supportedParameters: [...model.supportedParameters], inputModalities: [...model.inputModalities] })),
      modelVerifications: Object.fromEntries(Object.entries(config.modelVerifications).map(([id, verification]) => [id, { ...verification, ...(verification.stages ? { stages: verification.stages.map(stage => ({ ...stage })) } : {}) }])),
      fetchedAt: config.fetchedAt
    };
  }

  function save() {
    const tmpPath = `${configFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(serialize(), null, 2), "utf-8");
    fs.renameSync(tmpPath, configFile);
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const cachedModels = Array.isArray(parsed?.cachedModels)
        ? parsed.cachedModels.map(model => normalizeModel(model, { assumeCompatibleWhenCapabilitiesMissing })).filter(Boolean)
        : [];
      const availableIds = new Set(cachedModels.map(model => model.id));
      const favoriteModelIds = Array.isArray(parsed?.favoriteModelIds)
        ? [...new Set(parsed.favoriteModelIds.map(value => String(value || "").trim()).filter(id => availableIds.has(id)))]
        : [];
      const defaultModelId = favoriteModelIds.includes(parsed?.defaultModelId) ? parsed.defaultModelId : favoriteModelIds[0] || "";
      const modelVerifications = Object.fromEntries(Object.entries(parsed?.modelVerifications || {})
        .map(([id, value]) => [id, normalizeVerification(value)])
        .filter(([id, value]) => availableIds.has(id) && value));
      config = {
        encryptedApiKey: typeof parsed?.encryptedApiKey === "string" ? parsed.encryptedApiKey : "",
        favoriteModelIds,
        defaultModelId,
        cachedModels,
        modelVerifications,
        fetchedAt: Number.isFinite(parsed?.fetchedAt) ? parsed.fetchedAt : 0
      };
    } catch (error) {
      if (error.code !== "ENOENT") logger.error(`Failed to load ${providerName} config:`, error);
    }
  }

  function getPublicConfig() {
    return {
      hasApiKey: Boolean(config.encryptedApiKey),
      favoriteModelIds: [...config.favoriteModelIds],
      defaultModelId: config.defaultModelId || undefined,
      fetchedAt: config.fetchedAt || undefined
    };
  }

  function getApiKey() {
    return decrypt(config.encryptedApiKey);
  }

  function setApiKey(apiKey) {
    const value = String(apiKey || "").trim();
    if (!value) throw new Error(`${providerName} API Key 不能为空。`);
    config.encryptedApiKey = encrypt(value);
    config.modelVerifications = {};
    save();
    return getPublicConfig();
  }

  function clearApiKey() {
    config.encryptedApiKey = "";
    config.modelVerifications = {};
    save();
    return getPublicConfig();
  }

  function getCachedModels() {
    return config.cachedModels.map(model => ({ ...model, pricing: { ...model.pricing }, supportedParameters: [...model.supportedParameters], inputModalities: [...model.inputModalities] }));
  }

  function getModelVerifications() {
    return Object.fromEntries(Object.entries(config.modelVerifications).map(([id, verification]) => [id, { ...verification, ...(verification.stages ? { stages: verification.stages.map(stage => ({ ...stage })) } : {}) }]));
  }

  function setModelVerification(modelId, verification) {
    const id = String(modelId || "").trim();
    if (!config.cachedModels.some(model => model.id === id)) throw new Error(`${providerName} 模型不存在或目录尚未刷新：${id}`);
    const normalized = normalizeVerification(verification);
    if (!normalized) throw new Error(`${providerName} 模型验证状态无效：${id}`);
    config.modelVerifications[id] = normalized;
    save();
    return { ...normalized };
  }

  function setCachedModels(models, fetchedAt = Date.now()) {
    const normalized = Array.isArray(models) ? models.map(model => normalizeModel(model, { assumeCompatibleWhenCapabilitiesMissing })).filter(Boolean) : [];
    const byId = new Map(normalized.map(model => [model.id, model]));
    config.cachedModels = [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
    config.modelVerifications = Object.fromEntries(Object.entries(config.modelVerifications).filter(([id]) => byId.has(id)));
    config.favoriteModelIds = config.favoriteModelIds.filter(id => byId.has(id) && byId.get(id).compatible);
    if (!config.favoriteModelIds.includes(config.defaultModelId)) {
      config.defaultModelId = config.favoriteModelIds[0] || "";
    }
    config.fetchedAt = fetchedAt;
    save();
    return getCachedModels();
  }

  function setFavorites(favoriteModelIds, defaultModelId) {
    const byId = new Map(config.cachedModels.map(model => [model.id, model]));
    const ids = [...new Set((Array.isArray(favoriteModelIds) ? favoriteModelIds : []).map(value => String(value || "").trim()).filter(Boolean))];
    for (const id of ids) {
      const model = byId.get(id);
      if (!model) throw new Error(`${providerName} 模型不存在或目录尚未刷新：${id}`);
      if (!model.compatible) throw new Error(`模型 ${id} 缺少 Codex 所需的 tools/tool_choice 能力。`);
    }
    const nextDefault = String(defaultModelId || "").trim();
    if (nextDefault && !ids.includes(nextDefault)) throw new Error("默认模型必须位于收藏列表中。");
    config.favoriteModelIds = ids;
    config.defaultModelId = nextDefault || ids[0] || "";
    save();
    return getPublicConfig();
  }

  return {
    load,
    getPublicConfig,
    getApiKey,
    setApiKey,
    clearApiKey,
    getCachedModels,
    getModelVerifications,
    setModelVerification,
    setCachedModels,
    setFavorites
  };
}

module.exports = {
  CODEX_INPUT_MODALITIES,
  createOpenRouterConfigStore,
  normalizeInputModalities,
  normalizeVerification,
  normalizePrice,
  normalizeModel
};
