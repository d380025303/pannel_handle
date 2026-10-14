import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { readStatsBatches } = require("./stats-reader.cjs");
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");
const tables = ["token_sessions", "token_session_models", "token_session_skills", "token_session_mcp_tools", "token_daily"];

it("keeps one read-only snapshot across batches and tables while local writes continue", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pg-stats-snapshot-"));
  const statsFile = path.join(root, "stats.sqlite3");
  const db = new DatabaseSync(statsFile);
  const reader = readStatsBatches({ statsFile, epoch: 7,
    tables: ["token_sessions", "token_daily"], batchSize: 1 });
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE token_sessions (id TEXT, total_tokens INTEGER);
      CREATE TABLE token_daily (date TEXT, provider TEXT, total_tokens INTEGER);
      INSERT INTO token_sessions VALUES ('first', 1), ('second', 2);
      INSERT INTO token_daily VALUES ('2026-10-13', 'codex', 3);`);
    expect((await reader.next()).value).toEqual([
      { table_name: "token_sessions", row_key: "7:first", data: { id: "first", total_tokens: 1, backup_epoch: 7 } }
    ]);
    db.exec("UPDATE token_sessions SET total_tokens=99; DELETE FROM token_daily;");
    expect((await reader.next()).value[0].data.total_tokens).toBe(2);
    expect((await reader.next()).value).toEqual([
      { table_name: "token_daily", row_key: '7:["2026-10-13","codex"]',
        data: { date: "2026-10-13", provider: "codex", total_tokens: 3, backup_epoch: 7 } }
    ]);
    expect((await reader.next()).done).toBe(true);
    expect(db.prepare("SELECT total_tokens FROM token_sessions").get().total_tokens).toBe(99);
  } finally {
    await reader.return();
    db.close();
    if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) rmSync(root, { recursive: true, force: true });
  }
});

it("backs up 100000 real SQLite rows in bounded batches while the main event loop responds", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pg-stats-worker-"));
  const statsFile = path.join(root, "stats.sqlite3");
  const db = new DatabaseSync(statsFile);
  db.exec("BEGIN; CREATE TABLE token_sessions (id TEXT PRIMARY KEY, total_tokens INTEGER)");
  db.exec(`CREATE TABLE token_session_models (session_id TEXT, model TEXT);
    CREATE TABLE token_session_skills (session_id TEXT, name TEXT);
    CREATE TABLE token_session_mcp_tools (session_id TEXT, server_name TEXT, tool_name TEXT);
    CREATE TABLE token_daily (date TEXT, provider TEXT);`);
  const insert = db.prepare("INSERT INTO token_sessions VALUES (?, ?)");
  for (let i = 0; i < 100000; i++) insert.run(`codex:${i}`, i);
  db.exec("COMMIT");
  db.close();
  const orderedIds = Array.from({ length: 100000 }, (_, i) => `codex:${i}`).sort();
  let count = 0;
  let upserts = 0;
  let jsonBytes = 0;
  let deletes = 0;
  let snapshot;
  const client = { release() {}, async query(sql, params = []) {
    if (sql.includes("SELECT data FROM ph_session_snapshots")) return { rows: snapshot ? [{ data: snapshot }] : [] };
    if (sql.includes("INSERT INTO ph_session_snapshots")) snapshot = params[2];
    if (sql.includes("INSERT INTO ph_stat_rows")) {
      upserts++;
      jsonBytes += Buffer.byteLength(params[1]);
      const batch = JSON.parse(params[1]);
      expect(batch.length).toBeLessThanOrEqual(500);
      for (const row of batch) {
        if (row.table_name !== "token_sessions" || row.row_key !== `0:${orderedIds[count]}`
          || row.data.id !== orderedIds[count] || row.data.total_tokens !== Number(orderedIds[count].split(":")[1]) || row.data.backup_epoch !== 0) {
          throw new Error(`Unexpected statistics row ${count}`);
        }
        count++;
      }
    }
    if (sql.includes("DELETE FROM ph_stat_rows")) {
      expect(params[3].length).toBe(params[1] === "token_sessions" ? 100000 : 0);
      deletes++;
    }
    return { rows: [] };
  } };
  class Pool { async connect() { return client; } async end() {} }
  const service = createPostgresBackupService({ userData: root, statsFile, PoolClass: Pool,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    sessionStore: { exportLibrary: () => [] }, terminalManager: { listSessions: () => [] }, historyService: {} });
  try {
    service.load();
    await service.saveConfig({ enabled: true, host: "localhost", database: "backup", user: "user", password: "password", passphrase: "passphrase" });
    await service.shutdown(); // Cancel the automatic timer; exercise three explicit backups.
    for (let round = 0; round < 3; round++) {
      count = 0;
      upserts = 0;
      jsonBytes = 0;
      deletes = 0;
      const start = performance.now();
      let lastTick = start;
      let maxGap = 0;
      let ticks = 0;
      const pulse = setInterval(() => {
        const time = performance.now();
        maxGap = Math.max(maxGap, time - lastTick);
        lastTick = time;
        ticks++;
      }, 1);
      const zeroTimer = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
      try {
        await service.backupNow();
        maxGap = Math.max(maxGap, performance.now() - lastTick);
        const zeroDelay = await zeroTimer;
        console.log(`stats backup round ${round + 1}: ${Math.round(performance.now() - start)} ms, zero timer ${zeroDelay.toFixed(1)} ms, max timer gap ${maxGap.toFixed(1)} ms`);
        expect(count).toBe(round === 0 ? 100000 : 0);
        expect(upserts).toBe(round === 0 ? 200 : 0);
        if (round === 0) expect(jsonBytes).toBeGreaterThan(0);
        else expect(jsonBytes).toBe(0);
        expect(deletes).toBe(5);
        expect(ticks).toBeGreaterThan(10);
        expect(zeroDelay).toBeLessThan(200);
        expect(maxGap).toBeLessThan(200);
      } finally { clearInterval(pulse); }
    }
    await expect(async () => {
      for await (const batch of readStatsBatches({ statsFile, epoch: 0, tables: ["missing_table"], batchSize: 500 })) void batch;
    }).rejects.toThrow(/missing_table/);
    // Early consumer cancellation must release the worker and its SQLite connection.
    for await (const batch of readStatsBatches({ statsFile, epoch: 0, tables, batchSize: 500 })) {
      expect(batch).toHaveLength(500);
      break;
    }
  } finally {
    await service.shutdown();
    if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) rmSync(root, { recursive: true, force: true });
  }
}, 30000);
