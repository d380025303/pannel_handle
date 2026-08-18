const fs = require("node:fs");
const { TOKEN_FIELDS, emptyTokens, safeInteger } = require("../services/agent-token-transcript.cjs");
const TOKEN_STATS_PROVIDERS = ["codex", "claude", "codebuddy"];

function cloneTokens(tokens) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, safeInteger(tokens?.[field])]));
}

function subtractTokens(current, baseline) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, Math.max(0, safeInteger(current?.[field]) - safeInteger(baseline?.[field]))]));
}

function addInto(target, source) {
  for (const field of TOKEN_FIELDS) target[field] += safeInteger(source?.[field]);
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createAgentTokenStatsStore({ statsFile, now = () => Date.now(), onChanged = () => {} }) {
  let data = { version: 1, records: {}, daily: {}, baselines: {} };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statsFile, "utf-8"));
      if (parsed?.version === 1 && parsed.records && parsed.daily) {
        data = { version: 1, records: parsed.records, daily: parsed.daily, baselines: parsed.baselines || {} };
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Failed to load Agent token statistics:", error);
    }
  }

  function save() {
    const temporary = `${statsFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(temporary, statsFile);
  }

  function setBaseline(provider, agentSessionId, tokens) {
    const baseId = `${provider}:${agentSessionId}`;
    if (!data.records[baseId] && !data.baselines[baseId]) {
      data.baselines[baseId] = cloneTokens(tokens);
      save();
    }
  }

  function update({ provider, agentSessionId, panelSessionId, templateId, title, cwd, location, models = [], tokens, startedAt, timestamp = now() }) {
    if (!TOKEN_STATS_PROVIDERS.includes(provider) || !agentSessionId) return undefined;
    const baseId = `${provider}:${agentSessionId}`;
    const rawTokens = cloneTokens(tokens);
    let record = data.records[baseId];
    let recordId = baseId;
    if (record && rawTokens.totalTokens < safeInteger(record.rawTokens?.totalTokens)) {
      recordId = `${baseId}:${timestamp}`;
      record = undefined;
    }
    const baselineTokens = cloneTokens(record?.baselineTokens || data.baselines[baseId] || emptyTokens());
    const visibleTokens = subtractTokens(rawTokens, baselineTokens);
    const previousTokens = cloneTokens(record?.tokens || emptyTokens());
    const delta = subtractTokens(visibleTokens, previousTokens);
    if (!record && visibleTokens.totalTokens === 0) return undefined;

    const nextRecord = {
      id: recordId,
      provider,
      agentSessionId,
      panelSessionId,
      ...(templateId ? { templateId } : {}),
      title: String(title || agentSessionId),
      cwd: String(cwd || ""),
      location: String(location || "windows"),
      models: [...new Set([...(record?.models || []), ...models.filter(Boolean).map(String)])],
      startedAt: record?.startedAt || startedAt || timestamp,
      updatedAt: timestamp,
      endedAt: record?.endedAt || null,
      status: "active",
      tokens: visibleTokens,
      rawTokens,
      baselineTokens
    };
    data.records[recordId] = nextRecord;
    delete data.baselines[baseId];

    if (delta.totalTokens > 0) {
      const date = dayKey(timestamp);
      data.daily[date] ||= {};
      data.daily[date][provider] ||= emptyTokens();
      addInto(data.daily[date][provider], delta);
    }
    save();
    onChanged();
    return nextRecord;
  }

  function markEnded(panelSessionId, timestamp = now()) {
    let changed = false;
    for (const record of Object.values(data.records)) {
      if (record.panelSessionId === panelSessionId && record.status !== "ended") {
        record.status = "ended";
        record.endedAt = timestamp;
        record.updatedAt = timestamp;
        changed = true;
      }
    }
    if (changed) { save(); onChanged(); }
  }

  function getDashboard(options = {}) {
    const range = ['7d', '30d', 'all'].includes(options.range) ? options.range : '30d';
    const provider = TOKEN_STATS_PROVIDERS.includes(options.provider) ? options.provider : 'all';
    const limit = Math.min(200, Math.max(1, safeInteger(options.limit) || 50));
    const offset = Math.max(0, safeInteger(options.offset));
    const days = range === '7d' ? 7 : range === '30d' ? 30 : null;
    const startAt = days ? now() - days * 86400000 : 0;
    const records = Object.values(data.records)
      .filter(record => record.updatedAt >= startAt && (provider === 'all' || record.provider === provider))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const summary = { sessionCount: records.length, averageTokens: 0, tokens: emptyTokens() };
    for (const record of records) addInto(summary.tokens, record.tokens);
    summary.averageTokens = records.length ? Math.round(summary.tokens.totalTokens / records.length) : 0;

    const providerBreakdown = TOKEN_STATS_PROVIDERS.map(id => {
      const providerTokens = emptyTokens();
      const matching = records.filter(record => record.provider === id);
      for (const record of matching) addInto(providerTokens, record.tokens);
      return { provider: id, sessionCount: matching.length, tokens: providerTokens };
    }).filter(item => provider === 'all' || item.provider === provider);

    const dailyTrend = Object.entries(data.daily)
      .filter(([date]) => new Date(`${date}T23:59:59.999Z`).getTime() >= startAt)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, providers]) => {
        const tokens = emptyTokens();
        for (const [id, values] of Object.entries(providers)) {
          if (provider === 'all' || provider === id) addInto(tokens, values);
        }
        return { date, tokens };
      });

    return {
      generatedAt: now(), range, provider, summary, dailyTrend, providerBreakdown,
      sessions: records.slice(offset, offset + limit).map(({ rawTokens, baselineTokens, ...record }) => record),
      totalCount: records.length,
      offset,
      limit
    };
  }

  function clear() {
    for (const record of Object.values(data.records)) {
      if (record.status === "active") data.baselines[`${record.provider}:${record.agentSessionId}`] = cloneTokens(record.rawTokens);
    }
    data.records = {};
    data.daily = {};
    save();
    onChanged();
  }

  return { load, setBaseline, update, markEnded, getDashboard, clear };
}

module.exports = { createAgentTokenStatsStore, cloneTokens, subtractTokens };
