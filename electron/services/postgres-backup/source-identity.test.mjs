import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createPostgresBackupService } = require("./postgres-backup-service.cjs");
const { SAVED_MESSAGE_VERSION } = require("../conversation-history/saved-message.cjs");

it.each([false, true])("backs up distinct SSH execution locations with reversed order=%s and preserves legacy history", async reverse => {
  const remote = { id: "remote", type: "ssh", cwd: "/work",
    sshConfig: { host: "host", username: "user", port: 22 } };
  const local = { ...remote, id: "local", agentLocation: "local", runtimeCwd: "C:\\one" };
  const other = { ...remote, id: "other", agentLocation: "local", localAgentCwd: "C:\\two" };
  let sessions = reverse ? [other, local, remote] : [remote, local, other];
  const legacyKey = JSON.stringify(["ssh", "host", "user", 22, "", "/work"]);
  const conversations = new Map([[`${legacyKey}:legacy`, { source_key: legacyKey,
    conversation_ref: "legacy", metadata: { title: "old backup" } }]]);
  const messages = new Map([[`${legacyKey}:legacy`, [{ id: "old", kind: "user", text: "old history" }]]]);
  const historyCalls = [];
  let saved = { sources: [remote, local] };
  const client = { release() {}, async query(sql, params = []) {
    if (sql.includes("SELECT version")) return { rows: [{ version: SAVED_MESSAGE_VERSION }] };
    if (sql.includes("INSERT INTO ph_conversations(")) {
      conversations.set(`${params[1]}:${params[2]}`, { source_key: params[1], conversation_ref: params[2], metadata: params[3] });
    }
    if (sql.includes("INSERT INTO ph_messages(")) {
      messages.set(`${params[1]}:${params[2]}`, JSON.parse(params[3]).map(row => row.data));
    }
    if (sql.includes("SELECT source_key,conversation_ref,metadata")) return { rows: [...conversations.values()] };
    if (sql.includes("SELECT data FROM ph_messages")) return { rows: (messages.get(`${params[1]}:${params[2]}`) || []).map(data => ({ data })) };
    return { rows: [] };
  } };
  class FakePool { async connect() { return client; } async end() {} }
  const service = createPostgresBackupService({ userData: "unused", PoolClass: FakePool,
    dataStore: { read: () => structuredClone(saved), write: (_file, value) => { saved = structuredClone(value); } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    sessionStore: { exportLibrary: () => [] }, fsApi: { existsSync: () => false },
    terminalManager: { listSessions: () => sessions, getSession: id => sessions.find(session => session.id === id) },
    historyService: {
      async listHistoryForSession(session) {
        const name = session.agentLocation === "local" ? session.runtimeCwd || session.localAgentCwd : "remote";
        historyCalls.push(name);
        return { items: [{ ref: "shared-ref", updatedAt: 1, title: name }], nextCursor: null };
      },
      async getHistoryMessagesForSession(session) {
        return { messages: [{ id: "shared-id", kind: "user", text: session.agentLocation === "local"
          ? session.runtimeCwd || session.localAgentCwd : "remote" }], nextCursor: null };
      }
    } });
  try {
    service.load();
    await service.saveConfig({ enabled: true, host: "db", database: "backup", user: "user", password: "password", passphrase: "passphrase" });
    await service.shutdown();
    const result = await service.backupNow();
    expect(result.lastError).toBe("");
    expect(result.pendingSources).toEqual([]);
    expect(result.lastSuccessAt).not.toBeNull();
    expect(historyCalls.sort()).toEqual(["C:\\one", "C:\\two", "remote"]);
    expect(saved.sources).toHaveLength(3);
    expect([...messages.values()].flat().map(message => message.text).sort()).toEqual(["C:\\one", "C:\\two", "old history", "remote"]);
    expect(conversations.get(`${legacyKey}:shared-ref`).metadata.title).toBe("remote");
    const history = await service.listConversations(result.deviceId);
    expect(history).toContainEqual(expect.objectContaining({ source_key: legacyKey, conversation_ref: "legacy" }));
    expect(await service.getMessages(result.deviceId, legacyKey, "legacy")).toEqual([{ id: "old", kind: "user", text: "old history" }]);
    // Saved local sources remain readable without an active SSH connection; only the remote is pending.
    sessions = [];
    historyCalls.length = 0;
    expect((await service.backupNow()).pendingSources).toEqual(["host · /work"]);
    expect(historyCalls.sort()).toEqual(["C:\\one", "C:\\two"]);
  } finally { await service.shutdown(); }
});
