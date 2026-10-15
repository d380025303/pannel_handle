const { readJson, writeJson } = require("./business-store-io.cjs");

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function createTemplateUsageStore({ usageFile, dataStore, now = () => Date.now(), windowMs = DEFAULT_WINDOW_MS }) {
  let launchesByTemplateId = {};

  function pruneTimestamps(timestamps, currentTime = now()) {
    const cutoff = currentTime - windowMs;
    return Array.isArray(timestamps)
      ? timestamps.filter(timestamp => Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= currentTime)
      : [];
  }

  function pruneHistories(histories, currentTime) {
    const next = {};
    if (histories && typeof histories === "object" && !Array.isArray(histories)) {
      for (const [templateId, timestamps] of Object.entries(histories)) {
        const recent = pruneTimestamps(timestamps, currentTime);
        if (recent.length > 0) next[templateId] = recent;
      }
    }
    return next;
  }

  function save(next) {
    try {
      writeJson(dataStore, usageFile, next);
    } catch (err) {
      const error = new Error(`模板使用记录保存失败：${err.message}`, { cause: err });
      error.code = err.code;
      throw error;
    }
    launchesByTemplateId = next;
  }

  function load() {
    let parsed = {};
    let loadedFromFile = false;
    try {
      parsed = readJson(dataStore, usageFile);
      loadedFromFile = true;
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("Failed to load template usage:", err);
      }
    }

    const next = pruneHistories(parsed, now());
    if (loadedFromFile && JSON.stringify(parsed) !== JSON.stringify(next)) save(next);
    else launchesByTemplateId = next;
    return launchesByTemplateId;
  }

  function record(templateId) {
    const id = String(templateId || "").trim();
    if (!id) return;
    const currentTime = now();
    save({
      ...pruneHistories(launchesByTemplateId, currentTime),
      [id]: [...pruneTimestamps(launchesByTemplateId[id], currentTime), currentTime]
    });
  }

  function prepareRemoval(templateId) {
    const id = String(templateId || "").trim();
    const changed = Boolean(id && Object.prototype.hasOwnProperty.call(launchesByTemplateId, id));
    const next = { ...launchesByTemplateId };
    delete next[id];
    return {
      dataStore,
      filePath: usageFile,
      value: changed ? next : undefined,
      persist() { if (changed) writeJson(dataStore, usageFile, next); },
      commit() { if (changed) launchesByTemplateId = next; }
    };
  }

  function remove(templateId) {
    const id = String(templateId || "").trim();
    if (!id || !Object.prototype.hasOwnProperty.call(launchesByTemplateId, id)) return;
    const next = { ...launchesByTemplateId };
    delete next[id];
    save(next);
  }

  function getSummaries(templateIds) {
    const summaries = new Map();
    const currentTime = now();
    for (const templateId of templateIds) {
      const id = String(templateId || "").trim();
      if (summaries.has(id)) continue;
      const recent = pruneTimestamps(launchesByTemplateId[id], currentTime);
      summaries.set(id, {
        recentLaunchCount: recent.length,
        lastLaunchedAt: recent.length > 0 ? Math.max(...recent) : undefined
      });
    }
    return summaries;
  }

  function getSummary(templateId) {
    return getSummaries([templateId]).get(String(templateId || "").trim());
  }

  return { load, record, remove, prepareRemoval, getSummary, getSummaries };
}

module.exports = {
  DEFAULT_WINDOW_MS,
  createTemplateUsageStore
};
