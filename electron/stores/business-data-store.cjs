const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

// Keep retired CodeBuddy Codex sources readable for existing user databases and JSON imports.
const SOURCES = [
  "sessions.json", "config.json", "launch-templates.json", "template-usage.json",
  "environment-profiles.json", "openrouter.json", "nararouter.json", "minimax.json",
  "codebuddy-codex.json", "codebuddy-codex-verifications.json", "dingtalk.json",
  "known-hosts.json", "mobile-access.json", "postgres-backup.json"
];
const SOURCE_SET = new Set(SOURCES);
const MODEL_SOURCES = new Set(["openrouter.json", "nararouter.json", "minimax.json", "codebuddy-codex.json"]);
const ARRAY_SOURCES = new Set(["sessions.json", "environment-profiles.json"]);
const MAP_SOURCES = new Set(["template-usage.json", "known-hosts.json", "codebuddy-codex-verifications.json"]);
const RECORD_TABLES = {
  "sessions.json": "app_sessions",
  "launch-templates.json": "app_launch_templates",
  "environment-profiles.json": "app_environment_profiles",
  "template-usage.json": "app_template_usage",
  "known-hosts.json": "app_known_hosts",
  "mobile-access.json": "app_mobile_access_records",
  "openrouter.json": "app_openrouter_records",
  "nararouter.json": "app_nararouter_records",
  "minimax.json": "app_minimax_records",
  "codebuddy-codex.json": "app_codebuddy_codex_records",
  "codebuddy-codex-verifications.json": "app_codebuddy_verifications"
};

