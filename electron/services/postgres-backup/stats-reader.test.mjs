import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { readStatsBatches } = require("./stats-reader.cjs");
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");
const tables = ["token_sessions", "token_session_models", "token_session_skills", "token_session_mcp_tools", "token_daily"];

it("exports Beijing totals and the calendar marker together, including after clear", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pg-beijing-snapshot-"));
  const statsFile = path.join(root, "stats.sqlite3");
  const { createAgentTokenStatsStore } = require("../token-usage/agent-token-stats-store.cjs");
  const store = createAgentTokenStatsStore({ databaseFile: statsFile });
  store.load();
  const snapshot = async () => {
    const rows = [];
    for await (const batch of readStatsBatches({ statsFile, epoch: 3,
      tables: ["token_daily", "token_daily_beijing", "token_calendar"], batchSize: 1 })) rows.push(...batch);
    return rows;
  };
  try {
    store.update({ provider: "codex", agentSessionId: "one", panelSessionId: "one",
      tokens: { totalTokens: 42 }, timestamp: Date.parse("2026-10-14T16:00:00Z") });
    const rows = await snapshot();
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.table_name === "token_daily").data.date).toBe("2026-10-14");
    expect(rows.find(row => row.table_name === "token_daily_beijing")).toMatchObject({
      row_key: '3:["2026-10-15","codex"]', data: { date: "2026-10-15", total_tokens: 42, approximate: 0, backup_epoch: 3 }
    });
    expect(rows.find(row => row.table_name === "token_calendar")).toMatchObject({ row_key: "3:beijing", data: { id: "beijing", backup_epoch: 3 } });
    store.clear();
    const cleared = await snapshot();
    expect(cleared).toHaveLength(1);
    expect(cleared[0].table_name).toBe("token_calendar");
  } finally {
    store.close();
    if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) rmSync(root, { recursive: true, force: true });
  }
});

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
    db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL;");
    const update = db.prepare("UPDATE token_sessions SET total_tokens=?");
    for (let i = 0; i < 2000; i++) update.run(i);
    db.exec("UPDATE token_sessions SET total_tokens=99; DELETE FROM token_daily;");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    expect(checkpoint.busy).toBe(0);
    expect(require("node:fs").statSync(`${statsFile}-wal`).size).toBe(0);
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
}, 30000);

it("backs up 100000 real SQLite rows in bounded batches while the main event loop responds", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pg-stats-worker-"));
  const statsFile = path.join(root, "stats.sqlite3");
  const db = new DatabaseSync(statsFile);
  db.exec("PRAGMA journal_mode=WAL; BEGIN; CREATE TABLE token_sessions (id TEXT PRIMARY KEY, total_tokens INTEGER)");
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
    if (sql.includes("SELECT data->>'hash' AS hash FROM ph_session_snapshots")) return { rows: snapshot ? [{ hash: snapshot.hash }] : [] };
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
        expect(deletes).toBe(7);
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


it.each(["success", "cancel", "upload failure", "snapshot failure"])("removes the temporary snapshot after %s", async outcome => {
  const fs = require("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "pg-stats-cleanup-"));
  const statsFile = path.join(root, "stats.sqlite3");
  const db = new DatabaseSync(statsFile);
  db.exec("CREATE TABLE token_sessions (id TEXT); INSERT INTO token_sessions VALUES ('one'), ('two')");
  db.close();
  const directories = [];
  const original = fs.mkdtempSync;
  const spy = vi.spyOn(fs, "mkdtempSync").mockImplementation(prefix => {
    const directory = original(prefix);
    directories.push(directory);
    return directory;
  });
  try {
    const consume = async () => {
      for await (const batch of readStatsBatches({ statsFile, epoch: 0, batchSize: 1,
        tables: outcome === "snapshot failure" ? ["token_sessions", "missing_table"] : ["token_sessions"] })) {
        expect(batch).toHaveLength(1);
        expect(fs.existsSync(path.join(directories[0], "batches.bin"))).toBe(true);
        if (outcome === "cancel") break;
        if (outcome === "upload failure") throw new Error("Remote write failed");
      }
    };
    if (outcome === "snapshot failure") await expect(consume()).rejects.toThrow(/missing_table/);
    else if (outcome === "upload failure") await expect(consume()).rejects.toThrow(/Remote write failed/);
    else await consume();
    expect(directories).toHaveLength(1);
    expect(fs.existsSync(directories[0])).toBe(false);
  } finally {
    spy.mockRestore();
    if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) rmSync(root, { recursive: true, force: true });
  }
});


it("allows WAL reclamation while the PostgreSQL batch write is pending", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pg-stats-upload-"));
  const statsFile = path.join(root, "stats.sqlite3");
  const db = new DatabaseSync(statsFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=NORMAL;
    CREATE TABLE token_sessions (id TEXT, total_tokens INTEGER);
    CREATE TABLE token_session_models (session_id TEXT, model TEXT);
    CREATE TABLE token_session_skills (session_id TEXT, name TEXT);
    CREATE TABLE token_session_mcp_tools (session_id TEXT, server_name TEXT, tool_name TEXT);
    CREATE TABLE token_daily (date TEXT, provider TEXT, total_tokens INTEGER);
    INSERT INTO token_sessions VALUES ('one', 1);
    INSERT INTO token_daily VALUES ('2026-10-13', 'codex', 3);`);
  const uploaded = [];
  const client = { release() {}, async query(sql, params = []) {
    if (sql.includes("INSERT INTO ph_stat_rows")) {
      if (!uploaded.length) {
        await new Promise(resolve => setTimeout(resolve, 25));
        const update = db.prepare("UPDATE token_sessions SET total_tokens=?");
        for (let i = 0; i < 2000; i++) update.run(i);
        db.exec("DELETE FROM token_daily");
        expect(require("node:fs").statSync(`${statsFile}-wal`).size).toBeGreaterThan(0);
        expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy).toBe(0);
        expect(require("node:fs").statSync(`${statsFile}-wal`).size).toBe(0);
      }
      uploaded.push(...JSON.parse(params[1]));
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
    await service.shutdown();
    await service.backupNow();
    expect(uploaded.map(row => [row.table_name, row.data.total_tokens])).toEqual([
      ["token_sessions", 1], ["token_daily", 3]
    ]);
  } finally {
    await service.shutdown();
    db.close();
    if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) rmSync(root, { recursive: true, force: true });
  }
}, 30000);
