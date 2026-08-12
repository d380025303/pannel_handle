const fs = require("node:fs");

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function createTemplateUsageStore({ usageFile, now = () => Date.now(), windowMs = DEFAULT_WINDOW_MS }) {
  let launchesByTemplateId = {};

  function pruneTimestamps(timestamps, currentTime = now()) {
    const cutoff = currentTime - windowMs;
    return Array.isArray(timestamps)
      ? timestamps.filter(timestamp => Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= currentTime)
      : [];
  }

  function save() {
    try {
      const tmpPath = `${usageFile}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(launchesByTemplateId, null, 2), "utf-8");
      fs.renameSync(tmpPath, usageFile);
    } catch (err) {
      console.error("Failed to save template usage:", err);
    }
  }

  function load() {
    let parsed = {};
    let loadedFromFile = false;
    try {
      parsed = JSON.parse(fs.readFileSync(usageFile, "utf-8"));
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

  function getSummary(templateId) {
    const id = String(templateId || "").trim();
    const previous = launchesByTemplateId[id];
    const recent = pruneTimestamps(previous);
    launchesByTemplateId[id] = recent;
    if (recent.length === 0) delete launchesByTemplateId[id];
    if (Array.isArray(previous) && recent.length !== previous.length) save();
    return {
      recentLaunchCount: recent.length,
      lastLaunchedAt: recent.length > 0 ? Math.max(...recent) : undefined
    };
  }

  return { load, record, remove, getSummary };
}

module.exports = {
  DEFAULT_WINDOW_MS,
  createTemplateUsageStore
};
