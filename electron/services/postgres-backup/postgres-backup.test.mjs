import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { encryptPortable, decryptPortable } = require("./backup-crypto.cjs");
const { getRemoteDashboard } = require("./remote-dashboard.cjs");
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");
const { SAVED_MESSAGE_VERSION } = require("../conversation-history/saved-message.cjs");

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
      expect(JSON.parse(inserted[0][3])[0].message_id).toBe(longId);
      expect(JSON.parse(inserted[0][3])[0].message_hash).toBe(existingHash);
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


describe("conversation batch synchronization", () => {
  it("checks each history page once and uploads only changed, outdated or missing conversations", async () => {
    const items = Array.from({ length: 203 }, (_, i) => ({ ref: `conversation-${i}`, updatedAt: 10 }));
    const checks = [];
    const uploads = [];
    const ruleWrites = [];
    let mixed = false;
    let empty = false;
    const client = { release() {}, async query(sql, params = []) {
      if (sql.includes("SELECT version FROM ph_conversation_rules")) return { rows: [{ version: SAVED_MESSAGE_VERSION }] };
      if (sql.includes("FROM ph_conversations WHERE")) {
        expect(sql).toContain("device_id=$1 AND source_key=$2 AND conversation_ref = ANY($3::text[])");
        checks.push(params);
        // Reverse rows to ensure matching uses the reference, not the result order.
        return { rows: params[2].filter(ref => !mixed || ref !== items[202].ref).map(ref => ({
          conversation_ref: ref,
          updated_at: String(mixed && ref === items[200].ref ? 9 : 10),
          message_rule_version: mixed && ref === items[201].ref ? SAVED_MESSAGE_VERSION - 1 : SAVED_MESSAGE_VERSION
        })).reverse() };
      }
      if (sql.includes("INSERT INTO ph_conversations(")) uploads.push(params[2]);
      if (sql.includes("UPDATE ph_conversations SET message_rule_version")) ruleWrites.push(params);
      return { rows: [] };
    } };
    class FakePool { async connect() { return client; } async end() {} }
    const session = { id: "local", type: "windows", cwd: "C:\\work" };
    const historyService = {
      listHistoryForSession: vi.fn(async (_session, { cursor, limit }) => {
        expect(limit).toBe(200);
        const offset = Number(cursor || 0);
        return { items: empty ? [] : items.slice(offset, offset + limit),
          nextCursor: !empty && offset === 0 ? "200" : null };
      }),
      getHistoryMessagesForSession: vi.fn(async (_session, { conversationRef }) => ({
        messages: [{ id: conversationRef, kind: "user", text: "content" }], nextCursor: null
      }))
    };
    const service = createPostgresBackupService({ userData: tmpdir(),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString("utf8") },
      sessionStore: { exportLibrary: () => [] }, statsFile: "missing", fsApi: { existsSync: () => false },
      dataStore: { read: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, write() {} },
      terminalManager: { listSessions: () => [session], getSession: () => session }, historyService, PoolClass: FakePool
    });
    try {
      service.load();
      await service.saveConfig({ enabled: true, host: "localhost", database: "backup", user: "user", password: "password", passphrase: "passphrase" });
      await service.shutdown();
      expect((await service.backupNow()).lastError).toBe("");
      expect(checks).toHaveLength(2);
      expect(checks.map(params => params[2])).toEqual([items.slice(0, 200).map(item => item.ref), items.slice(200).map(item => item.ref)]);
      expect(checks.every(params => params[0] === service.publicState().deviceId && params[1] === JSON.stringify(["windows", "", "", null, "", "c:/work"]))).toBe(true);
      expect(historyService.getHistoryMessagesForSession).not.toHaveBeenCalled();
      expect(uploads).toEqual([]);
      checks.length = 0;
      mixed = true;
      expect((await service.backupNow()).lastError).toBe("");
      expect(checks).toHaveLength(2);
      expect(uploads).toEqual(items.slice(200).map(item => item.ref));
      expect(historyService.getHistoryMessagesForSession.mock.calls.map(([, options]) => options.conversationRef)).toEqual(uploads);
      expect(ruleWrites.map(params => [params[0], params[3]])).toEqual(uploads.map(ref => [SAVED_MESSAGE_VERSION, ref]));
      checks.length = 0;
      empty = true;
      expect((await service.backupNow()).lastError).toBe("");
      expect(checks).toEqual([]);
      expect(historyService.getHistoryMessagesForSession).toHaveBeenCalledTimes(3);
    } finally { await service.shutdown(); }
  });

  it("writes 1000 messages in five delayed batches, deduplicates, skips unchanged backups and rolls back failures", async () => {
    let remote = { conversation: null, messages: new Map() };
    let beforeTransaction;
    let updatedAt = 1;
    let failBatch = 0;
    const batches = [];
    const queries = [];
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: `message-${i}`, kind: "reply", text: `answer-${i}`, timestamp: i,
      item: { type: "agentMessage", output: "private protocol" }
    }));
    const client = { release() {}, async query(sql, params = []) {
      queries.push(sql);
      if (sql === "BEGIN") beforeTransaction = structuredClone(remote);
      if (sql === "ROLLBACK") remote = beforeTransaction;
      if (sql.includes("SELECT version FROM ph_conversation_rules")) return { rows: [{ version: 2 }] };
      if (sql.includes("SELECT conversation_ref, updated_at, message_rule_version")) return { rows: remote.conversation ? [remote.conversation] : [] };
      if (sql.includes("INSERT INTO ph_conversations(")) remote.conversation = { conversation_ref: params[2], updated_at: params[4], message_rule_version: 0 };
      if (sql.includes("UPDATE ph_conversations SET message_rule_version")) remote.conversation.message_rule_version = params[0];
      if (sql.includes("INSERT INTO ph_messages(")) {
        expect(sql).toContain("jsonb_to_recordset($4::jsonb)");
        expect(sql).toContain("ON CONFLICT(device_id,source_key,conversation_ref,message_hash)");
        expect(sql).toContain("DO UPDATE SET message_id=excluded.message_id,data=excluded.data");
        const batch = JSON.parse(params[3]);
        expect(new Set(batch.map(row => row.message_hash)).size).toBe(batch.length);
        batches.push(batch);
        await new Promise(resolve => setTimeout(resolve, 5));
        if (batches.length === failBatch) throw new Error("message batch failed");
        for (const row of batch) remote.messages.set(JSON.stringify([...params.slice(0, 3), row.message_hash]), row);
      }
      return { rows: [] };
    } };
    class FakePool { async connect() { return client; } async end() {} }
    const session = { id: "local", type: "windows", cwd: "C:\\work" };
    const historyService = {
      listHistoryForSession: async () => ({ items: [{ ref: "codex:conversation", updatedAt }], nextCursor: null }),
      getHistoryMessagesForSession: vi.fn(async (_session, { cursor, limit }) => {
        expect(limit).toBe(200);
        const offset = Number(cursor || 0);
        return { messages: messages.slice(offset, offset + limit), nextCursor: offset + limit < messages.length ? String(offset + limit) : null };
      })
    };
    const service = createPostgresBackupService({ userData: tmpdir(),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString("utf8") },
      sessionStore: { exportLibrary: () => [] }, statsFile: "missing", fsApi: { existsSync: () => false },
      dataStore: { read: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, write() {} },
      terminalManager: { listSessions: () => [session], getSession: () => session }, historyService, PoolClass: FakePool
    });
    try {
      service.load();
      await service.saveConfig({ enabled: true, host: "localhost", database: "backup", user: "user", password: "password", passphrase: "passphrase" });
      await service.shutdown();
      expect((await service.backupNow()).lastError).toBe("");
      expect(batches.map(batch => batch.length)).toEqual([200, 200, 200, 200, 200]);
      expect([...remote.messages.values()].map(row => row.data)).toEqual(messages.map(({ item, ...message }) => message));
      const original = structuredClone(remote);
      await service.backupNow();
      expect(batches).toHaveLength(5);
      expect(historyService.getHistoryMessagesForSession).toHaveBeenCalledTimes(5);
      expect(remote).toEqual(original);

      updatedAt = 2;
      messages[0].text = "updated answer";
      batches.length = 0;
      failBatch = 2;
      expect((await service.backupNow()).lastError).toContain("message batch failed");
      expect(remote).toEqual(original);
      expect(queries.at(-1)).toBe("ROLLBACK");
      failBatch = 0;
      batches.length = 0;
      expect((await service.backupNow()).lastError).toBe("");
      expect(remote.messages.size).toBe(1000);
      expect([...remote.messages.values()][0].data.text).toBe("updated answer");

      // Last duplicate wins both inside a page and across page boundaries.
      updatedAt = 3;
      messages.splice(0, messages.length,
        { id: "duplicate", kind: "user", text: "first" },
        { id: "duplicate", kind: "user", text: "last in page" },
        ...Array.from({ length: 198 }, () => ({ id: "tool", kind: "tool", text: "filtered" })),
        { id: "duplicate", kind: "user", text: "last across pages" });
      batches.length = 0;
      await service.backupNow();
      expect(batches.map(batch => batch.length)).toEqual([1, 1]);
      expect(batches[0][0].data.text).toBe("last in page");
      expect([...remote.messages.values()].at(-1).data.text).toBe("last across pages");
      updatedAt = 4;
      messages.splice(0, messages.length, { id: "tool", kind: "tool", text: "filtered" });
      batches.length = 0;
      await service.backupNow();
      expect(batches).toEqual([]);
      expect(remote.conversation.message_rule_version).toBe(2);
    } finally { await service.shutdown(); }
  });
});

