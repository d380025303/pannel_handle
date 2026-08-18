const fs = require("node:fs");
const {
  TOKEN_FIELDS,
  emptyCapabilityUsage,
  emptyTokens,
  normalizeCapabilityUsage,
  safeInteger
} = require("../services/agent-token-transcript.cjs");
const TOKEN_STATS_PROVIDERS = ["codex", "claude", "codebuddy"];
const STORE_VERSION = 2;

function cloneTokens(tokens) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, safeInteger(tokens?.[field])]));
}

function subtractTokens(current, baseline) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, Math.max(0, safeInteger(current?.[field]) - safeInteger(baseline?.[field]))]));
}

function addInto(target, source) {
  for (const field of TOKEN_FIELDS) target[field] += safeInteger(source?.[field]);
}

function capabilityItemsToMap(items) {
  return new Map((items || []).map(item => [String(item?.name || "").trim(), safeInteger(item?.count)]).filter(([name]) => name));
}

function subtractCapabilities(current, baseline) {
  const normalized = normalizeCapabilityUsage(current);
  const base = normalizeCapabilityUsage(baseline, "unavailable");
  const skills = capabilityItemsToMap(normalized.skills.items);
  for (const [name, count] of capabilityItemsToMap(base.skills.items)) skills.set(name, Math.max(0, (skills.get(name) || 0) - count));
  const baselineServers = new Map((base.mcp.servers || []).map(server => [server.name, capabilityItemsToMap(server.tools)]));
  const servers = normalized.mcp.servers.map(server => ({
    name: server.name,
    tools: server.tools.map(tool => ({
      name: tool.name,
      count: Math.max(0, tool.count - (baselineServers.get(server.name)?.get(tool.name) || 0))
    })).filter(tool => tool.count > 0)
  })).filter(server => server.tools.length > 0);
  return normalizeCapabilityUsage({
    skills: {
      availability: normalized.skills.availability,
      items: [...skills].map(([name, count]) => ({ name, count })).filter(item => item.count > 0)
    },
    mcp: { availability: normalized.mcp.availability, servers }
  });
}

function addCapabilityUsage(skillTotals, mcpTotals, capabilities) {
  if (capabilities?.skills?.availability === "available") {
    for (const item of capabilities.skills.items || []) skillTotals.set(item.name, (skillTotals.get(item.name) || 0) + safeInteger(item.count));
  }
  if (capabilities?.mcp?.availability === "available") {
    for (const server of capabilities.mcp.servers || []) {
      const current = mcpTotals.get(server.name) || { count: 0, tools: new Map() };
      current.count += safeInteger(server.count);
      for (const tool of server.tools || []) current.tools.set(tool.name, (current.tools.get(tool.name) || 0) + safeInteger(tool.count));
      mcpTotals.set(server.name, current);
    }
  }
}

