const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  TOKEN_FIELDS,
  emptyCapabilityUsage,
  emptyTokens,
  normalizeCapabilityUsage,
  safeInteger
} = require("../services/token-usage/agent-token-transcript.cjs");

const TOKEN_STATS_PROVIDERS = ["codex", "claude", "codebuddy", "qoder", "qwen", "copilot"];
const SCHEMA_VERSION = 4;
const LEGACY_STORE_VERSIONS = [1, 2];
const TOKEN_COLUMNS = {
  inputTokens: "input_tokens",
  cachedInputTokens: "cached_input_tokens",
  cacheWriteInputTokens: "cache_write_input_tokens",
  outputTokens: "output_tokens",
  reasoningOutputTokens: "reasoning_output_tokens",
  totalTokens: "total_tokens"
};

function cloneTokens(tokens) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, safeInteger(tokens?.[field])]));
}

function subtractTokens(current, baseline) {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, Math.max(0, safeInteger(current?.[field]) - safeInteger(baseline?.[field]))]));
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

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function tokenValues(tokens) {
  const normalized = cloneTokens(tokens);
  return TOKEN_FIELDS.map(field => normalized[field]);
}

function tokensFromRow(row, prefix = "") {
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, safeInteger(row?.[`${prefix}${TOKEN_COLUMNS[field]}`])]));
}

function tokenColumnList(prefix = "") {
  return TOKEN_FIELDS.map(field => `${prefix}${TOKEN_COLUMNS[field]}`).join(", ");
}

function tokenPlaceholders() {
  return TOKEN_FIELDS.map(() => "?").join(", ");
}

