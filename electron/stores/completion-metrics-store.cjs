const fs = require("node:fs");

const METRICS_VERSION = 1;
const RETENTION_DAYS = 30;
const MODES = new Set(["agent", "shell"]);
const SOURCES = new Set(["model", "history"]);

function emptyCounters() {
  return {
    shown: 0,
    accepted: 0,
    dismissed: 0,
    submittedAfterAccept: 0,
    zeroEditSubmissions: 0,
    editDistanceTotal: 0,
    finalLengthTotal: 0,
    errors: 0,
    latencyBuckets: { lt250: 0, lt1000: 0, lt3000: 0, gte3000: 0 }
  };
}

function emptyGroups() {
  return {
    agent: { model: emptyCounters(), history: emptyCounters() },
    shell: { model: emptyCounters(), history: emptyCounters() }
  };
}

function emptyMetrics() {
  return { version: METRICS_VERSION, totals: emptyGroups(), days: {} };
}

function normalizeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeCounters(value = {}) {
  const latency = value.latencyBuckets || {};
  return {
    shown: normalizeNumber(value.shown),
    accepted: normalizeNumber(value.accepted),
    dismissed: normalizeNumber(value.dismissed),
    submittedAfterAccept: normalizeNumber(value.submittedAfterAccept),
    zeroEditSubmissions: normalizeNumber(value.zeroEditSubmissions),
    editDistanceTotal: normalizeNumber(value.editDistanceTotal),
    finalLengthTotal: normalizeNumber(value.finalLengthTotal),
    errors: normalizeNumber(value.errors),
    latencyBuckets: {
      lt250: normalizeNumber(latency.lt250),
      lt1000: normalizeNumber(latency.lt1000),
      lt3000: normalizeNumber(latency.lt3000),
      gte3000: normalizeNumber(latency.gte3000)
    }
  };
}

function normalizeGroups(value = {}) {
  const result = emptyGroups();
  for (const mode of MODES) {
    for (const source of SOURCES) {
      result[mode][source] = normalizeCounters(value?.[mode]?.[source]);
    }
  }
  return result;
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createCompletionMetricsStore({ metricsFile, now = () => Date.now(), logger = console }) {
  let metrics = emptyMetrics();

  function pruneDays() {
    const cutoff = dateKey(now() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000);
    metrics.days = Object.fromEntries(
      Object.entries(metrics.days).filter(([day]) => day >= cutoff).sort(([left], [right]) => left.localeCompare(right))
    );
  }

  function save() {
    pruneDays();
    const tmpPath = `${metricsFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(metrics, null, 2), "utf-8");
    fs.renameSync(tmpPath, metricsFile);
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(metricsFile, "utf-8"));
      if (!parsed || parsed.version !== METRICS_VERSION) throw new Error("Unsupported completion metrics version.");
      const days = {};
      for (const [day, groups] of Object.entries(parsed.days || {})) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days[day] = normalizeGroups(groups);
      }
      metrics = { version: METRICS_VERSION, totals: normalizeGroups(parsed.totals), days };
      pruneDays();
    } catch (err) {
      metrics = emptyMetrics();
      if (err.code !== "ENOENT") logger.error("Failed to load completion metrics:", err);
    }
  }

  function mutate(mode, source, callback) {
    if (!MODES.has(mode) || !SOURCES.has(source)) return false;
    const day = dateKey(now());
    metrics.days[day] ||= emptyGroups();
    callback(metrics.totals[mode][source]);
    callback(metrics.days[day][mode][source]);
    save();
    return true;
  }

  function recordEvent({ mode, source, event, editDistance, finalLength, latencyMs }) {
    return mutate(mode, source, (counters) => {
      if (event === "shown") {
        counters.shown += 1;
        const latency = normalizeNumber(latencyMs);
        const bucket = latency < 250 ? "lt250" : latency < 1000 ? "lt1000" : latency < 3000 ? "lt3000" : "gte3000";
        counters.latencyBuckets[bucket] += 1;
      } else if (event === "accepted") {
        counters.accepted += 1;
      } else if (event === "dismissed") {
        counters.dismissed += 1;
      } else if (event === "submitted_after_accept") {
        const distance = normalizeNumber(editDistance);
        counters.submittedAfterAccept += 1;
        counters.editDistanceTotal += distance;
        counters.finalLengthTotal += normalizeNumber(finalLength);
        if (distance === 0) counters.zeroEditSubmissions += 1;
      }
    });
  }

  function recordError(mode, source = "model") {
    return mutate(mode, source, (counters) => {
      counters.errors += 1;
    });
  }

  function getMetrics() {
    pruneDays();
    return JSON.parse(JSON.stringify(metrics));
  }

  function clear() {
    metrics = emptyMetrics();
    save();
    return getMetrics();
  }

  return { load, recordEvent, recordError, getMetrics, clear };
}

module.exports = { METRICS_VERSION, RETENTION_DAYS, createCompletionMetricsStore, emptyMetrics };
