const { customDateRange } = require("../token-usage/token-stats-range.cjs");
const { TOKEN_FIELDS, PROVIDERS } = require("./postgres-backup-service.cjs");

function emptyTokens() { return Object.fromEntries(TOKEN_FIELDS.map(field => [field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), 0])); }
function tokenName(field) { return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function addTokens(total, row) { for (const field of TOKEN_FIELDS) total[tokenName(field)] += Number(row[field] || 0); }

async function getRemoteDashboard(client, { deviceId, range = "30d", provider = "all", offset = 0, limit = 50, startDate, endDate } = {}) {
  const selectedProvider = PROVIDERS.includes(provider) ? provider : "all";
  const custom = range === "custom" ? customDateRange({ startDate, endDate }) : null;
  const startAt = custom ? custom.startAt : range === "7d" ? Date.now() - 7 * 86400000 : range === "30d" ? Date.now() - 30 * 86400000 : 0;
  const pageSize = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 50));
  const pageOffset = Math.max(0, Math.trunc(Number(offset)) || 0);
  const selectedDevice = deviceId && deviceId !== "all" ? deviceId : null;
  const tokenSums = TOKEN_FIELDS.map(field => `'${field}', COALESCE(SUM(COALESCE((data->>'${field}')::numeric, 0)), 0)`).join(", ");
  const dailySource = custom ? `(
    SELECT r.device_id, r.data FROM ph_stat_rows r WHERE r.table_name='token_daily_beijing'
    UNION ALL
    SELECT r.device_id, r.data || '{"approximate":1}'::jsonb FROM ph_stat_rows r
    WHERE r.table_name='token_daily' AND NOT EXISTS (
      SELECT 1 FROM ph_stat_rows c WHERE c.table_name='token_calendar' AND c.device_id=r.device_id
        AND c.data->>'id'='beijing'
        AND COALESCE(c.data->>'backup_epoch','0')=COALESCE(r.data->>'backup_epoch','0'))
  )` : "ph_stat_rows";
  // Keep filtering, aggregation and paging in one database snapshot. Only page
  // details and grouped totals cross the database connection.
  const rows = (await client.query(`WITH filtered_sessions AS (
    SELECT device_id, table_name, row_key, data FROM ph_stat_rows
    WHERE table_name='token_sessions' AND ($1::uuid IS NULL OR device_id=$1::uuid)
      AND (data->>'provider' IS DISTINCT FROM 'qwen')
      AND ($2::text='all' OR data->>'provider'=$2)
      AND COALESCE((data->>'updated_at')::numeric, 0) >= $3::numeric
      ${custom ? "AND COALESCE((data->>'updated_at')::numeric, 0) < $7::numeric" : ""}
  ), page AS (
    SELECT * FROM filtered_sessions ORDER BY COALESCE((data->>'updated_at')::numeric, 0) DESC,
      device_id, row_key LIMIT $4 OFFSET $5
  ), related AS (
    SELECT r.* FROM ph_stat_rows r WHERE r.table_name IN
      ('token_session_models','token_session_skills','token_session_mcp_tools')
      AND EXISTS (SELECT 1 FROM filtered_sessions s WHERE s.device_id=r.device_id
        AND COALESCE(s.data->>'backup_epoch','0')=COALESCE(r.data->>'backup_epoch','0')
        AND s.data->>'id'=r.data->>'session_id')
  )
  SELECT device_id, table_name, data FROM page
  UNION ALL
  SELECT r.device_id, r.table_name, r.data FROM related r
    WHERE EXISTS (SELECT 1 FROM page s WHERE s.device_id=r.device_id
      AND COALESCE(s.data->>'backup_epoch','0')=COALESCE(r.data->>'backup_epoch','0')
      AND s.data->>'id'=r.data->>'session_id')
  UNION ALL
  SELECT NULL::uuid, 'session_totals', jsonb_build_object('provider', data->>'provider',
    'session_count', COUNT(*), ${tokenSums}) FROM filtered_sessions GROUP BY data->>'provider'
  UNION ALL
  SELECT NULL::uuid, 'token_daily', jsonb_build_object('date', data->>'date', ${custom ? "'provider', data->>'provider', 'approximate', MAX(COALESCE((data->>'approximate')::integer,0))," : ""} ${tokenSums})
    FROM ${dailySource} daily_source WHERE ${custom ? "TRUE" : "table_name='token_daily'"} AND ($1::uuid IS NULL OR device_id=$1::uuid)
      AND (data->>'provider' IS DISTINCT FROM 'qwen')
      AND ($2::text='all' OR data->>'provider'=$2)
      AND (data->>'date') >= $6::text ${custom ? "AND (data->>'date') <= $8::text" : ""} GROUP BY data->>'date'${custom ? ", data->>'provider'" : ""}
  UNION ALL
  SELECT NULL::uuid, 'skill_totals', jsonb_build_object('name', data->>'name',
    'count', SUM(COALESCE((data->>'count')::numeric, 0))) FROM related
    WHERE table_name='token_session_skills' GROUP BY data->>'name'
  UNION ALL
  SELECT NULL::uuid, 'tool_totals', jsonb_build_object('server_name', data->>'server_name',
    'tool_name', data->>'tool_name', 'count', SUM(COALESCE((data->>'count')::numeric, 0)))
    FROM related WHERE table_name='token_session_mcp_tools'
    GROUP BY data->>'server_name', data->>'tool_name'`,
  [selectedDevice, selectedProvider, startAt, pageSize, pageOffset,
    custom ? custom.startDate : new Date(Math.ceil(startAt / 86400000) * 86400000).toISOString().slice(0, 10),
    ...(custom ? [custom.endAt, custom.endDate] : [])])).rows;
  const sessions = rows.filter(item => item.table_name === "token_sessions")
    .map(item => ({ ...item.data, deviceId: item.device_id }))
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
  const skills = rows.filter(item => item.table_name === "token_session_skills");
  const tools = rows.filter(item => item.table_name === "token_session_mcp_tools");
  const models = rows.filter(item => item.table_name === "token_session_models");
  const skillTotals = rows.filter(item => item.table_name === "skill_totals");
  const toolTotals = rows.filter(item => item.table_name === "tool_totals");
  const totals = rows.filter(item => item.table_name === "session_totals");
  const sessionCount = totals.reduce((n, item) => n + Number(item.data.session_count), 0);
  const tokens = emptyTokens();
  const tokenTotals = custom ? rows.filter(item => item.table_name === "token_daily") : totals;
  for (const item of tokenTotals) addTokens(tokens, item.data);
  const providerBreakdown = PROVIDERS.filter(id => selectedProvider === "all" || id === selectedProvider).map(id => {
    const matches = totals.filter(item => item.data.provider === id); const value = emptyTokens();
    for (const item of tokenTotals.filter(item => item.data.provider === id)) addTokens(value, item.data);
    return { provider: id, sessionCount: matches.reduce((n, item) => n + Number(item.data.session_count), 0), tokens: value };
  });
  const daily = new Map();
  for (const item of rows.filter(item => item.table_name === "token_daily")) {
    const row = item.data;
    if (!daily.has(row.date)) daily.set(row.date, emptyTokens());
    addTokens(daily.get(row.date), row);
  }
  const skillCounts = new Map();
  for (const item of skillTotals) skillCounts.set(item.data.name, (skillCounts.get(item.data.name) || 0) + Number(item.data.count || 0));
  const mcpCounts = new Map();
  for (const item of toolTotals) {
    const key = `${item.data.server_name}\0${item.data.tool_name}`;
    mcpCounts.set(key, (mcpCounts.get(key) || 0) + Number(item.data.count || 0));
  }
  const mcpServers = new Map();
  for (const [key, count] of mcpCounts) {
    const [name, toolName] = key.split("\0");
    if (!mcpServers.has(name)) mcpServers.set(name, { name, count: 0, tools: [] });
    const entry = mcpServers.get(name); entry.count += count; entry.tools.push({ name: toolName, count });
  }
  const page = sessions;
  return {
    generatedAt: Date.now(), range, provider: selectedProvider,
    ...(custom ? { startDate, endDate, timeZone: "Asia/Shanghai",
      approximate: tokenTotals.some(item => Number(item.data.approximate) > 0) } : {}),
    summary: { sessionCount,
      averageTokens: sessionCount ? Math.round(tokens.totalTokens / sessionCount) : 0,
      skillCalls: skillTotals.reduce((n, item) => n + Number(item.data.count || 0), 0),
      mcpCalls: toolTotals.reduce((n, item) => n + Number(item.data.count || 0), 0), tokens },
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
    totalCount: sessionCount, offset: pageOffset, limit: pageSize
  };
}

module.exports = { getRemoteDashboard };