function createAgentTokenStatsStore({
  databaseFile,
  legacyStatsFile,
  legacyBackupFile = legacyStatsFile ? path.join(path.dirname(legacyStatsFile), "agent-token-stats.migrated-v2.json") : undefined,
  now = () => Date.now(),
  onChanged = () => {},
  fsApi = fs,
  Database = DatabaseSync
}) {
  let database = null;
  let loadError = null;

  function ensureLoaded() {
    if (!database) throw new Error("Agent token statistics database is not loaded.");
    if (loadError) throw new Error(`Agent token statistics database is unavailable: ${loadError.message}`);
  }

  function transaction(callback) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function createSchema() {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS stats_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS token_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'codebuddy', 'qoder', 'qwen', 'copilot')),
        agent_session_id TEXT NOT NULL,
        panel_session_id TEXT NOT NULL,
        template_id TEXT,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        location TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
        skill_availability TEXT NOT NULL,
        mcp_availability TEXT NOT NULL,
        ${TOKEN_FIELDS.map(field => `${TOKEN_COLUMNS[field]} INTEGER NOT NULL DEFAULT 0`).join(",\n        ")},
        ${TOKEN_FIELDS.map(field => `raw_${TOKEN_COLUMNS[field]} INTEGER NOT NULL DEFAULT 0`).join(",\n        ")},
        ${TOKEN_FIELDS.map(field => `baseline_${TOKEN_COLUMNS[field]} INTEGER NOT NULL DEFAULT 0`).join(",\n        ")},
        raw_capabilities_json TEXT NOT NULL,
        baseline_capabilities_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_token_sessions_updated_at ON token_sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_sessions_provider_updated_at ON token_sessions(provider, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_sessions_panel_session_id ON token_sessions(panel_session_id);
      CREATE INDEX IF NOT EXISTS idx_token_sessions_agent_session ON token_sessions(provider, agent_session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS token_session_models (
        session_id TEXT NOT NULL REFERENCES token_sessions(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        PRIMARY KEY (session_id, model)
      );

      CREATE TABLE IF NOT EXISTS token_session_skills (
        session_id TEXT NOT NULL REFERENCES token_sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (session_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_token_session_skills_name ON token_session_skills(name);

      CREATE TABLE IF NOT EXISTS token_session_mcp_tools (
        session_id TEXT NOT NULL REFERENCES token_sessions(id) ON DELETE CASCADE,
        server_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (session_id, server_name, tool_name)
      );
      CREATE INDEX IF NOT EXISTS idx_token_session_mcp_server ON token_session_mcp_tools(server_name, tool_name);

      CREATE TABLE IF NOT EXISTS token_daily (
        date TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'codebuddy', 'qoder', 'qwen', 'copilot')),
        ${TOKEN_FIELDS.map(field => `${TOKEN_COLUMNS[field]} INTEGER NOT NULL DEFAULT 0`).join(",\n        ")},
        PRIMARY KEY (date, provider)
      );

      CREATE TABLE IF NOT EXISTS token_baselines (
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'codebuddy', 'qoder', 'qwen', 'copilot')),
        agent_session_id TEXT NOT NULL,
        ${TOKEN_FIELDS.map(field => `${TOKEN_COLUMNS[field]} INTEGER NOT NULL DEFAULT 0`).join(",\n        ")},
        capabilities_json TEXT NOT NULL,
        PRIMARY KEY (provider, agent_session_id)
      );
    `);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  function migrateProviderConstraints(fromConstraint, toConstraint, suffix) {
    const tables = ["token_sessions", "token_daily", "token_baselines"];
    database.exec("PRAGMA foreign_keys = OFF");
    transaction(() => {
      for (const table of tables) {
        const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql;
        if (!schema) continue;
        const replacement = `${table}_provider_${suffix}`;
        const migratedSchema = schema
          .replace(new RegExp(`^CREATE TABLE\\s+[\"']?${table}[\"']?`, "i"), `CREATE TABLE ${replacement}`)
          .replace(fromConstraint, toConstraint);
        if (!migratedSchema.includes(toConstraint) || !new RegExp(`^CREATE TABLE\\s+${replacement}\\b`, "i").test(migratedSchema)) {
          throw new Error(`Could not migrate ${table} provider constraint.`);
        }
        database.exec(migratedSchema);
        const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(column => `"${column.name}"`).join(", ");
        database.exec(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
      }
    });
  }

  function getMeta(key) {
    return database.prepare("SELECT value FROM stats_meta WHERE key = ?").get(key)?.value;
  }

  function setMeta(key, value) {
    database.prepare("INSERT INTO stats_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  function getCapabilities(sessionId, row) {
    const skills = database.prepare("SELECT name, count FROM token_session_skills WHERE session_id = ? ORDER BY count DESC, name").all(sessionId);
    const toolRows = database.prepare("SELECT server_name, tool_name, count FROM token_session_mcp_tools WHERE session_id = ? ORDER BY server_name, count DESC, tool_name").all(sessionId);
    const servers = new Map();
    for (const tool of toolRows) {
      if (!servers.has(tool.server_name)) servers.set(tool.server_name, []);
      servers.get(tool.server_name).push({ name: tool.tool_name, count: safeInteger(tool.count) });
    }
    return normalizeCapabilityUsage({
      skills: { availability: row.skill_availability, items: skills },
      mcp: { availability: row.mcp_availability, servers: [...servers].map(([name, tools]) => ({ name, tools })) }
    });
  }

  function recordFromRow(row, { includePrivate = true, includeStatus = true } = {}) {
    if (!row) return undefined;
    const record = {
      id: row.id,
      provider: row.provider,
      agentSessionId: row.agent_session_id,
      panelSessionId: row.panel_session_id,
      ...(row.template_id ? { templateId: row.template_id } : {}),
      title: row.title,
      cwd: row.cwd,
      location: row.location,
      models: database.prepare("SELECT model FROM token_session_models WHERE session_id = ? ORDER BY model").all(row.id).map(item => item.model),
      startedAt: safeInteger(row.started_at),
      updatedAt: safeInteger(row.updated_at),
      endedAt: row.ended_at == null ? null : safeInteger(row.ended_at),
      tokens: tokensFromRow(row),
      capabilities: getCapabilities(row.id, row)
    };
    if (includeStatus) record.status = row.status;
    if (includePrivate) {
      record.rawTokens = tokensFromRow(row, "raw_");
      record.baselineTokens = tokensFromRow(row, "baseline_");
      record.rawCapabilities = normalizeCapabilityUsage(JSON.parse(row.raw_capabilities_json));
      record.baselineCapabilities = normalizeCapabilityUsage(JSON.parse(row.baseline_capabilities_json), "unavailable");
    }
    return record;
  }

  function replaceRecordDetails(record) {
    database.prepare("DELETE FROM token_session_models WHERE session_id = ?").run(record.id);
    const insertModel = database.prepare("INSERT INTO token_session_models(session_id, model) VALUES (?, ?)");
    for (const model of [...new Set(record.models.filter(Boolean).map(String))]) insertModel.run(record.id, model);

    database.prepare("DELETE FROM token_session_skills WHERE session_id = ?").run(record.id);
    const insertSkill = database.prepare("INSERT INTO token_session_skills(session_id, name, count) VALUES (?, ?, ?)");
    for (const skill of record.capabilities.skills.items) insertSkill.run(record.id, skill.name, safeInteger(skill.count));

    database.prepare("DELETE FROM token_session_mcp_tools WHERE session_id = ?").run(record.id);
    const insertTool = database.prepare("INSERT INTO token_session_mcp_tools(session_id, server_name, tool_name, count) VALUES (?, ?, ?, ?)");
    for (const server of record.capabilities.mcp.servers) {
      for (const tool of server.tools) insertTool.run(record.id, server.name, tool.name, safeInteger(tool.count));
    }
  }

  function writeRecord(record) {
    const columns = [
      "id", "provider", "agent_session_id", "panel_session_id", "template_id", "title", "cwd", "location",
      "started_at", "updated_at", "ended_at", "status", "skill_availability", "mcp_availability",
      ...TOKEN_FIELDS.map(field => TOKEN_COLUMNS[field]),
      ...TOKEN_FIELDS.map(field => `raw_${TOKEN_COLUMNS[field]}`),
      ...TOKEN_FIELDS.map(field => `baseline_${TOKEN_COLUMNS[field]}`),
      "raw_capabilities_json", "baseline_capabilities_json"
    ];
    const values = [
      record.id, record.provider, record.agentSessionId, record.panelSessionId, record.templateId || null,
      String(record.title || record.agentSessionId), String(record.cwd || ""), String(record.location || "windows"),
      safeInteger(record.startedAt), safeInteger(record.updatedAt), record.endedAt == null ? null : safeInteger(record.endedAt), record.status,
      record.capabilities.skills.availability, record.capabilities.mcp.availability,
      ...tokenValues(record.tokens), ...tokenValues(record.rawTokens), ...tokenValues(record.baselineTokens),
      JSON.stringify(normalizeCapabilityUsage(record.rawCapabilities)),
      JSON.stringify(normalizeCapabilityUsage(record.baselineCapabilities, "unavailable"))
    ];
    const updates = columns.slice(1).map(column => `${column} = excluded.${column}`).join(", ");
    database.prepare(`INSERT INTO token_sessions(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates}`).run(...values);
    replaceRecordDetails(record);
  }

  function writeBaseline(provider, agentSessionId, tokens, capabilities) {
    database.prepare(`
      INSERT INTO token_baselines(provider, agent_session_id, ${tokenColumnList()}, capabilities_json)
      VALUES (?, ?, ${tokenPlaceholders()}, ?)
      ON CONFLICT(provider, agent_session_id) DO UPDATE SET
        ${TOKEN_FIELDS.map(field => `${TOKEN_COLUMNS[field]} = excluded.${TOKEN_COLUMNS[field]}`).join(", ")},
        capabilities_json = excluded.capabilities_json
    `).run(provider, agentSessionId, ...tokenValues(tokens), JSON.stringify(normalizeCapabilityUsage(capabilities)));
  }

  function readBaseline(provider, agentSessionId) {
    const row = database.prepare("SELECT * FROM token_baselines WHERE provider = ? AND agent_session_id = ?").get(provider, agentSessionId);
    return row ? { tokens: tokensFromRow(row), capabilities: normalizeCapabilityUsage(JSON.parse(row.capabilities_json)) } : undefined;
  }

  function addDaily(date, provider, tokens) {
    database.prepare(`
      INSERT INTO token_daily(date, provider, ${tokenColumnList()}) VALUES (?, ?, ${tokenPlaceholders()})
      ON CONFLICT(date, provider) DO UPDATE SET
        ${TOKEN_FIELDS.map(field => `${TOKEN_COLUMNS[field]} = ${TOKEN_COLUMNS[field]} + excluded.${TOKEN_COLUMNS[field]}`).join(", ")}
    `).run(date, provider, ...tokenValues(tokens));
  }

  function normalizeLegacyRecord(id, record) {
    const unavailable = emptyCapabilityUsage("unavailable");
    const capabilities = record.capabilities ? normalizeCapabilityUsage(record.capabilities) : unavailable;
    return {
      ...record,
      id,
      templateId: record.templateId || undefined,
      models: Array.isArray(record.models) ? record.models : [],
      endedAt: record.endedAt ?? null,
      status: record.status === "ended" ? "ended" : "active",
      tokens: cloneTokens(record.tokens),
      capabilities,
      rawTokens: cloneTokens(record.rawTokens || record.tokens),
      rawCapabilities: record.rawCapabilities ? normalizeCapabilityUsage(record.rawCapabilities) : capabilities,
      baselineTokens: cloneTokens(record.baselineTokens || emptyTokens()),
      baselineCapabilities: record.baselineCapabilities ? normalizeCapabilityUsage(record.baselineCapabilities) : unavailable
    };
  }

  function importLegacyJson() {
    if (getMeta("legacy_json_imported")) return;
    if (!legacyStatsFile || !fsApi.existsSync(legacyStatsFile)) {
      setMeta("legacy_json_imported", "absent");
      return;
    }

    const parsed = JSON.parse(fsApi.readFileSync(legacyStatsFile, "utf-8"));
    if (!LEGACY_STORE_VERSIONS.includes(parsed?.version) || !parsed.records || !parsed.daily) {
      throw new Error("Unsupported Agent token statistics JSON format.");
    }
    const records = Object.entries(parsed.records).map(([id, record]) => normalizeLegacyRecord(id, record));
    const expectedTokens = records.reduce((total, record) => total + record.tokens.totalTokens, 0);

    transaction(() => {
      for (const record of records) writeRecord(record);
      for (const [date, providers] of Object.entries(parsed.daily || {})) {
        for (const [provider, tokens] of Object.entries(providers || {})) {
          if (TOKEN_STATS_PROVIDERS.includes(provider)) addDaily(date, provider, tokens);
        }
      }
      for (const [key, value] of Object.entries(parsed.baselines || {})) {
        const separator = key.indexOf(":");
        const provider = key.slice(0, separator);
        const agentSessionId = key.slice(separator + 1);
        if (!TOKEN_STATS_PROVIDERS.includes(provider) || !agentSessionId) continue;
        const baseline = value?.tokens ? value : { tokens: value, capabilities: emptyCapabilityUsage("unavailable") };
        writeBaseline(provider, agentSessionId, baseline.tokens, baseline.capabilities || emptyCapabilityUsage("unavailable"));
      }
      const verification = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_tokens), 0) AS total FROM token_sessions").get();
      if (Number(verification.count) !== records.length || Number(verification.total) !== expectedTokens) {
        throw new Error("Agent token statistics JSON migration verification failed.");
      }
      setMeta("legacy_json_imported", `v${parsed.version}`);
    });

    if (legacyBackupFile) {
      try {
        if (!fsApi.existsSync(legacyBackupFile)) fsApi.renameSync(legacyStatsFile, legacyBackupFile);
      } catch (error) {
        console.warn("Agent token statistics JSON was migrated but could not be renamed:", error);
      }
    }
  }

  function load() {
    try {
      database = new Database(databaseFile);
      const currentVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
      if (currentVersion > SCHEMA_VERSION) {
        throw new Error(`Unsupported Agent token statistics database version: ${currentVersion}.`);
      }
      if (currentVersion === 1) {
        migrateProviderConstraints(
          "provider IN ('codex', 'claude', 'codebuddy')",
          "provider IN ('codex', 'claude', 'codebuddy', 'qoder')",
          "v2"
        );
      }
      if (currentVersion <= 2) {
        migrateProviderConstraints(
          "provider IN ('codex', 'claude', 'codebuddy', 'qoder')",
          "provider IN ('codex', 'claude', 'codebuddy', 'qoder', 'qwen')",
          "v3"
        );
      }
      if (currentVersion <= 3) {
        migrateProviderConstraints(
          "provider IN ('codex', 'claude', 'codebuddy', 'qoder', 'qwen')",
          "provider IN ('codex', 'claude', 'codebuddy', 'qoder', 'qwen', 'copilot')",
          "v4"
        );
      }
      createSchema();
      importLegacyJson();
      loadError = null;
    } catch (error) {
      loadError = error;
      console.error("Failed to load Agent token statistics database:", error);
    }
  }

  function setBaseline(provider, agentSessionId, tokens, capabilities = emptyCapabilityUsage()) {
    if (loadError || !database || !TOKEN_STATS_PROVIDERS.includes(provider) || !agentSessionId) return;
    const hasRecord = database.prepare("SELECT 1 FROM token_sessions WHERE provider = ? AND agent_session_id = ? LIMIT 1").get(provider, agentSessionId);
    const hasBaseline = database.prepare("SELECT 1 FROM token_baselines WHERE provider = ? AND agent_session_id = ?").get(provider, agentSessionId);
    if (!hasRecord && !hasBaseline) transaction(() => writeBaseline(provider, agentSessionId, tokens, capabilities));
  }

  function update({ provider, agentSessionId, panelSessionId, templateId, title, cwd, location, models = [], tokens, capabilities = emptyCapabilityUsage(), startedAt, timestamp = now() }) {
    if (loadError || !database || !TOKEN_STATS_PROVIDERS.includes(provider) || !agentSessionId) return undefined;
    const rawTokens = cloneTokens(tokens);
    const rawCapabilities = normalizeCapabilityUsage(capabilities);
    const latestRow = database.prepare("SELECT * FROM token_sessions WHERE provider = ? AND agent_session_id = ? ORDER BY started_at DESC, updated_at DESC LIMIT 1").get(provider, agentSessionId);
    let record = latestRow ? recordFromRow(latestRow) : undefined;
    let recordId = record?.id || `${provider}:${agentSessionId}`;
    if (record && rawTokens.totalTokens < record.rawTokens.totalTokens) {
      recordId = `${provider}:${agentSessionId}:${timestamp}`;
      record = undefined;
    }
    const baseline = readBaseline(provider, agentSessionId) || {};
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
    transaction(() => {
      writeRecord(nextRecord);
      database.prepare("DELETE FROM token_baselines WHERE provider = ? AND agent_session_id = ?").run(provider, agentSessionId);
      if (delta.totalTokens > 0) addDaily(dayKey(timestamp), provider, delta);
    });
    onChanged();
    return nextRecord;
  }

  function markEnded(panelSessionId, timestamp = now()) {
    if (loadError || !database) return;
    const result = database.prepare("UPDATE token_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE panel_session_id = ? AND status <> 'ended'").run(timestamp, timestamp, panelSessionId);
    if (Number(result.changes) > 0) onChanged();
  }

  function queryFilter(provider, startAt, alias = "s") {
    const clauses = [`${alias}.updated_at >= ?`];
    const parameters = [startAt];
    if (provider !== "all") {
      clauses.push(`${alias}.provider = ?`);
      parameters.push(provider);
    }
    return { sql: clauses.join(" AND "), parameters };
  }

  function getDashboard(options = {}) {
    ensureLoaded();
    const range = ["7d", "30d", "all"].includes(options.range) ? options.range : "30d";
    const provider = TOKEN_STATS_PROVIDERS.includes(options.provider) ? options.provider : "all";
    const limit = Math.min(200, Math.max(1, safeInteger(options.limit) || 50));
    const offset = Math.max(0, safeInteger(options.offset));
    const days = range === "7d" ? 7 : range === "30d" ? 30 : null;
    const startAt = days ? now() - days * 86400000 : 0;
    const filter = queryFilter(provider, startAt);

    const totals = database.prepare(`SELECT COUNT(*) AS session_count, ${TOKEN_FIELDS.map(field => `COALESCE(SUM(${TOKEN_COLUMNS[field]}), 0) AS ${TOKEN_COLUMNS[field]}`).join(", ")} FROM token_sessions s WHERE ${filter.sql}`).get(...filter.parameters);
    const skillCalls = database.prepare(`SELECT COALESCE(SUM(k.count), 0) AS total FROM token_session_skills k JOIN token_sessions s ON s.id = k.session_id WHERE ${filter.sql}`).get(...filter.parameters).total;
    const mcpCalls = database.prepare(`SELECT COALESCE(SUM(m.count), 0) AS total FROM token_session_mcp_tools m JOIN token_sessions s ON s.id = m.session_id WHERE ${filter.sql}`).get(...filter.parameters).total;
    const sessionCount = safeInteger(totals.session_count);
    const summaryTokens = tokensFromRow(totals);
    const summary = {
      sessionCount,
      averageTokens: sessionCount ? Math.round(summaryTokens.totalTokens / sessionCount) : 0,
      skillCalls: safeInteger(skillCalls),
      mcpCalls: safeInteger(mcpCalls),
      tokens: summaryTokens
    };

    const breakdownRows = database.prepare(`SELECT provider, COUNT(*) AS session_count, ${TOKEN_FIELDS.map(field => `COALESCE(SUM(${TOKEN_COLUMNS[field]}), 0) AS ${TOKEN_COLUMNS[field]}`).join(", ")} FROM token_sessions s WHERE ${filter.sql} GROUP BY provider`).all(...filter.parameters);
    const breakdownByProvider = new Map(breakdownRows.map(row => [row.provider, row]));
    const providerBreakdown = TOKEN_STATS_PROVIDERS
      .filter(id => provider === "all" || id === provider)
      .map(id => ({ provider: id, sessionCount: safeInteger(breakdownByProvider.get(id)?.session_count), tokens: tokensFromRow(breakdownByProvider.get(id)) }));

    const dailyParameters = [dayKey(startAt), ...(provider === "all" ? [] : [provider])];
    const dailyRows = database.prepare(`SELECT date, ${TOKEN_FIELDS.map(field => `COALESCE(SUM(${TOKEN_COLUMNS[field]}), 0) AS ${TOKEN_COLUMNS[field]}`).join(", ")} FROM token_daily WHERE date >= ?${provider === "all" ? "" : " AND provider = ?"} GROUP BY date ORDER BY date`).all(...dailyParameters);
    const dailyTrend = dailyRows.map(row => ({ date: row.date, tokens: tokensFromRow(row) }));

    const topSkills = database.prepare(`SELECT k.name, SUM(k.count) AS count FROM token_session_skills k JOIN token_sessions s ON s.id = k.session_id WHERE ${filter.sql} GROUP BY k.name ORDER BY count DESC, k.name`).all(...filter.parameters).map(row => ({ name: row.name, count: safeInteger(row.count) }));
    const mcpRows = database.prepare(`SELECT m.server_name, m.tool_name, SUM(m.count) AS count FROM token_session_mcp_tools m JOIN token_sessions s ON s.id = m.session_id WHERE ${filter.sql} GROUP BY m.server_name, m.tool_name ORDER BY m.server_name, count DESC, m.tool_name`).all(...filter.parameters);
    const mcpServers = new Map();
    for (const row of mcpRows) {
      const current = mcpServers.get(row.server_name) || { name: row.server_name, count: 0, tools: [] };
      const count = safeInteger(row.count);
      current.count += count;
      current.tools.push({ name: row.tool_name, count });
      mcpServers.set(row.server_name, current);
    }
    const topMcpServers = [...mcpServers.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    const totalCount = sessionCount;
    const sessionRows = database.prepare(`SELECT * FROM token_sessions s WHERE ${filter.sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...filter.parameters, limit, offset);
    return {
      generatedAt: now(), range, provider, summary, dailyTrend, providerBreakdown, topSkills, topMcpServers,
      sessions: sessionRows.map(row => recordFromRow(row, { includePrivate: false, includeStatus: false })),
      totalCount, offset, limit
    };
  }

  function getSkillUsage(provider) {
    ensureLoaded();
    if (!TOKEN_STATS_PROVIDERS.includes(provider)) throw new Error("Unsupported Agent token statistics provider.");
    return database.prepare(`
      SELECT k.name, COALESCE(SUM(k.count), 0) AS count
      FROM token_session_skills k
      JOIN token_sessions s ON s.id = k.session_id
      WHERE s.provider = ?
      GROUP BY k.name
      ORDER BY count DESC, k.name
    `).all(provider).map(row => ({ name: row.name, count: safeInteger(row.count) }));
  }

  function clear() {
    ensureLoaded();
    const activeRows = database.prepare("SELECT * FROM token_sessions WHERE status = 'active'").all();
    const activeBaselines = activeRows.map(row => ({
      provider: row.provider,
      agentSessionId: row.agent_session_id,
      tokens: tokensFromRow(row, "raw_"),
      capabilities: normalizeCapabilityUsage(JSON.parse(row.raw_capabilities_json))
    }));
    transaction(() => {
      database.exec("DELETE FROM token_sessions; DELETE FROM token_daily; DELETE FROM token_baselines;");
      for (const baseline of activeBaselines) writeBaseline(baseline.provider, baseline.agentSessionId, baseline.tokens, baseline.capabilities);
    });
    onChanged();
  }

  function close() {
    if (!database) return;
    database.close();
    database = null;
  }

  return { load, setBaseline, update, markEnded, getDashboard, getSkillUsage, clear, close };
}

module.exports = { createAgentTokenStatsStore, cloneTokens, subtractCapabilities, subtractTokens };
