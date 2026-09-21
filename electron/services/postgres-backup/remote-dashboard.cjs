const { TOKEN_FIELDS, PROVIDERS } = require("./postgres-backup-service.cjs");

function emptyTokens() { return Object.fromEntries(TOKEN_FIELDS.map(field => [field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), 0])); }
function tokenName(field) { return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function addTokens(total, row) { for (const field of TOKEN_FIELDS) total[tokenName(field)] += Number(row[field] || 0); }

async function getRemoteDashboard(client, { deviceId, range = "30d", provider = "all", offset = 0, limit = 50 } = {}) {
  const selectedProvider = PROVIDERS.includes(provider) ? provider : "all";
  const startAt = range === "7d" ? Date.now() - 7 * 86400000 : range === "30d" ? Date.now() - 30 * 86400000 : 0;
  const whereDevice = deviceId && deviceId !== "all" ? " AND device_id=$1" : "";
  const rows = (await client.query(`SELECT device_id,table_name,data FROM ph_stat_rows WHERE table_name IN
    ('token_sessions','token_daily','token_session_models','token_session_skills','token_session_mcp_tools')${whereDevice}`,
  whereDevice ? [deviceId] : [])).rows;
  const sessions = rows.filter(item => item.table_name === "token_sessions")
    .map(item => ({ ...item.data, deviceId: item.device_id }))
    .filter(row => row.provider !== "qwen" && (selectedProvider === "all" || row.provider === selectedProvider)
      && Number(row.updated_at) >= startAt);
  const ids = new Set(sessions.map(row => `${row.deviceId}:${row.backup_epoch || 0}:${row.id}`));
  const skills = rows.filter(item => item.table_name === "token_session_skills" && ids.has(`${item.device_id}:${item.data.backup_epoch || 0}:${item.data.session_id}`));
  const tools = rows.filter(item => item.table_name === "token_session_mcp_tools" && ids.has(`${item.device_id}:${item.data.backup_epoch || 0}:${item.data.session_id}`));
  const models = rows.filter(item => item.table_name === "token_session_models" && ids.has(`${item.device_id}:${item.data.backup_epoch || 0}:${item.data.session_id}`));
  const tokens = emptyTokens();
  for (const row of sessions) addTokens(tokens, row);
  const providerBreakdown = PROVIDERS.filter(id => selectedProvider === "all" || id === selectedProvider).map(id => {
    const matches = sessions.filter(row => row.provider === id); const totals = emptyTokens();
    for (const row of matches) addTokens(totals, row);
    return { provider: id, sessionCount: matches.length, tokens: totals };
  });
  const daily = new Map();
  for (const item of rows.filter(item => item.table_name === "token_daily")) {
    const row = item.data;
    if (row.provider === "qwen" || selectedProvider !== "all" && row.provider !== selectedProvider ||
      new Date(`${row.date}T00:00:00Z`).getTime() < startAt) continue;
    if (!daily.has(row.date)) daily.set(row.date, emptyTokens());
    addTokens(daily.get(row.date), row);
  }
  const skillCounts = new Map();
  for (const item of skills) skillCounts.set(item.data.name, (skillCounts.get(item.data.name) || 0) + Number(item.data.count || 0));
  const mcpCounts = new Map();
  for (const item of tools) {
    const key = `${item.data.server_name}\0${item.data.tool_name}`;
    mcpCounts.set(key, (mcpCounts.get(key) || 0) + Number(item.data.count || 0));
  }
  const mcpServers = new Map();
  for (const [key, count] of mcpCounts) {
    const [name, toolName] = key.split("\0");
    if (!mcpServers.has(name)) mcpServers.set(name, { name, count: 0, tools: [] });
    const entry = mcpServers.get(name); entry.count += count; entry.tools.push({ name: toolName, count });
  }
  const pageSize = Math.min(200, Math.max(1, Number(limit) || 50));
  const pageOffset = Math.max(0, Number(offset) || 0);
  const page = sessions.sort((a, b) => Number(b.updated_at) - Number(a.updated_at)).slice(pageOffset, pageOffset + pageSize);
  return {
    generatedAt: Date.now(), range, provider: selectedProvider,
    summary: { sessionCount: sessions.length,
      averageTokens: sessions.length ? Math.round(tokens.totalTokens / sessions.length) : 0,
      skillCalls: skills.reduce((n, item) => n + Number(item.data.count || 0), 0),
      mcpCalls: tools.reduce((n, item) => n + Number(item.data.count || 0), 0), tokens },
    dailyTrend: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, tokens: value })),
    providerBreakdown,
    topSkills: [...skillCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    topMcpServers: [...mcpServers.values()].sort((a, b) => b.count - a.count),
    sessions: page.map(row => {
      const matches = item => item.device_id === row.deviceId && (item.data.backup_epoch || 0) === (row.backup_epoch || 0) && item.data.session_id === row.id;
      const sessionSkills = skills.filter(matches);
      const sessionTools = tools.filter(matches);
      const serverMap = new Map();
      for (const item of sessionTools) {
        const name = item.data.server_name;
        if (!serverMap.has(name)) serverMap.set(name, { name, count: 0, tools: [] });
        const entry = serverMap.get(name); const count = Number(item.data.count || 0);
        entry.count += count; entry.tools.push({ name: item.data.tool_name, count });
      }
      return { id: `${row.deviceId}:${row.backup_epoch || 0}:${row.id}`, provider: row.provider,
      agentSessionId: row.agent_session_id, panelSessionId: row.panel_session_id,
      templateId: row.template_id || undefined, title: row.title, cwd: row.cwd, location: row.location,
      models: models.filter(matches).map(item => item.data.model), startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
      endedAt: row.ended_at == null ? null : Number(row.ended_at),
      tokens: Object.fromEntries(TOKEN_FIELDS.map(field => [tokenName(field), Number(row[field] || 0)])),
      capabilities: { skills: { availability: row.skill_availability,
        totalCalls: sessionSkills.reduce((n, item) => n + Number(item.data.count || 0), 0),
        items: sessionSkills.map(item => ({ name: item.data.name, count: Number(item.data.count || 0) })) },
        mcp: { availability: row.mcp_availability, totalCalls: sessionTools.reduce((n, item) => n + Number(item.data.count || 0), 0),
          servers: [...serverMap.values()] } } };
    }),
    totalCount: sessions.length, offset: pageOffset, limit: pageSize
  };
}

module.exports = { getRemoteDashboard };