describe("statistics snapshot synchronization", () => {
  it("removes deleted details, preserves other devices and epochs, and rolls back failed snapshots", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pg-backup-stats-"));
    const local = {
      token_sessions: [{ id: "codex:session", provider: "codex", updated_at: 1, total_tokens: 10 }],
      token_session_skills: [{ session_id: "codex:session", name: "skill", count: 3 }],
      token_session_models: [{ session_id: "codex:session", model: "model" }],
      token_session_mcp_tools: [{ session_id: "codex:session", server_name: "server", tool_name: "tool", count: 2 }],
      token_daily: [{ date: "2026-10-12", provider: "codex", total_tokens: 10 }]
    };
    class FakeDatabase {
      prepare(sql) { return { all: () => structuredClone(local[sql.split(" ").at(-1)]) }; }
      close() {}
    }
    let remote = [];
    let beforeTransaction;
    let failWrite = false;
    let hasStatsFile = true;
    const batches = [];
    const statsQueries = [];
    let uploadingStats = false;
    const client = { release() {}, async query(sql, params = []) {
      if (sql.includes("DELETE FROM ph_stat_rows")) uploadingStats = true;
      if (uploadingStats) statsQueries.push(sql);
      if (sql === "COMMIT" || sql === "ROLLBACK") uploadingStats = false;
      if (sql === "BEGIN") beforeTransaction = structuredClone(remote);
      else if (sql === "ROLLBACK") remote = beforeTransaction;
      else if (sql.includes("DELETE FROM ph_stat_rows")) {
        expect(sql).toContain("device_id=$1 AND table_name=$2 AND split_part(row_key, ':', 1)=$3");
        expect(sql).toContain("ANY($4::text[])");
        remote = remote.filter(row => !(row.device_id === params[0] && row.table_name === params[1]
          && row.row_key.split(":")[0] === params[2] && !params[3].includes(row.row_key)));
      } else if (sql.includes("INSERT INTO ph_stat_rows")) {
        expect(sql).toContain("jsonb_to_recordset($2::jsonb)");
        expect(sql).toContain("ON CONFLICT(device_id,table_name,row_key) DO UPDATE SET data=excluded.data");
        expect(sql).toContain("WHERE ph_stat_rows.data IS DISTINCT FROM excluded.data");
        const batch = JSON.parse(params[1]);
        batches.push(batch);
        if (failWrite && batch.some(row => row.table_name === "token_session_skills")) throw new Error("statistics write failed");
        for (const value of batch) {
          const row = { device_id: params[0], ...value };
          const index = remote.findIndex(item => item.device_id === row.device_id
            && item.table_name === row.table_name && item.row_key === row.row_key);
          if (index < 0) remote.push(row);
          else if (JSON.stringify(remote[index].data) !== JSON.stringify(row.data)) remote[index] = row;
        }
      } else if (sql.includes("SELECT device_id,table_name,data FROM ph_stat_rows")) {
        return { rows: structuredClone(params.length ? remote.filter(row => row.device_id === params[0]) : remote) };
      }
      return { rows: [] };
    } };
    class FakePool { async connect() { return client; } async end() {} }
    const service = createPostgresBackupService({ userData: root,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
        decryptString: value => value.toString("utf8") },
      sessionStore: { exportLibrary: () => [] }, statsFile: path.join(root, "stats.sqlite3"),
      fsApi: { existsSync: () => hasStatsFile }, Database: FakeDatabase, PoolClass: FakePool,
      terminalManager: { listSessions: () => [] }, historyService: {},
      dataStore: { read: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, write() {} }
    });
    try {
      service.load();
      await service.saveConfig({ enabled: true, host: "localhost", database: "backup", user: "user",
        password: "password", passphrase: "passphrase" });
      await service.shutdown();
      const deviceId = service.publicState().deviceId;
      const dashboard = () => service.getDashboard({ deviceId, range: "all" });
      await service.backupNow();
      expect((await dashboard()).summary.skillCalls).toBe(3);
      const protectedRows = remote.flatMap(row => [
        { ...structuredClone(row), device_id: "other-device" },
        { ...structuredClone(row), row_key: row.row_key.replace(/^0:/, "10:"), data: { ...row.data, backup_epoch: 10 } }
      ]);
      remote.push(...structuredClone(protectedRows));
      const assertProtected = () => expect(remote.filter(row => row.device_id !== deviceId
        || row.data.backup_epoch === 10)).toEqual(protectedRows);
      local.token_session_skills = [];
      local.token_session_models = [];
      local.token_session_mcp_tools = [];
      local.token_daily = [];
      expect((await service.backupNow()).lastError).toBe("");
      const current = (await dashboard()).sessions.find(row => row.id === `${deviceId}:0:codex:session`);
      expect(current.capabilities.skills.totalCalls).toBe(0);
      expect(current.capabilities.mcp.totalCalls).toBe(0);
      expect(current.models).toEqual([]);
      expect(remote.filter(row => row.device_id === deviceId && row.data.backup_epoch === 0))
        .toEqual([expect.objectContaining({ table_name: "token_sessions" })]);
      assertProtected();

      local.token_sessions[0].total_tokens = 20;
      await service.backupNow();
      expect(remote.find(row => row.device_id === deviceId && row.row_key === "0:codex:session").data.total_tokens).toBe(20);
      assertProtected();

      // A failure in the second batch must undo the first batch and all deletions.
      local.token_sessions = Array.from({ length: 501 }, (_, i) => ({
        id: `codex:new-${i}`, provider: "codex", updated_at: 2, total_tokens: i
      }));
      local.token_session_skills = [{ session_id: "codex:new-0", name: "new-skill", count: 1 }];
      const previous = structuredClone(remote);
      failWrite = true;
      await expect(service.backupNow()).rejects.toThrow("statistics write failed");
      expect(service.publicState().lastError).toBe("statistics write failed");
      expect(remote).toEqual(previous);
      assertProtected();
      failWrite = false;
      local.token_session_skills = [];
      local.token_sessions = Array.from({ length: 1000 }, (_, i) => ({
        id: `codex:batch-${i}`, provider: "codex", total_tokens: i
      }));
      let firstRound;
      for (let round = 0; round < 2; round += 1) {
        batches.length = 0;
        statsQueries.length = 0;
        await service.backupNow();
        expect(batches.map(batch => batch.length)).toEqual([500, 500]);
        // Five deletions, two UPSERTs, COMMIT (plus BEGIN = nine queries).
        expect(statsQueries).toHaveLength(8);
        expect(remote.filter(row => row.device_id === deviceId && row.data.backup_epoch === 0)).toHaveLength(1000);
        if (round === 0) firstRound = structuredClone(remote);
        else expect(remote).toEqual(firstRound);
        assertProtected();
      }
      const unchanged = structuredClone(remote);
      for (const table of Object.keys(local)) local[table] = [];
      hasStatsFile = false;
      await service.backupNow();
      expect(remote).toEqual(unchanged);
      hasStatsFile = true;
      await service.backupNow();
      expect(remote).toEqual(protectedRows);
      expect(batches).toHaveLength(2);
      assertProtected();
    } finally {
      await service.shutdown();
      if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
