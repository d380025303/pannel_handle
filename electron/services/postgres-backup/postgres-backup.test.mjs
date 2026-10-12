import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { encryptPortable, decryptPortable } = require("./backup-crypto.cjs");
const { getRemoteDashboard } = require("./remote-dashboard.cjs");
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");

describe("portable session backup", () => {
  it("restores a secret with the backup passphrase and rejects a different one", () => {
    const payload = encryptPortable(JSON.stringify([{ sshConfig: { secret: "sensitive" } }]), "shared-passphrase");
    expect(decryptPortable(payload, "shared-passphrase")).toContain("sensitive");
    expect(() => decryptPortable(payload, "different-passphrase")).toThrow(/incorrect/);
    expect(JSON.stringify(payload)).not.toContain("sensitive");
  });
});

describe("remote statistics", () => {
  it("keeps overlapping agent session IDs from two computers separate and aggregates totals", async () => {
    const rows = ["computer-a", "computer-b"].flatMap(device_id => [
      { device_id, table_name: "token_sessions", data: {
        id: "codex:shared", provider: "codex", agent_session_id: "shared", panel_session_id: "1",
        title: device_id, cwd: "C:\\work", location: "windows", started_at: 1, updated_at: 2,
        input_tokens: 10, output_tokens: 5, total_tokens: 15, skill_availability: "available", mcp_availability: "available"
      } },
      { device_id, table_name: "token_daily", data: { date: "2026-09-21", provider: "codex", total_tokens: 15 } }
    ]);
    const client = { query: async (_sql, params) => ({ rows: params?.length ? rows.filter(row => row.device_id === params[0]) : rows }) };
    const all = await getRemoteDashboard(client, { range: "all", deviceId: "all" });
    const one = await getRemoteDashboard(client, { range: "all", deviceId: "computer-a" });
    expect(all.summary.sessionCount).toBe(2);
    expect(all.summary.tokens.totalTokens).toBe(30);
    expect(all.sessions.map(item => item.id)).toEqual(expect.arrayContaining(["computer-a:0:codex:shared", "computer-b:0:codex:shared"]));
    expect(one.summary.sessionCount).toBe(1);
    expect(one.summary.tokens.totalTokens).toBe(15);
  });
});

