import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");
const { SAVED_MESSAGE_VERSION } = require("../conversation-history/saved-message.cjs");
const { Pool } = require("pg");
const hash = id => createHash("sha256").update(id).digest("hex");

async function fixture(PoolClass, work) {
  const root = mkdtempSync(path.join(tmpdir(), "pg-key-migration-"));
  const service = createPostgresBackupService({ userData: root, PoolClass,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString("utf8") } });
  try {
    service.load();
    await service.saveConfig({ enabled: false, host: "localhost", database: "test", user: "test", password: "test" });
    await work(service);
  } finally {
    await service.shutdown();
    if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) rmSync(root, { recursive: true, force: true });
  }
}

describe("legacy message primary key batch migration", () => {
  it.each([0, 1, 500, 1000, 1001])("migrates %i messages through listDevices in bounded batches", async count => {
    const messages = Array.from({ length: count }, (_, i) => ({ row_tid: `(0,${i + 1})`,
      message_id: `${i}:中文 ' $1 \\ ${"long".repeat(i === 0 ? 1000 : 1)}`, message_hash: null }));
    const queries = [];
    let migrated = false;
    const client = { release() {}, async query(sql, params) {
      queries.push(sql);
      if (sql.includes("pg_get_constraintdef")) return { rows: [{ definition: migrated ? "PRIMARY KEY (message_hash)" : "PRIMARY KEY (message_id)" }] };
      if (sql.includes("SELECT ctid::text")) return { rows: messages.filter(row => row.message_hash === null).slice(0, 500) };
      if (sql.includes("SET message_hash=batch.message_hash")) {
        expect(sql).toContain("messages.ctid=batch.row_tid::tid");
        const batch = JSON.parse(params[0]);
        expect(batch.length).toBeLessThanOrEqual(500);
        for (const row of batch) messages.find(item => item.row_tid === row.row_tid).message_hash = row.message_hash;
      }
      if (sql.includes("ADD CONSTRAINT ph_messages_pkey")) migrated = true;
      if (sql.includes("SELECT version")) return { rows: [{ version: SAVED_MESSAGE_VERSION }] };
      return { rows: [] };
    } };
    class FakePool { async connect() { return client; } async end() {} }
    await fixture(FakePool, async service => {
      await service.listDevices();
      expect(messages.every(row => row.message_hash === hash(row.message_id))).toBe(true);
      expect(queries.filter(sql => sql.includes("SET message_hash=batch.message_hash"))).toHaveLength(Math.ceil(count / 500));
      expect(migrated).toBe(true);
      expect(queries).toContain("COMMIT");
      await service.listDevices();
      expect(queries.filter(sql => sql.includes("SET message_hash=batch.message_hash"))).toHaveLength(Math.ceil(count / 500));
    });
  });
});

// Opt in with a disposable PostgreSQL connection; each case uses its own schema.
const connectionString = process.env.PH_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)("real PostgreSQL legacy key migration", () => {
  it.each([null, "batch", "constraint"])("migrates or rolls back after %s failure", async failure => {
    const admin = new Pool({ connectionString });
    const schema = `migration_${randomUUID().replaceAll("-", "")}`;
    let updates = 0;
    let released = 0;
    const queries = [];
    class TestPool {
      constructor() { this.pool = new Pool({ connectionString, options: `-c search_path=${schema}` }); }
      async connect() {
        const client = await this.pool.connect();
        return { release() { released++; client.release(); }, async query(sql, params) {
          queries.push(sql);
          if (sql.includes("SET message_hash=batch.message_hash")) {
            updates++;
            if (failure === "batch" && updates === 2) throw new Error("injected batch failure");
          }
          if (failure === "constraint" && sql.includes("ADD CONSTRAINT ph_messages_pkey")) throw new Error("injected constraint failure");
          return client.query(sql, params);
        } };
      }
      async end() { await this.pool.end(); }
    }
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`CREATE TABLE ${schema}.ph_messages (
        device_id UUID NOT NULL, source_key TEXT NOT NULL, conversation_ref TEXT NOT NULL,
        message_id TEXT NOT NULL, message_hash TEXT, data JSONB NOT NULL,
        PRIMARY KEY(device_id, source_key, conversation_ref, message_id))`);
      const device = randomUUID();
      await admin.query(`INSERT INTO ${schema}.ph_messages
        SELECT $1::uuid, 'source', 'conversation', 'message-' || n,
          CASE WHEN n=1001 THEN 'existing-hash' ELSE NULL END, '{}'::jsonb FROM generate_series(1,1001) n`, [device]);
      await fixture(TestPool, async service => {
        if (failure) await expect(service.listDevices()).rejects.toThrow(`injected ${failure} failure`);
        else await service.listDevices();
        expect(released).toBe(1);
        expect(updates).toBe(2);
        const rows = (await admin.query(`SELECT message_id,message_hash FROM ${schema}.ph_messages`)).rows;
        expect(rows).toHaveLength(1001);
        expect(rows.find(row => row.message_id === "message-1001").message_hash).toBe("existing-hash");
        expect(rows.filter(row => row.message_id !== "message-1001").every(row => row.message_hash === (failure ? null : hash(row.message_id)))).toBe(true);
        const key = (await admin.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname='ph_messages_pkey'", [`${schema}.ph_messages`])).rows[0].definition;
        expect(key).toContain(failure ? "message_id" : "message_hash");
        const nullable = (await admin.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='ph_messages' AND column_name='message_hash'", [schema])).rows[0].is_nullable;
        expect(nullable).toBe(failure ? "YES" : "NO");
        expect(queries).toContain(failure ? "ROLLBACK" : "COMMIT");
        if (!failure) { await service.listDevices(); expect(updates).toBe(2); }
      });
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
