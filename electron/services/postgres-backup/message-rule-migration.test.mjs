import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");
const { savedMessage, SAVED_MESSAGE_VERSION } = require("../conversation-history/saved-message.cjs");

describe("message rule batch migration", () => {
  it.each([
    [0, "mixed", null], [1, "keep", 1], [500, "delete", null],
    [1000, "mixed", 1], [1000, "keep", null], [1000, "delete", 1],
    [1001, "mixed", null], [1000, "mixed", 1, 2], [1000, "mixed", null, 4],
    [1000, "mixed", 1, "version"]
  ])("migrates %i %s rows from version %s with failure %s", async (count, mode, initialVersion, failure) => {
    const root = mkdtempSync(path.join(tmpdir(), "pg-rule-migration-"));
    let deviceId;
    let version = initialVersion;
    let messages = [];
    let snapshot;
    let writes = 0;
    let failOnce = failure;
    const queries = [];
    const key = row => JSON.stringify([row.source_key, row.conversation_ref, row.message_hash]);
    const tuple = row => [row.source_key, row.conversation_ref, row.message_hash];
    const compare = (a, b) => {
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      return 0;
    };
    const client = { release() {}, async query(sql, params = []) {
      queries.push(sql);
      if (sql === "BEGIN") snapshot = structuredClone({ messages, version });
      if (sql === "ROLLBACK") ({ messages, version } = snapshot);
      if (sql.includes("pg_get_constraintdef")) return { rows: [{ definition: "PRIMARY KEY (device_id, source_key, conversation_ref, message_hash)" }] };
      if (sql.includes("SELECT version")) return { rows: version === null ? [] : [{ version }] };
      if (sql.includes("SELECT source_key, conversation_ref, message_hash, data FROM ph_messages")) {
        const cursor = params.slice(1);
        return { rows: structuredClone(messages.filter(row => row.device_id === params[0] &&
          (!cursor.length || compare(tuple(row), cursor) > 0)).slice(0, 500)) };
      }
      if (sql.includes("SET data=batch.data") || sql.includes("DELETE FROM ph_messages AS messages")) {
        writes++;
        if (failOnce === writes) { failOnce = null; throw new Error("injected failure"); }
        expect(sql).toContain("messages.device_id=$1");
        for (const field of ["source_key", "conversation_ref", "message_hash"]) expect(sql).toContain(`messages.${field}=batch.${field}`);
        expect(sql).toContain("jsonb_to_recordset($2::jsonb)");
        const batch = JSON.parse(params[1]);
        expect(batch.length).toBeLessThanOrEqual(500);
        const byKey = new Map(batch.map(row => [key(row), row]));
        if (sql.startsWith("UPDATE")) {
          for (const row of messages) if (row.device_id === params[0] && byKey.has(key(row))) row.data = byKey.get(key(row)).data;
        } else messages = messages.filter(row => row.device_id !== params[0] || !byKey.has(key(row)));
      }
      if (sql.includes("INSERT INTO ph_conversation_rules")) {
        if (failOnce === "version") { failOnce = null; throw new Error("injected failure"); }
        version = params[1];
      }
      return { rows: [] };
    } };
    class FakePool { async connect() { return client; } async end() {} }
    const service = createPostgresBackupService({ userData: root, PoolClass: FakePool,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString("utf8") } });
    try {
      service.load();
      deviceId = (await service.saveConfig({ enabled: false, host: "localhost", database: "test", user: "test", password: "test" })).deviceId;
      const source = "中文 ' $1 \\";
      const originals = Array.from({ length: count }, (_, i) => ({ device_id: deviceId, source_key: `${source}${i % 2}`,
        conversation_ref: `conversation-${Math.floor(i / 2) % 2}`, message_hash: String(Math.floor(i / 4)).padStart(6, "0"),
        data: { id: `message-${i}`, kind: mode === "delete" || mode === "mixed" && Math.floor(i / 4) % 2 ? "tool" : "reply",
          text: "内容 ' \\ $2", threadId: "thread", item: { type: mode === "delete" || mode === "mixed" && Math.floor(i / 4) % 2 ? "commandExecution" : "agentMessage", output: "secret" } } }))
        .sort((a, b) => compare(tuple(a), tuple(b)));
      const guards = count ? [
        { ...originals[0], device_id: "other-device" }
      ] : [];
      messages = structuredClone([...originals, ...guards]);
      const before = structuredClone(messages);
      if (failure) {
        await expect(service.listDevices()).rejects.toThrow("injected failure");
        expect(messages).toEqual(before);
        expect(version).toBe(initialVersion);
        expect(queries).toContain("ROLLBACK");
      }
      const writesBefore = writes;
      await service.listDevices();
      const expected = [...originals, ...guards].flatMap(row => {
        const data = row.device_id === deviceId ? savedMessage(row.data) : row.data;
        return data ? [{ ...row, data }] : [];
      });
      expect(messages).toEqual(expected);
      expect(version).toBe(SAVED_MESSAGE_VERSION);
      expect(writes - writesBefore).toBeLessThanOrEqual(Math.ceil(count / 500) * 2);
      if (count === 1000) expect(writes - writesBefore).toBe(mode === "mixed" ? 4 : 2);
      const completedWrites = writes;
      await service.listDevices();
      expect(writes).toBe(completedWrites);
      expect(queries).toContain("COMMIT");
    } finally {
      await service.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
