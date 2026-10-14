import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");
const { SAVED_MESSAGE_VERSION } = require("../conversation-history/saved-message.cjs");

async function fixture() {
  const pools = [];
  class FakePool {
    constructor() {
      this.clients = [];
      this.end = vi.fn();
      this.query = vi.fn(async sql => {
        if (sql.includes("pg_get_constraintdef")) return { rows: [{ definition: "PRIMARY KEY (device_id, source_key, conversation_ref, message_hash)" }] };
        if (sql.includes("SELECT version")) return { rows: [{ version: SAVED_MESSAGE_VERSION }] };
        return { rows: [] };
      });
      pools.push(this);
    }
    async connect() {
      const client = { query: (...args) => this.query(...args), release: vi.fn() };
      this.clients.push(client);
      return client;
    }
  }
  const service = createPostgresBackupService({ userData: "unused", PoolClass: FakePool,
    dataStore: { read: () => ({}), write() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString("utf8") },
    sessionStore: { exportLibrary: () => [] }, terminalManager: { listSessions: () => [] },
    fsApi: { existsSync: () => false } });
  service.load();
  const config = { enabled: false, host: "db", database: "backup", user: "user", password: "password", passphrase: "passphrase" };
  await service.saveConfig(config);
  const pool = await service.getPool();
  return { service, pool, pools, config };
}

describe("schema initialization cache", () => {
  it("only queries devices on the second read and reuses initialization across lists", async () => {
    const { service, pool } = await fixture();
    try {
      await service.listDevices();
      expect(pool.query).toHaveBeenCalledTimes(9);
      pool.query.mockClear();
      await service.listDevices();
      expect(pool.query.mock.calls.map(([sql]) => sql)).toEqual(["SELECT id,name,last_seen_at FROM ph_devices ORDER BY name"]);
      await service.listSnapshots("device");
      await service.listConversations("device");
      expect(pool.query).toHaveBeenCalledTimes(3);
    } finally { await service.shutdown(); }
  });

  it("shares pending initialization across concurrent first reads", async () => {
    const { service, pool } = await fixture();
    let unblock;
    let started;
    const firstQuery = new Promise(resolve => { started = resolve; });
    pool.query.mockImplementationOnce(async () => {
      started();
      await new Promise(resolve => { unblock = resolve; });
      return { rows: [] };
    });
    try {
      const reads = Promise.all([service.listDevices(), service.listSnapshots("device"), service.listConversations("device")]);
      await firstQuery;
      expect(pool.query).toHaveBeenCalledTimes(1);
      unblock();
      await reads;
      expect(pool.query).toHaveBeenCalledTimes(11);
      expect(pool.query.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1);
      expect(pool.clients.every(client => client.release.mock.calls.length === 1)).toBe(true);
    } finally { unblock?.(); await service.shutdown(); }
  });

  it("retries after a migration failure and releases failed callers", async () => {
    const { service, pool } = await fixture();
    const query = pool.query.getMockImplementation();
    let fail = true;
    pool.query.mockImplementation(async sql => {
      if (sql.includes("SELECT version") && fail) { fail = false; throw new Error("migration failed"); }
      return query(sql);
    });
    try {
      const results = await Promise.allSettled([service.listDevices(), service.listDevices()]);
      expect(results.every(result => result.status === "rejected" && result.reason.message === "migration failed")).toBe(true);
      expect(pool.query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
      expect(pool.clients.every(client => client.release.mock.calls.length === 1)).toBe(true);
      pool.query.mockClear();
      await service.listDevices();
      expect(pool.query).toHaveBeenCalledTimes(9);
      await service.listDevices();
      expect(pool.query).toHaveBeenCalledTimes(10);
    } finally { await service.shutdown(); }
  });

  it("initializes replacement pools and shares their cache with backup", async () => {
    const { service, pool, pools, config } = await fixture();
    try {
      await service.listDevices();
      await service.saveConfig({ ...config, database: "other-backup", enabled: true });
      expect(pool.end).toHaveBeenCalledTimes(1);
      await service.listDevices();
      const replacement = pools.at(-1);
      expect(replacement).not.toBe(pool);
      expect(replacement.query).toHaveBeenCalledTimes(9);
      replacement.query.mockClear();
      await service.backupNow();
      expect(replacement.query.mock.calls.some(([sql]) => sql.includes("CREATE TABLE"))).toBe(false);
      replacement.query.mockClear();
      await service.listDevices();
      expect(replacement.query).toHaveBeenCalledTimes(1);
      await service.shutdown();
      await service.listDevices();
      expect(pools.at(-1).query).toHaveBeenCalledTimes(9);
    } finally { await service.shutdown(); }
  });
});