function capabilityRankings(skillTotals, mcpTotals) {
  const topSkills = [...skillTotals].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  const topMcpServers = [...mcpTotals].map(([name, value]) => ({
    name,
    count: value.count,
    tools: [...value.tools].map(([toolName, count]) => ({ name: toolName, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  return { topSkills, topMcpServers };
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createAgentTokenStatsStore({ statsFile, now = () => Date.now(), onChanged = () => {} }) {
  let data = { version: STORE_VERSION, records: {}, daily: {}, baselines: {} };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statsFile, "utf-8"));
      if ([1, STORE_VERSION].includes(parsed?.version) && parsed.records && parsed.daily) {
        const unavailable = emptyCapabilityUsage("unavailable");
        const records = Object.fromEntries(Object.entries(parsed.records).map(([id, record]) => [id, {
          ...record,
          capabilities: record.capabilities ? normalizeCapabilityUsage(record.capabilities) : unavailable,
          rawCapabilities: record.rawCapabilities ? normalizeCapabilityUsage(record.rawCapabilities) : unavailable,
          baselineCapabilities: record.baselineCapabilities ? normalizeCapabilityUsage(record.baselineCapabilities) : unavailable
        }]));
        const baselines = Object.fromEntries(Object.entries(parsed.baselines || {}).map(([id, baseline]) => [id, baseline?.tokens ? {
          tokens: cloneTokens(baseline.tokens),
          capabilities: baseline.capabilities ? normalizeCapabilityUsage(baseline.capabilities) : unavailable
        } : {
          tokens: cloneTokens(baseline),
          capabilities: unavailable
        }]));
        data = { version: STORE_VERSION, records, daily: parsed.daily, baselines };
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

  function setBaseline(provider, agentSessionId, tokens, capabilities = emptyCapabilityUsage()) {
    const baseId = `${provider}:${agentSessionId}`;
    if (!data.records[baseId] && !data.baselines[baseId]) {
      data.baselines[baseId] = { tokens: cloneTokens(tokens), capabilities: normalizeCapabilityUsage(capabilities) };
      save();
    }
  }

  function update({ provider, agentSessionId, panelSessionId, templateId, title, cwd, location, models = [], tokens, capabilities = emptyCapabilityUsage(), startedAt, timestamp = now() }) {
    if (!TOKEN_STATS_PROVIDERS.includes(provider) || !agentSessionId) return undefined;
    const baseId = `${provider}:${agentSessionId}`;
    const rawTokens = cloneTokens(tokens);
    const rawCapabilities = normalizeCapabilityUsage(capabilities);
    let record = data.records[baseId];
    let recordId = baseId;
    if (record && rawTokens.totalTokens < safeInteger(record.rawTokens?.totalTokens)) {
      recordId = `${baseId}:${timestamp}`;
      record = undefined;
    }
    const baseline = data.baselines[baseId] || {};
    const baselineTokens = cloneTokens(record?.baselineTokens || baseline.tokens || emptyTokens());
    const baselineCapabilities = normalizeCapabilityUsage(record?.baselineCapabilities || baseline.capabilities || emptyCapabilityUsage());
    const visibleTokens = subtractTokens(rawTokens, baselineTokens);
    const visibleCapabilities = subtractCapabilities(rawCapabilities, baselineCapabilities);
    const previousTokens = cloneTokens(record?.tokens || emptyTokens());
    const delta = subtractTokens(visibleTokens, previousTokens);
    if (!record && visibleTokens.totalTokens === 0 && visibleCapabilities.skills.totalCalls === 0 && visibleCapabilities.mcp.totalCalls === 0) return undefined;

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
      capabilities: visibleCapabilities,
      rawTokens,
      rawCapabilities,
      baselineTokens,
      baselineCapabilities
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
    const summary = { sessionCount: records.length, averageTokens: 0, skillCalls: 0, mcpCalls: 0, tokens: emptyTokens() };
    const skillTotals = new Map();
    const mcpTotals = new Map();
    for (const record of records) {
      addInto(summary.tokens, record.tokens);
      summary.skillCalls += safeInteger(record.capabilities?.skills?.totalCalls);
      summary.mcpCalls += safeInteger(record.capabilities?.mcp?.totalCalls);
      addCapabilityUsage(skillTotals, mcpTotals, record.capabilities);
    }
    summary.averageTokens = records.length ? Math.round(summary.tokens.totalTokens / records.length) : 0;
    const rankings = capabilityRankings(skillTotals, mcpTotals);

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
      topSkills: rankings.topSkills,
      topMcpServers: rankings.topMcpServers,
      sessions: records.slice(offset, offset + limit).map(({ rawTokens, rawCapabilities, baselineTokens, baselineCapabilities, ...record }) => record),
      totalCount: records.length,
      offset,
      limit
    };
  }

  function clear() {
    for (const record of Object.values(data.records)) {
      if (record.status === "active") {
        data.baselines[`${record.provider}:${record.agentSessionId}`] = {
          tokens: cloneTokens(record.rawTokens),
          capabilities: normalizeCapabilityUsage(record.rawCapabilities)
        };
      }
    }
    data.records = {};
    data.daily = {};
    save();
    onChanged();
  }

  return { load, setBaseline, update, markEnded, getDashboard, clear };
}

module.exports = { createAgentTokenStatsStore, cloneTokens, subtractCapabilities, subtractTokens };
