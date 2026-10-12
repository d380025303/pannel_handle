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

  function save() {
    try {
      writeJson(dataStore, usageFile, launchesByTemplateId);
    } catch (err) {
      console.error("Failed to save template usage:", err);
    }
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

    const currentTime = now();
    launchesByTemplateId = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [templateId, timestamps] of Object.entries(parsed)) {
        const recent = pruneTimestamps(timestamps, currentTime);
        if (recent.length > 0) launchesByTemplateId[templateId] = recent;
      }
    }
    if (loadedFromFile && JSON.stringify(parsed) !== JSON.stringify(launchesByTemplateId)) save();
    return launchesByTemplateId;
  }

  function record(templateId) {
    const id = String(templateId || "").trim();
    if (!id) return;
    const currentTime = now();
    launchesByTemplateId[id] = [...pruneTimestamps(launchesByTemplateId[id], currentTime), currentTime];
    save();
  }

  function remove(templateId) {
    const id = String(templateId || "").trim();
    if (!id || !Object.prototype.hasOwnProperty.call(launchesByTemplateId, id)) return;
    delete launchesByTemplateId[id];
    save();
  }

  function getSummaries(templateIds) {
    const summaries = new Map();
    const currentTime = now();
    let changed = false;
    for (const templateId of templateIds) {
      const id = String(templateId || "").trim();
      if (summaries.has(id)) continue;
      const previous = launchesByTemplateId[id];
      const recent = pruneTimestamps(previous, currentTime);
      if (recent.length > 0) launchesByTemplateId[id] = recent;
      else delete launchesByTemplateId[id];
      if (Array.isArray(previous) && recent.length !== previous.length) changed = true;
      summaries.set(id, {
        recentLaunchCount: recent.length,
        lastLaunchedAt: recent.length > 0 ? Math.max(...recent) : undefined
      });
    }
    if (changed) save();
    return summaries;
  }

  function getSummary(templateId) {
    return getSummaries([templateId]).get(String(templateId || "").trim());
  }

  return { load, record, remove, getSummary, getSummaries };
}

module.exports = {
  DEFAULT_WINDOW_MS,
  createTemplateUsageStore
};
