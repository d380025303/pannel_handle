import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
      importLibrary: items => { imported.push(...items); return { importedCount: items.length, sessions: items }; }
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
    } finally {
      await service.shutdown();
      if (path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
