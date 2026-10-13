const { savedMessage, SAVED_MESSAGE_VERSION } = require("../conversation-history/saved-message.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { readStatsBatches } = require("./stats-reader.cjs");
const { Pool } = require("pg");
const { encryptPortable, decryptPortable } = require("./backup-crypto.cjs");
const { readJson, writeJson } = require("../../stores/business-store-io.cjs");

const TABLES = ["token_sessions", "token_session_models", "token_session_skills", "token_session_mcp_tools", "token_daily"];
const PROVIDERS = ["codex", "claude", "codebuddy", "opencode", "qoder", "copilot", "gemini", "grok"];
const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const STATS_BATCH_SIZE = 500;

function safeName(value) { return String(value || "").trim().slice(0, 100); }
function validPort(value) { const n = Number(value); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 5432; }
function toError(error) { return error instanceof Error ? error.message : String(error); }
function localIdentity() { return `${os.hostname()} (${process.env.USERNAME || os.userInfo().username})`; }

function createPostgresBackupService({ userData, safeStorage, sessionStore, statsFile, dataStore,
  terminalManager, historyService, onChanged = () => {}, now = () => Date.now(),
  PoolClass = Pool, statsReader = readStatsBatches, fsApi = fs }) {
  const configFile = path.join(userData, "postgres-backup.json");
  let state = { deviceId: crypto.randomUUID(), deviceName: localIdentity(), enabled: false,
    host: "", port: 5432, database: "", user: "", ssl: true, password: "", passphrase: "",
    lastSuccessAt: null, lastError: "", pendingSources: [], sources: [], deviceMarker: "", statsEpoch: 0,
    snapshotKeyVersion: 0, snapshotHashKey: "" };
  let pool = null;
  let timer = null;
  let pending = false;
  let running = null;
  let interval = null;

  function encryptLocal(value) {
    if (!value) return "";
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("System credential encryption is unavailable.");
    return safeStorage.encryptString(value).toString("base64");
  }
  function decryptLocal(value) {
    if (!value) return "";
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("System credential encryption is unavailable.");
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }
  function load() {
    try {
      const saved = readJson(dataStore, configFile, fsApi);
      state = { ...state, ...saved, password: saved.password || "", passphrase: saved.passphrase || "" };
    } catch (error) { if (error.code !== "ENOENT") console.error("Failed to load PostgreSQL backup config:", error); }
    if (state.deviceMarker && safeStorage?.isEncryptionAvailable?.()) {
      try { decryptLocal(state.deviceMarker); }
      catch {
        state.deviceId = crypto.randomUUID();
        state.deviceName = localIdentity();
        state.enabled = false;
        state.password = "";
        state.passphrase = "";
        state.deviceMarker = "";
        state.snapshotHashKey = "";
      }
    }
    if (!state.deviceMarker && safeStorage?.isEncryptionAvailable?.()) {
      state.deviceMarker = encryptLocal(crypto.randomUUID());
    }
    if (!state.snapshotHashKey && safeStorage?.isEncryptionAvailable?.()) {
      state.snapshotHashKey = encryptLocal(crypto.randomBytes(32).toString("base64"));
    }
    if (!state.deviceId) state.deviceId = crypto.randomUUID();
    saveFile();
  }
  function saveFile() {
    if (!dataStore) fsApi.mkdirSync(path.dirname(configFile), { recursive: true });
    writeJson(dataStore, configFile, state, fsApi);
  }
  function publicState() {
    return { deviceId: state.deviceId, deviceName: state.deviceName, enabled: state.enabled,
      host: state.host, port: state.port, database: state.database, user: state.user,
      ssl: state.ssl, hasPassword: Boolean(state.password), hasPassphrase: Boolean(state.passphrase),
      lastSuccessAt: state.lastSuccessAt, lastError: state.lastError,
      pendingSources: state.pendingSources || [], running: Boolean(running) };
  }
  function connection(options = {}) {
    const password = options.password ?? decryptLocal(state.password);
    return new PoolClass({ host: options.host || state.host, port: validPort(options.port || state.port),
      database: options.database || state.database, user: options.user || state.user, password,
      ssl: (options.ssl ?? state.ssl) ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, max: 2 });
  }
  async function getPool() {
    if (!state.host || !state.database || !state.user || !state.password) throw new Error("PostgreSQL connection is incomplete.");
    if (!pool) pool = connection();
    return pool;
  }
  async function saveConfig(input = {}) {
    if (running) await running.catch(() => {});
    const next = { ...state, enabled: input.enabled === true,
      deviceName: safeName(input.deviceName) || state.deviceName,
      host: String(input.host || "").trim(), port: validPort(input.port),
      database: String(input.database || "").trim(), user: String(input.user || "").trim(),
      ssl: input.ssl !== false };
    if (typeof input.password === "string" && input.password) next.password = encryptLocal(input.password);
    if (typeof input.passphrase === "string" && input.passphrase) {
      if (input.passphrase !== decryptLocal(state.passphrase)) next.snapshotKeyVersion = (state.snapshotKeyVersion || 0) + 1;
      next.passphrase = encryptLocal(input.passphrase);
    }
    if (next.enabled && (!next.host || !next.database || !next.user || !next.password || !next.passphrase)) {
      throw new Error("Connection and backup passphrase must be configured before enabling backup.");
    }
    state = next;
    saveFile();
    if (pool) { await pool.end(); pool = null; }
    onChanged(publicState());
    if (state.enabled) schedule(0);
    return publicState();
  }
  async function testConnection(input = {}) {
    const testPool = connection(input);
    try { await testPool.query("SELECT 1"); return { ok: true }; }
    catch (error) { return { ok: false, error: toError(error) }; }
    finally { await testPool.end(); }
  }
  async function ensureSchema(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ph_devices (
        id UUID PRIMARY KEY, name TEXT NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ph_session_snapshots (
        id UUID PRIMARY KEY, device_id UUID NOT NULL REFERENCES ph_devices(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ph_snapshots_device_time ON ph_session_snapshots(device_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS ph_stat_rows (
        device_id UUID NOT NULL REFERENCES ph_devices(id), table_name TEXT NOT NULL,
        row_key TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY(device_id, table_name, row_key)
      );
      CREATE TABLE IF NOT EXISTS ph_conversations (
        device_id UUID NOT NULL REFERENCES ph_devices(id), source_key TEXT NOT NULL,
        conversation_ref TEXT NOT NULL, metadata JSONB NOT NULL,
        updated_at BIGINT NOT NULL, PRIMARY KEY(device_id, source_key, conversation_ref)
      );
      CREATE TABLE IF NOT EXISTS ph_messages (
        device_id UUID NOT NULL, source_key TEXT NOT NULL, conversation_ref TEXT NOT NULL,
        message_id TEXT NOT NULL, message_hash TEXT NOT NULL, data JSONB NOT NULL,
        PRIMARY KEY(device_id, source_key, conversation_ref, message_hash),
        FOREIGN KEY(device_id, source_key, conversation_ref)
          REFERENCES ph_conversations(device_id, source_key, conversation_ref) ON DELETE CASCADE
      );`);
    await client.query("CREATE TABLE IF NOT EXISTS ph_conversation_rules (device_id UUID PRIMARY KEY, version INTEGER NOT NULL)");
    await client.query("ALTER TABLE ph_conversations ADD COLUMN IF NOT EXISTS message_rule_version INTEGER NOT NULL DEFAULT 0");
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(317109, 1)");
      const primaryKey = await client.query(`SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='ph_messages'::regclass AND conname='ph_messages_pkey'`);
      if (primaryKey.rows[0]?.definition?.includes("message_id")) {
        await client.query("ALTER TABLE ph_messages ADD COLUMN IF NOT EXISTS message_hash TEXT");
        while (true) {
          const batch = (await client.query(`SELECT ctid::text AS row_tid, message_id FROM ph_messages
            WHERE message_hash IS NULL LIMIT 500`)).rows;
          if (!batch.length) break;
          const hashes = batch.map(row => ({ row_tid: row.row_tid,
            message_hash: crypto.createHash("sha256").update(row.message_id).digest("hex") }));
          await client.query(`UPDATE ph_messages AS messages SET message_hash=batch.message_hash
            FROM jsonb_to_recordset($1::jsonb) AS batch(row_tid TEXT, message_hash TEXT)
            WHERE messages.ctid=batch.row_tid::tid`, [JSON.stringify(hashes)]);
        }
        await client.query("ALTER TABLE ph_messages ALTER COLUMN message_hash SET NOT NULL");
        await client.query("ALTER TABLE ph_messages DROP CONSTRAINT ph_messages_pkey");
        await client.query(`ALTER TABLE ph_messages ADD CONSTRAINT ph_messages_pkey
          PRIMARY KEY(device_id, source_key, conversation_ref, message_hash)`);
      }
      const rule = await client.query("SELECT version FROM ph_conversation_rules WHERE device_id=$1", [state.deviceId]);
      if (Number(rule.rows[0]?.version || 0) < SAVED_MESSAGE_VERSION) {
        let cursor = null;
        while (true) {
          const rows = (await client.query(`SELECT source_key, conversation_ref, message_hash, data FROM ph_messages
            WHERE device_id=$1 ${cursor ? "AND (source_key, conversation_ref, message_hash) > ($2,$3,$4)" : ""}
            ORDER BY source_key, conversation_ref, message_hash LIMIT 500`, [state.deviceId, ...(cursor || [])])).rows;
          if (!rows.length) break;
          const retained = [];
          const removed = [];
          for (const row of rows) {
            const message = savedMessage(row.data);
            const key = { source_key: row.source_key, conversation_ref: row.conversation_ref, message_hash: row.message_hash };
            if (message) retained.push({ ...key, data: message });
            else removed.push(key);
          }
          if (retained.length) {
            await client.query(`UPDATE ph_messages AS messages SET data=batch.data
              FROM jsonb_to_recordset($2::jsonb) AS batch(source_key TEXT, conversation_ref TEXT, message_hash TEXT, data JSONB)
              WHERE messages.device_id=$1 AND messages.source_key=batch.source_key
                AND messages.conversation_ref=batch.conversation_ref AND messages.message_hash=batch.message_hash`,
            [state.deviceId, JSON.stringify(retained)]);
          }
          if (removed.length) {
            await client.query(`DELETE FROM ph_messages AS messages
              USING jsonb_to_recordset($2::jsonb) AS batch(source_key TEXT, conversation_ref TEXT, message_hash TEXT)
              WHERE messages.device_id=$1 AND messages.source_key=batch.source_key
                AND messages.conversation_ref=batch.conversation_ref AND messages.message_hash=batch.message_hash`,
            [state.deviceId, JSON.stringify(removed)]);
          }
          cursor = [rows.at(-1).source_key, rows.at(-1).conversation_ref, rows.at(-1).message_hash];
        }
        await client.query(`INSERT INTO ph_conversation_rules VALUES($1,$2)
          ON CONFLICT(device_id) DO UPDATE SET version=excluded.version`, [state.deviceId, SAVED_MESSAGE_VERSION]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  function sourceKey(session) {
    return JSON.stringify([session.type, session.type === "ssh" ? session.sshConfig?.host || "" : "",
      session.type === "ssh" ? session.sshConfig?.username || "" : "",
      session.type === "ssh" ? session.sshConfig?.port || 22 : null,
      session.type === "wsl" ? session.wslDistro || "" : "",
      session.type === "windows" ? String(session.cwd || "").replace(/\\/g, "/").toLowerCase() : session.cwd || ""]);
  }
  function trackSessions(sessions) {
    const known = new Map((state.sources || []).map(source => [sourceKey(source), source]));
    for (const session of sessions || []) {
      if (!session.cwd || !["windows", "wsl", "ssh"].includes(session.type)) continue;
      known.set(sourceKey(session), { type: session.type, cwd: session.cwd,
        wslDistro: session.wslDistro,
        agentLocation: session.agentLocation,
        runtimeCwd: session.runtimeCwd || session.localAgentCwd,
        sshConfig: session.type === "ssh" ? { host: session.sshConfig?.host,
          username: session.sshConfig?.username, port: session.sshConfig?.port } : undefined });
    }
    const sources = [...known.values()];
    if (JSON.stringify(sources) !== JSON.stringify(state.sources || [])) {
      state.sources = sources; saveFile(); schedule();
    }
  }
  function sessionPayload() {
    return sessionStore.exportLibrary({ includeEncryptedSecrets: true }).map(template => {
      const copy = structuredClone(template);
      if (copy.sshConfig?.encryptedSecret) {
        const clear = sessionStore.decryptSecret(copy.sshConfig.encryptedSecret);
        if (!clear) throw new Error(`Could not decrypt SSH secret for ${copy.title}.`);
        copy.sshConfig.secret = clear;
        delete copy.sshConfig.encryptedSecret;
      }
      return copy;
    });
  }
  async function uploadSessions(client) {
    const data = sessionPayload();
    const hash = `${state.snapshotKeyVersion || 0}:${crypto.createHmac("sha256", decryptLocal(state.snapshotHashKey))
      .update(JSON.stringify(data)).digest("hex")}`;
    const previous = await client.query("SELECT data FROM ph_session_snapshots WHERE device_id=$1 ORDER BY created_at DESC LIMIT 1", [state.deviceId]);
    if (previous.rows[0]?.data?.hash === hash) return;
    const archive = await encryptPortable(JSON.stringify(data), decryptLocal(state.passphrase));
    await client.query("INSERT INTO ph_session_snapshots(id,device_id,data) VALUES($1,$2,$3)",
      [crypto.randomUUID(), state.deviceId, { hash, sessionCount: data.length, archive }]);
  }
  async function uploadStats(client) {
    if (!fsApi.existsSync(statsFile)) return;
    const epoch = state.statsEpoch;
    const keysByTable = new Map(TABLES.map(table => [table, []]));
    await client.query("BEGIN");
    try {
      for await (const batch of statsReader({ statsFile, epoch, tables: TABLES, batchSize: STATS_BATCH_SIZE })) {
        for (const row of batch) keysByTable.get(row.table_name).push(row.row_key);
        await client.query(`INSERT INTO ph_stat_rows(device_id,table_name,row_key,data)
          SELECT $1, batch.table_name, batch.row_key, batch.data
          FROM jsonb_to_recordset($2::jsonb) AS batch(table_name TEXT, row_key TEXT, data JSONB)
          ON CONFLICT(device_id,table_name,row_key) DO UPDATE SET data=excluded.data
          WHERE ph_stat_rows.data IS DISTINCT FROM excluded.data`,
        [state.deviceId, JSON.stringify(batch)]);
      }
      for (const table of TABLES) {
        await client.query(`DELETE FROM ph_stat_rows
          WHERE device_id=$1 AND table_name=$2 AND split_part(row_key, ':', 1)=$3
            AND NOT (row_key = ANY($4::text[]))`, [state.deviceId, table, String(epoch), keysByTable.get(table)]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  async function uploadConversations(client) {
    const activeSessions = terminalManager.listSessions();
    trackSessions(activeSessions);
    const sources = state.sources.map(source => {
      const active = activeSessions.find(item => sourceKey(item) === sourceKey(source));
      return active ? terminalManager.getSession(active.id) : source;
    })
      .filter(source => source.type === "windows" || source.type === "ssh" && source.agentLocation === "local" ||
        activeSessions.some(active => active.id === source.id));
    const pendingSources = state.sources.filter(source => source.type !== "windows" &&
      !(source.type === "ssh" && source.agentLocation === "local") &&
      !activeSessions.some(active => sourceKey(active) === sourceKey(source)))
      .map(source => `${source.type === "ssh" ? source.sshConfig?.host || "SSH" : source.wslDistro || "WSL"} · ${source.cwd}`);
    const failed = [];
    for (const session of sources) {
      try {
        const key = sourceKey(session);
        if (!session.cwd) continue;
        let cursor = null;
        do {
          const page = await historyService.listHistoryForSession(session, { scope: "cwd", includeArchived: true, cursor, limit: 200 });
          if (page.errors?.length) failed.push(...page.errors.map(error => `${key}: ${error.message}`));
          const existing = page.items.length ? await client.query(`SELECT conversation_ref, updated_at, message_rule_version
            FROM ph_conversations WHERE device_id=$1 AND source_key=$2 AND conversation_ref = ANY($3::text[])`,
          [state.deviceId, key, page.items.map(item => item.ref)]) : { rows: [] };
          const existingByRef = new Map(existing.rows.map(row => [row.conversation_ref, row]));
          for (const item of page.items) {
            const old = existingByRef.get(item.ref);
            if (Number(old?.updated_at) === item.updatedAt && Number(old?.message_rule_version) === SAVED_MESSAGE_VERSION) continue;
            await client.query("BEGIN");
            try {
              await client.query(`INSERT INTO ph_conversations(device_id,source_key,conversation_ref,metadata,updated_at)
                VALUES($1,$2,$3,$4,$5) ON CONFLICT(device_id,source_key,conversation_ref)
                DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at`,
              [state.deviceId, key, item.ref, item, item.updatedAt]);
              let messageCursor = null;
              do {
                const messages = await historyService.getHistoryMessagesForSession(session, {
                  conversationRef: item.ref, cursor: messageCursor, limit: 200 });
                const batch = new Map();
                for (const value of messages.messages) {
                  const message = savedMessage(value);
                  if (!message) continue;
                  const hash = crypto.createHash("sha256").update(message.id).digest("hex");
                  // Keep the last value, matching sequential UPSERTs for duplicate IDs.
                  batch.set(hash, { message_id: message.id, message_hash: hash, data: message });
                }
                if (batch.size) {
                  await client.query(`INSERT INTO ph_messages(device_id,source_key,conversation_ref,message_id,message_hash,data)
                    SELECT $1, $2, $3, batch.message_id, batch.message_hash, batch.data
                    FROM jsonb_to_recordset($4::jsonb) AS batch(message_id TEXT, message_hash TEXT, data JSONB)
                    ON CONFLICT(device_id,source_key,conversation_ref,message_hash)
                    DO UPDATE SET message_id=excluded.message_id,data=excluded.data`,
                  [state.deviceId, key, item.ref, JSON.stringify([...batch.values()])]);
                }
                messageCursor = messages.nextCursor;
              } while (messageCursor);
              await client.query("UPDATE ph_conversations SET message_rule_version=$1 WHERE device_id=$2 AND source_key=$3 AND conversation_ref=$4", [SAVED_MESSAGE_VERSION, state.deviceId, key, item.ref]);
              await client.query("COMMIT");
            } catch (error) { await client.query("ROLLBACK"); throw error; }
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch (error) { failed.push(`${sourceKey(session)}: ${toError(error)}`); }
    }
    return { failed, pendingSources };
  }
  async function backupNow() {
    if (!state.enabled) return publicState();
    if (running) { pending = true; return running; }
    running = (async () => {
      let client;
      try {
        const db = await getPool();
        client = await db.connect();
        await ensureSchema(client);
        await client.query(`INSERT INTO ph_devices(id,name) VALUES($1,$2)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen_at=now()`, [state.deviceId, state.deviceName]);
        await uploadSessions(client);
        await uploadStats(client);
        const { failed, pendingSources } = await uploadConversations(client);
        if (!failed.length) state.lastSuccessAt = now();
        state.lastError = failed.join("; "); state.pendingSources = pendingSources; saveFile();
      } catch (error) {
        state.lastError = toError(error); state.pendingSources = []; saveFile();
        throw error;
      } finally { client?.release(); }
    })();
    onChanged(publicState());
    try { await running; }
    finally { running = null; onChanged(publicState()); if (pending) { pending = false; schedule(1000); } }
    return publicState();
  }
  function schedule(delay = 1000) {
    if (!state.enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void backupNow().catch(error => console.error("PostgreSQL backup failed:", error)); }, delay);
  }
  function newStatsEpoch() { state.statsEpoch += 1; saveFile(); schedule(); }
  function start() {
    if (state.enabled) schedule(0);
    interval = setInterval(() => { if (state.enabled) schedule(0); }, 5 * 60 * 1000);
  }
  async function withClient(work) { const db = await getPool(); const client = await db.connect(); try { await ensureSchema(client); return await work(client); } finally { client.release(); } }
  async function listDevices() { return withClient(async client => (await client.query("SELECT id,name,last_seen_at FROM ph_devices ORDER BY name")).rows); }
  async function getDashboard(options) {
    const { getRemoteDashboard } = require("./remote-dashboard.cjs");
    return withClient(client => getRemoteDashboard(client, options));
  }
  async function listSnapshots(deviceId) {
    return withClient(async client => (await client.query(`SELECT id,device_id,created_at,
      (data->>'sessionCount')::integer AS session_count FROM ph_session_snapshots
      WHERE device_id=$1 ORDER BY created_at DESC LIMIT 100`, [deviceId])).rows);
  }
  async function restoreSnapshot(snapshotId, passphrase) {
    return withClient(async client => {
      const result = await client.query("SELECT data FROM ph_session_snapshots WHERE id=$1", [snapshotId]);
      if (!result.rows.length) throw new Error("Backup snapshot was not found.");
      const key = passphrase || decryptLocal(state.passphrase);
      const sessions = JSON.parse(await decryptPortable(result.rows[0].data.archive, key));
      return sessionStore.importLibrary(sessions);
    });
  }
  async function listConversations(deviceId, offset = 0, limit = 100) {
    return withClient(async client => (await client.query(`SELECT source_key,conversation_ref,metadata
      FROM ph_conversations WHERE device_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
      [deviceId, Math.min(200, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0)])).rows);
  }
  async function getMessages(deviceId, sourceKeyValue, ref, offset = 0) {
    return withClient(async client => (await client.query(`SELECT data FROM ph_messages
      WHERE device_id=$1 AND source_key=$2 AND conversation_ref=$3
      ORDER BY (data->>'timestamp')::numeric DESC LIMIT 100 OFFSET $4`,
      [deviceId, sourceKeyValue, ref, Math.max(0, Number(offset) || 0)])).rows.map(row => row.data));
  }
  async function deleteDevice(deviceId) {
    if (deviceId === state.deviceId) {
      state.enabled = false;
      if (timer) { clearTimeout(timer); timer = null; }
      saveFile(); onChanged(publicState());
    }
    if (running) await running.catch(() => {});
    return withClient(async client => {
      await client.query("BEGIN");
      try {
        await client.query("DELETE FROM ph_messages WHERE device_id=$1", [deviceId]);
        await client.query("DELETE FROM ph_conversations WHERE device_id=$1", [deviceId]);
        await client.query("DELETE FROM ph_stat_rows WHERE device_id=$1", [deviceId]);
        await client.query("DELETE FROM ph_session_snapshots WHERE device_id=$1", [deviceId]);
        await client.query("DELETE FROM ph_devices WHERE id=$1", [deviceId]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      return true;
    });
  }
  async function shutdown() {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    if (running) await running.catch(() => {});
    if (pool) { await pool.end(); pool = null; }
  }
  return { load, start, schedule, trackSessions, newStatsEpoch, backupNow, publicState, saveConfig, testConnection, listDevices, getDashboard,
    listSnapshots, restoreSnapshot, listConversations, getMessages, deleteDevice, shutdown,
    getPool, withClient };
}

module.exports = { createPostgresBackupService, TOKEN_FIELDS, PROVIDERS };