function createBusinessDataStore({ userData, databaseFile = path.join(userData, "agent-token-stats.sqlite3"), fsApi = fs, Database = DatabaseSync }) {
  let db;
  // Module owners use migration 2; keep the original migration source list unchanged.
  const names = new Set([...SOURCES, "module-owners.json"]);

  function ensureOpen() {
    if (!db) throw new Error("Business database is not open.");
  }
  function transaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function sourceName(filePath) {
    const name = path.basename(filePath);
    if (!names.has(name)) throw new Error(`Unsupported business data file: ${name}`);
    return name;
  }
  function putSetting(source, key, value) {
    db.prepare("INSERT INTO app_settings(source, key, value_json) VALUES (?, ?, ?) ON CONFLICT(source, key) DO UPDATE SET value_json=excluded.value_json")
      .run(source, key, JSON.stringify(value));
  }
  function putRecords(source, group, entries) {
    const insert = db.prepare(`INSERT INTO ${RECORD_TABLES[source]}(record_group, record_id, position, value_json) VALUES (?, ?, ?, ?)`);
    entries.forEach(([id, value], position) => insert.run(group, String(id), position, JSON.stringify(value)));
  }
  function entriesOf(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    return Object.entries(value);
  }
  function listRecords(source, group) {
    return db.prepare(`SELECT record_id, value_json FROM ${RECORD_TABLES[source]} WHERE record_group=? ORDER BY position`)
      .all(group).map(row => [row.record_id, JSON.parse(row.value_json)]);
  }
  function hasRecords(source, group) {
    return Boolean(db.prepare(`SELECT 1 FROM ${RECORD_TABLES[source]} WHERE record_group=? LIMIT 1`).get(group));
  }
  function settings(source) {
    return Object.fromEntries(db.prepare("SELECT key, value_json FROM app_settings WHERE source=?").all(source)
      .map(row => [row.key, JSON.parse(row.value_json)]));
  }
  function writeDocument(name, value) {
    if (name === "module-owners.json") {
      if (value?.schemaVersion !== 1) throw new Error("Invalid module owner schemaVersion.");
      const templates = entriesOf(value.templates, "module owners templates");
      db.exec("DELETE FROM app_module_owner_templates; DELETE FROM app_module_owner_records; DELETE FROM app_module_owner_history;");
      const templateInsert = db.prepare("INSERT INTO app_module_owner_templates(template_id, value_json) VALUES (?, ?)");
      const recordInsert = db.prepare("INSERT INTO app_module_owner_records(template_id, position, value_json) VALUES (?, ?, ?)");
      const historyInsert = db.prepare("INSERT INTO app_module_owner_history(template_id, position, value_json) VALUES (?, ?, ?)");
      for (const [id, template] of templates) {
        if (!template || !Number.isInteger(template.revision) || template.revision < 0 || !Array.isArray(template.records) || !Array.isArray(template.history) || !template.settings || typeof template.settings !== "object") throw new Error("Invalid module owner template.");
        const { records, history, ...metadata } = template;
        templateInsert.run(id, JSON.stringify(metadata));
        records.forEach((record, position) => recordInsert.run(id, position, JSON.stringify(record)));
        history.forEach((snapshot, position) => historyInsert.run(id, position, JSON.stringify(snapshot)));
      }
      db.prepare("INSERT INTO app_sources(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
      return;
    }
    if (RECORD_TABLES[name]) db.exec(`DELETE FROM ${RECORD_TABLES[name]}`);
    db.prepare("DELETE FROM app_settings WHERE source=?").run(name);
    if (ARRAY_SOURCES.has(name)) {
      if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
      putRecords(name, "items", value.map((item, index) => [index, item]));
    } else if (MAP_SOURCES.has(name)) {
      putRecords(name, "items", entriesOf(value, name));
    } else if (name === "launch-templates.json") {
      const items = Array.isArray(value) ? value : value?.launchTemplates;
      if (!Array.isArray(items)) throw new Error(`${name} must contain launchTemplates.`);
      putSetting(name, "schemaVersion", Array.isArray(value) ? 1 : value.schemaVersion ?? 1);
      putRecords(name, "items", items.map((item, index) => [index, item]));
    } else if (name === "mobile-access.json") {
      const entries = entriesOf(value, name);
      for (const [key, field] of entries) {
        if (key === "devices" || key === "audit") {
          if (!Array.isArray(field)) throw new Error(`${name}.${key} must be an array.`);
          putRecords(name, key, field.map((item, index) => [index, item]));
        } else putSetting(name, key, field);
      }
    } else if (MODEL_SOURCES.has(name)) {
      for (const [key, field] of entriesOf(value, name)) {
        if (key === "cachedModels") {
          if (!Array.isArray(field)) throw new Error(`${name}.${key} must be an array.`);
          if (field.length === 0) putSetting(name, key, []);
          putRecords(name, key, field.map((item, index) => [index, item]));
        } else if (key === "modelVerifications") {
          const verifications = entriesOf(field, `${name}.${key}`);
          if (verifications.length === 0) putSetting(name, key, {});
          putRecords(name, key, verifications);
        } else putSetting(name, key, field);
      }
    } else {
      for (const [key, field] of entriesOf(value, name)) putSetting(name, key, field);
    }
    db.prepare("INSERT INTO app_sources(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
  }
  function readDocument(name) {
    ensureOpen();
    if (!db.prepare("SELECT 1 FROM app_sources WHERE name=?").get(name)) {
      const error = new Error(`No stored data for ${name}`);
      error.code = "ENOENT";
      throw error;
    }
    if (name === "module-owners.json") {
      const templates = Object.fromEntries(db.prepare("SELECT template_id, value_json FROM app_module_owner_templates").all().map(row => {
        const readRows = table => db.prepare(`SELECT value_json FROM ${table} WHERE template_id=? ORDER BY position`).all(row.template_id).map(item => JSON.parse(item.value_json));
        return [row.template_id, { ...JSON.parse(row.value_json), records: readRows("app_module_owner_records"), history: readRows("app_module_owner_history") }];
      }));
      return { schemaVersion: 1, templates };
    }
    if (ARRAY_SOURCES.has(name)) return listRecords(name, "items").map(([, value]) => value);
    if (MAP_SOURCES.has(name)) return Object.fromEntries(listRecords(name, "items"));
    const fields = settings(name);
    if (name === "launch-templates.json") return { ...fields, launchTemplates: listRecords(name, "items").map(([, value]) => value) };
    if (name === "mobile-access.json") return { ...fields, devices: listRecords(name, "devices").map(([, value]) => value), audit: listRecords(name, "audit").map(([, value]) => value) };
    if (MODEL_SOURCES.has(name)) {
      for (const group of ["cachedModels"]) {
        if (hasRecords(name, group)) fields[group] = listRecords(name, group).map(([, value]) => value);
      }
      if (hasRecords(name, "modelVerifications")) fields.modelVerifications = Object.fromEntries(listRecords(name, "modelVerifications"));
    }
    return fields;
  }
  function open() {
    db = new Database(databaseFile);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS app_sources(name TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS app_settings(source TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(source,key));
        CREATE TABLE IF NOT EXISTS app_migrations(version INTEGER PRIMARY KEY, completed_at INTEGER NOT NULL);`);
      for (const table of Object.values(RECORD_TABLES)) {
        db.exec(`CREATE TABLE IF NOT EXISTS ${table}(record_group TEXT NOT NULL, record_id TEXT NOT NULL, position INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(record_group,record_id));
          CREATE INDEX IF NOT EXISTS ${table}_order ON ${table}(record_group,position);`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS app_module_owner_templates(template_id TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS app_module_owner_records(template_id TEXT NOT NULL, position INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(template_id,position));
        CREATE TABLE IF NOT EXISTS app_module_owner_history(template_id TEXT NOT NULL, position INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(template_id,position));`);
      if (!db.prepare("SELECT 1 FROM app_migrations WHERE version=1").get()) {
        const imported = [];
        for (const name of SOURCES) {
          const file = path.join(userData, name);
          try {
            imported.push([name, JSON.parse(fsApi.readFileSync(file, "utf8"))]);
          } catch (error) {
            if (error.code !== "ENOENT") throw new Error(`Cannot migrate ${name}: ${error.message}`, { cause: error });
          }
        }
        transaction(() => {
          for (const [name, value] of imported) writeDocument(name, value);
          db.prepare("INSERT INTO app_migrations(version, completed_at) VALUES (1, ?)").run(Date.now());
        });
      }
      if (!db.prepare("SELECT 1 FROM app_migrations WHERE version=2").get()) {
        transaction(() => {
          const name = "module-owners.json";
          if (!db.prepare("SELECT 1 FROM app_sources WHERE name=?").get(name)) {
            let value = { schemaVersion: 1, templates: {} };
            try { value = JSON.parse(fsApi.readFileSync(path.join(userData, name), "utf8")); }
            catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot migrate ${name}: ${error.message}`, { cause: error }); }
            try { writeDocument(name, value); }
            catch (error) { throw new Error(`Cannot migrate ${name}: ${error.message}`, { cause: error }); }
          }
          db.prepare("INSERT INTO app_migrations(version, completed_at) VALUES (2, ?)").run(Date.now());
        });
      }
      transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS app_module_owner_task_runs(
          id TEXT PRIMARY KEY, template_id TEXT NOT NULL, task_id TEXT NOT NULL,
          called_at INTEGER NOT NULL, status TEXT NOT NULL, value_json TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS app_module_owner_task_runs_order
          ON app_module_owner_task_runs(template_id, task_id, called_at DESC, id DESC);`);
        db.prepare("INSERT INTO app_migrations(version, completed_at) VALUES (3, ?) ON CONFLICT(version) DO NOTHING").run(Date.now());
      });
      const integrity = db.prepare("PRAGMA quick_check").get();
      if (Object.values(integrity)[0] !== "ok") throw new Error("Business database failed integrity check.");
      for (const row of db.prepare("SELECT name FROM app_sources").all()) readDocument(row.name);
    } catch (error) {
      db.close(); db = null;
      throw error;
    }
    return this;
  }
  function read(filePath) { return readDocument(sourceName(filePath)); }
  function write(filePath, value) {
    ensureOpen();
    transaction(() => writeDocument(sourceName(filePath), value));
  }
  function close() { if (db) { db.close(); db = null; } }
  function saveTaskRun(value) {
    ensureOpen();
    db.prepare(`INSERT INTO app_module_owner_task_runs(id, template_id, task_id, called_at, status, value_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, value_json=excluded.value_json`)
      .run(value.id, value.templateId, value.taskId, value.calledAt, value.status, JSON.stringify(value));
  }
  function listTaskRuns(templateId, taskId, page = 0) {
    ensureOpen();
    const total = db.prepare("SELECT COUNT(*) AS count FROM app_module_owner_task_runs WHERE template_id=? AND task_id=?").get(templateId, taskId).count;
    const records = db.prepare("SELECT value_json FROM app_module_owner_task_runs WHERE template_id=? AND task_id=? ORDER BY called_at DESC, id DESC LIMIT 20 OFFSET ?")
      .all(templateId, taskId, page * 20).map(row => { const { input, output, ...summary } = JSON.parse(row.value_json); return summary; });
    return { records, total };
  }
  function getTaskRun(templateId, taskId, id) {
    ensureOpen();
    const row = db.prepare("SELECT value_json FROM app_module_owner_task_runs WHERE template_id=? AND task_id=? AND id=?").get(templateId, taskId, id);
    if (!row) throw new Error("调用记录不存在或不属于此任务。");
    return JSON.parse(row.value_json);
  }
  function interruptTaskRuns() {
    ensureOpen();
    transaction(() => {
      for (const row of db.prepare("SELECT value_json FROM app_module_owner_task_runs WHERE status IN ('creating', 'running', 'uncertain')").all()) {
        saveTaskRun({ ...JSON.parse(row.value_json), status: "stopped", endedAt: Date.now(), error: "应用重启，上一轮记录已标记为中断。" });
      }
    });
  }
  return { open, read, write, close, saveTaskRun, listTaskRuns, getTaskRun, interruptTaskRuns };
}

module.exports = { createBusinessDataStore, SOURCES };