describe("PostgreSQL backup service", () => {
  it("stores only encrypted session snapshots and restores SSH credentials as new templates", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pg-backup-test-"));
    const snapshots = [];
    const client = { release() {}, async query(sql, parameters) {
      if (sql.includes("SELECT data FROM ph_session_snapshots WHERE device_id")) {
        return { rows: snapshots.length ? [{ data: snapshots.at(-1).data }] : [] };
      }
      if (sql.includes("INSERT INTO ph_session_snapshots")) {
        snapshots.push({ id: parameters[0], data: parameters[2] });
      }
      if (sql.includes("SELECT data FROM ph_session_snapshots WHERE id")) {
        return { rows: snapshots.filter(item => item.id === parameters[0]).map(item => ({ data: item.data })) };
      }
      return { rows: [] };
    } };
    class FakePool { async connect() { return client; } async end() {} }
    const imported = [];
    const sessionStore = {
      exportLibrary: () => [{ id: "1", title: "SSH", type: "ssh", sshConfig: { host: "example.org", encryptedSecret: "local-only" } }],
      decryptSecret: () => "ssh-password",
      importLibrary: vi.fn(items => { imported.push(...items); return { importedCount: items.length, sessions: items }; })
    };
    const safeStorage = { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value), decryptString: value => value.toString("utf8") };
    const service = createPostgresBackupService({ userData: root, safeStorage, sessionStore,
      statsFile: path.join(root, "missing.sqlite3"), terminalManager: { listSessions: () => [] },
      historyService: {}, PoolClass: FakePool });
    try {
      service.load();
      await service.saveConfig({ enabled: true, host: "localhost", database: "backup", user: "user",
        password: "db-password", passphrase: "portable-passphrase" });
      expect((await service.backupNow()).running).toBe(false);
      expect(snapshots).toHaveLength(1);
      expect(JSON.stringify(snapshots[0])).not.toContain("ssh-password");
      expect(JSON.stringify(snapshots[0])).not.toContain("db-password");
      await service.backupNow();
      expect(snapshots).toHaveLength(1);
      const restored = await service.restoreSnapshot(snapshots[0].id, "portable-passphrase");
      expect(restored.importedCount).toBe(1);
      expect(imported[0].sshConfig.secret).toBe("ssh-password");
      expect(imported[0].sshConfig.encryptedSecret).toBeUndefined();
      const writeError = new Error("attempt to write a readonly database");
      sessionStore.importLibrary.mockImplementationOnce(() => { throw writeError; });
      await expect(service.restoreSnapshot(snapshots[0].id, "portable-passphrase")).rejects.toBe(writeError);
    } finally {
      await service.shutdown();
      if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("migrates existing messages and retries a conversation with a long message ID", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pg-backup-long-id-"));
    const longId = `user:${"long message ".repeat(400)}`;
    const queries = [];
    const inserted = [];
    let oldPrimaryKey = true;
    let existingHash = null;
    let failNextMessage = true;
    let policyVersion = 0;
    const policyWrites = [];
    const client = { release() {}, async query(sql, parameters = []) {
      queries.push(sql);
      if (sql.includes("SELECT version FROM ph_conversation_rules")) return { rows: [{ version: policyVersion }] };
      if (sql.includes("SELECT source_key, conversation_ref, message_hash, data FROM ph_messages"))
        return { rows: parameters.length > 1 ? [] : [
          { source_key: "source", conversation_ref: "ref", message_hash: "a", data: { id: "answer", kind: "reply", text: "answer", item: { type: "agentMessage", output: "secret" } } },
          { source_key: "source", conversation_ref: "ref", message_hash: "b", data: { id: "tool", kind: "tool", text: "secret" } }
        ] };
      if (sql.includes("UPDATE ph_messages SET data") || sql.includes("DELETE FROM ph_messages WHERE device_id")) policyWrites.push({ sql, parameters });
      if (sql.includes("INSERT INTO ph_conversation_rules")) policyVersion = parameters[1];
      if (sql.includes("pg_get_constraintdef")) return { rows: [{ definition: oldPrimaryKey
        ? "PRIMARY KEY (device_id, source_key, conversation_ref, message_id)"
        : "PRIMARY KEY (device_id, source_key, conversation_ref, message_hash)" }] };
      if (sql.includes("SELECT ctid::text")) return { rows: existingHash ? [] : [{ row_tid: "(0,1)", message_id: longId }] };
      if (sql.includes("UPDATE ph_messages SET message_hash")) existingHash = parameters[0];
      if (sql.includes("ADD CONSTRAINT ph_messages_pkey")) oldPrimaryKey = false;
      if (sql.includes("INSERT INTO ph_messages")) {
        if (failNextMessage) { failNextMessage = false; throw new Error("temporary write failure"); }
        inserted.push(parameters);
      }
      return { rows: [] };
    } };
    class FakePool { async connect() { return client; } async end() {} }
    const session = { id: "local", type: "windows", cwd: "C:\\work" };
    const service = createPostgresBackupService({ userData: root,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
        decryptString: value => value.toString("utf8") },
      sessionStore: { exportLibrary: () => [] }, statsFile: path.join(root, "missing.sqlite3"),
      terminalManager: { listSessions: () => [session], getSession: () => session },
      historyService: {
        listHistoryForSession: async () => ({ items: [{ ref: "codex:conversation", updatedAt: 1 }], nextCursor: null }),
        getHistoryMessagesForSession: async () => ({ messages: [{ id: longId, kind: "user", text: "content", timestamp: 1 }], nextCursor: null })
      }, PoolClass: FakePool, now: () => 1234 });
    try {
      service.load();
      await service.saveConfig({ enabled: true, host: "localhost", database: "backup", user: "user",
        password: "db-password", passphrase: "portable-passphrase" });
      await service.shutdown();
      service.trackSessions([{ type: "ssh", cwd: "/work", sshConfig: { host: "example.org", username: "user", port: 22 } }]);
      const first = await service.backupNow();
      expect(first.lastSuccessAt).toBeNull();
      expect(first.lastError).toContain("temporary write failure");
      const second = await service.backupNow();
      expect(second.lastSuccessAt).toBe(1234);
      expect(second.lastError).toBe("");
      expect(second.pendingSources).toEqual(["example.org · /work"]);
      expect(existingHash).toMatch(/^[a-f0-9]{64}$/);
      expect(policyWrites).toHaveLength(2);
      expect(policyWrites.every(write => write.parameters[0] === second.deviceId)).toBe(true);
      expect(policyWrites[0].parameters[4].item).toBeUndefined();
      expect(inserted).toHaveLength(1);
      expect(inserted[0][3]).toBe(longId);
      expect(inserted[0][4]).toBe(existingHash);
      expect(queries.some(sql => sql.includes("DROP CONSTRAINT ph_messages_pkey"))).toBe(true);
      expect(queries.filter(sql => sql.includes("ADD CONSTRAINT ph_messages_pkey"))).toHaveLength(1);
    } finally {
      await service.shutdown();
      if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
