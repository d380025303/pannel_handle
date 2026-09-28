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
  const names = new Set(SOURCES);

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
  return { open, read, write, close };
}

module.exports = { createBusinessDataStore, SOURCES };
