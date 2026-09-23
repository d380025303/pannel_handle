const fs = require("node:fs");
const { readJson, writeJson } = require("./business-store-io.cjs");
const path = require("node:path");

function normalizeModel(model) {
  const id = String(model?.id || "").trim();
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
  const contextWindow = Number(model?.contextWindow);
  const promotions = Array.isArray(model?.promotions)
    ? model.promotions.filter(promotion => promotion && typeof promotion === "object").map(promotion => JSON.parse(JSON.stringify(promotion)))
    : [];
  return {
    id,
    name: String(model?.name || id).trim() || id,
    ...(Number.isSafeInteger(contextWindow) && contextWindow >= 1024 && contextWindow <= 1_000_000 ? { contextWindow } : {}),
    ...(promotions.length ? { promotions } : {})
  };
}

function createCodeBuddyCodexConfigStore({ configFile, dataStore, logger = console }) {
  let config = {
    catalogVersion: "",
    cachedModels: [],
    favoriteModelIds: [],
    defaultModelId: "",
    acknowledgedVersion: "",
    fetchedAt: 0
  };

  function serialize() {
    return {
      catalogVersion: config.catalogVersion,
      cachedModels: config.cachedModels.map(model => ({ ...model })),
      favoriteModelIds: [...config.favoriteModelIds],
      defaultModelId: config.defaultModelId,
      acknowledgedVersion: config.acknowledgedVersion,
      fetchedAt: config.fetchedAt
    };
  }

  function save() {
    if (!dataStore) fs.mkdirSync(path.dirname(configFile), { recursive: true });
    writeJson(dataStore, configFile, serialize());
  }

  function load() {
    try {
      const parsed = readJson(dataStore, configFile);
      const cachedModels = Array.isArray(parsed?.cachedModels) ? parsed.cachedModels.map(normalizeModel).filter(Boolean) : [];
      const availableIds = new Set(cachedModels.map(model => model.id));
      const favoriteModelIds = Array.isArray(parsed?.favoriteModelIds)
        ? [...new Set(parsed.favoriteModelIds.map(value => String(value || "").trim()).filter(id => availableIds.has(id)))]
        : [];
      config = {
        catalogVersion: String(parsed?.catalogVersion || "").trim(),
        cachedModels,
        favoriteModelIds,
        defaultModelId: favoriteModelIds.includes(parsed?.defaultModelId) ? parsed.defaultModelId : favoriteModelIds[0] || "",
        acknowledgedVersion: String(parsed?.acknowledgedVersion || "").trim(),
        fetchedAt: Number.isFinite(parsed?.fetchedAt) ? parsed.fetchedAt : 0
      };
    } catch (error) {
      if (error.code !== "ENOENT") logger.error("Failed to load CodeBuddy Codex config:", error);
    }
  }

  function getPublicConfig() {
    return {
      favoriteModelIds: [...config.favoriteModelIds],
      defaultModelId: config.defaultModelId || undefined,
      catalogVersion: config.catalogVersion || undefined,
      fetchedAt: config.fetchedAt || undefined,
      experimentalAcknowledged: Boolean(config.catalogVersion) && config.acknowledgedVersion === config.catalogVersion
    };
  }

  function getCachedModels() {
    return config.cachedModels.map(model => ({ ...model }));
  }

  function setCachedModels(version, models, fetchedAt = Date.now()) {
    const catalogVersion = String(version || "").trim();
    if (!catalogVersion) throw new Error("CodeBuddy CLI 版本不能为空。");
    const byId = new Map((Array.isArray(models) ? models : []).map(normalizeModel).filter(Boolean).map(model => [model.id, model]));
    const versionChanged = config.catalogVersion !== catalogVersion;
    const experimentalAcknowledged = Boolean(config.catalogVersion) && config.acknowledgedVersion === config.catalogVersion;
    config.catalogVersion = catalogVersion;
    config.cachedModels = [...byId.values()];
    config.favoriteModelIds = config.favoriteModelIds.filter(id => byId.has(id));
    config.defaultModelId = config.favoriteModelIds.includes(config.defaultModelId) ? config.defaultModelId : config.favoriteModelIds[0] || "";
    if (versionChanged && experimentalAcknowledged) config.acknowledgedVersion = catalogVersion;
    config.fetchedAt = fetchedAt;
    save();
    return getCachedModels();
  }

  function setFavorites(favoriteModelIds, defaultModelId) {
    const availableIds = new Set(config.cachedModels.map(model => model.id));
    const ids = [...new Set((Array.isArray(favoriteModelIds) ? favoriteModelIds : []).map(value => String(value || "").trim()).filter(Boolean))];
    for (const id of ids) {
      if (!availableIds.has(id)) throw new Error(`CodeBuddy 模型不存在或目录尚未刷新：${id}`);
    }
    const nextDefault = String(defaultModelId || "").trim();
    if (nextDefault && !ids.includes(nextDefault)) throw new Error("默认模型必须位于收藏列表中。");
    config.favoriteModelIds = ids;
    config.defaultModelId = nextDefault || ids[0] || "";
    save();
    return getPublicConfig();
  }

  function setExperimentalAcknowledged(acknowledged) {
    if (acknowledged && !config.catalogVersion) throw new Error("请先刷新 CodeBuddy 模型目录。");
    config.acknowledgedVersion = acknowledged ? config.catalogVersion : "";
    save();
    return getPublicConfig();
  }

  return { load, getPublicConfig, getCachedModels, setCachedModels, setFavorites, setExperimentalAcknowledged };
}

module.exports = { normalizeModel, createCodeBuddyCodexConfigStore };
