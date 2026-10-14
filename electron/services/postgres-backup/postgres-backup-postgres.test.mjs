import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");

// Run only against a disposable PostgreSQL database, never the configured backup server.
// PANNEL_BACKUP_TEST_PORT=<isolated localhost port> pnpm exec vitest run <this file>
describe.skipIf(!process.env.PANNEL_BACKUP_TEST_PORT)("incremental backup with real PostgreSQL", () => {
  it("uploads only changed messages and verifies actual inserts and updates", async () => {
    const admin = new Pool({ host: "127.0.0.1", port: Number(process.env.PANNEL_BACKUP_TEST_PORT),
      database: "postgres", user: "postgres", password: "isolated-test-password" });
    const schema = `backup_test_${process.pid}_${Date.now()}`;
    const uploads = [];
    const summaries = [];
    class TestPool extends Pool {
      constructor(options) { super({ ...options, options: `-c search_path=${schema}` }); }
      async connect() {
        const client = await super.connect();
        const originalQuery = client.query;
        client.query = async function(sql, params) {
          const result = await originalQuery.call(this, sql, params);
          if (sql.includes("INSERT INTO ph_messages(")) uploads.push({ sql, params, rowCount: result.rowCount });
          if (sql.includes("md5(data->>'text') AS text_hash")) summaries.push(result.rows);
          return result;
        };
        const originalRelease = client.release;
        client.release = function(...args) {
          client.query = originalQuery;
          client.release = originalRelease;
          return originalRelease.apply(this, args);
        };
        return client;
      }
    }
    const session = { id: "local", type: "windows", cwd: "C:\\backup-test" };
    const messages = Array.from({ length: 1000 }, (_, index) => ({
      id: `message-${index}`, provider: "codex", kind: "reply", text: "x".repeat(1024), timestamp: index
    }));
    let updatedAt = 1;
    const service = createPostgresBackupService({ userData: "unused", PoolClass: TestPool,
      dataStore: { read: () => ({}), write() {} }, fsApi: { existsSync: () => false },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
        decryptString: value => value.toString("utf8") },
      sessionStore: { exportLibrary: () => [] },
      terminalManager: { listSessions: () => [session], getSession: () => session },
      historyService: {
        listHistoryForSession: async () => ({ items: [{ ref: "conversation", updatedAt }], nextCursor: null }),
        getHistoryMessagesForSession: async (_session, { cursor, limit }) => {
          const offset = Number(cursor || 0);
          return { messages: messages.slice(offset, offset + limit),
            nextCursor: offset + limit < messages.length ? String(offset + limit) : null };
        }
      }
    });
    const backup = async () => expect((await service.backupNow()).lastError).toBe("");
    const audit = async () => (await admin.query(`SELECT operation, count(*)::int AS count
      FROM ${schema}.message_writes GROUP BY operation ORDER BY operation`)).rows;
    const reset = async () => {
      uploads.length = 0;
      summaries.length = 0;
      await admin.query(`TRUNCATE ${schema}.message_writes`);
    };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      service.load();
      await service.saveConfig({ enabled: true, host: "127.0.0.1", port: Number(process.env.PANNEL_BACKUP_TEST_PORT),
        database: "postgres", user: "postgres", password: "isolated-test-password", passphrase: "test", ssl: false });
      await service.shutdown(); // Cancel the scheduled automatic backup; drive each pass explicitly.
      await service.withClient(async client => {
        await client.query(`CREATE TABLE message_writes(operation TEXT);
          CREATE FUNCTION record_message_write() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN INSERT INTO message_writes VALUES (TG_OP); RETURN NEW; END $$;
          CREATE TRIGGER message_write AFTER INSERT OR UPDATE ON ph_messages
          FOR EACH ROW EXECUTE FUNCTION record_message_write()`);
      });
      await backup();
      expect(uploads.map(upload => JSON.parse(upload.params[3]).length)).toEqual([200, 200, 200, 200, 200]);
      expect(await audit()).toEqual([{ operation: "INSERT", count: 1000 }]);

      await reset();
      messages.push({ id: "new", provider: "codex", kind: "user", text: "x".repeat(1024), timestamp: 1000 });
      updatedAt++;
      await backup();
      expect(uploads).toHaveLength(1);
      expect(JSON.parse(uploads[0].params[3]).map(row => row.message_id)).toEqual(["new"]);
      expect(await audit()).toEqual([{ operation: "INSERT", count: 1 }]);
      expect(summaries.flat()).toHaveLength(1000);
      expect(summaries.flat().every(row => row.metadata.text === undefined && row.text_hash.length === 32)).toBe(true);
      console.info("append upload bytes:", Buffer.byteLength(uploads[0].params[3]));

      await reset();
      messages[500].text = "changed 正文 😀\n\"\\";
      updatedAt++;
      await backup();
      expect(uploads).toHaveLength(1);
      expect(JSON.parse(uploads[0].params[3]).map(row => row.message_id)).toEqual(["message-500"]);
      expect(await audit()).toEqual([{ operation: "UPDATE", count: 1 }]);
      expect((await admin.query(`SELECT data->>'text' AS text FROM ${schema}.ph_messages
        WHERE message_id='message-500'`)).rows[0].text).toBe(messages[500].text);

      // Even when metadata changes, unchanged messages cause no uploads or writes.
      await reset();
      updatedAt++;
      await backup();
      expect(uploads).toEqual([]);
      expect(await audit()).toEqual([]);

      // Exercise the defensive UPSERT directly, bypassing the summary filter.
      messages[0].timestamp++;
      updatedAt++;
      await backup();
      expect(await audit()).toEqual([{ operation: "UPDATE", count: 1 }]);
      const last = uploads[0];
      await reset();
      await service.withClient(async client => {
        const result = await client.query(last.sql, last.params);
        expect(result.rowCount).toBe(0);
      });
      expect(await audit()).toEqual([]);
    } finally {
      await service.shutdown();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }, 30000);
});
