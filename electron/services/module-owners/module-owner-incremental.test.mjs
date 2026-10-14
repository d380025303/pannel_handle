import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
const { createModuleOwnerStore } = require("./module-owner-store.cjs");
const fields = { name: "owner", responsibilities: "initial", directories: ["src"] };
function fixture(run) {
  const userData = mkdtempSync(path.join(tmpdir(), "owner-incremental-"));
  const dataStore = createBusinessDataStore({ userData }).open();
  const db = new DatabaseSync(path.join(userData, "agent-token-stats.sqlite3"));
  try { run({ userData, dataStore, db }); }
  finally { db.close(); dataStore.close(); rmSync(userData, { recursive: true, force: true }); }
}
describe("incremental owner SQLite transactions", () => {
  for (const count of [0, 1000, 5000]) it(`leaves unrelated ${count} large history entries untouched`, () => fixture(({ userData, dataStore, db }) => {
    const large = { responsibilities: "x".repeat(10000) };
    dataStore.write("module-owners.json", { schemaVersion: 1, templates: {
      B: { revision: count, records: [{ id: "B", ...fields }], settings: { mode: "plan", prompt: "B" },
        history: Array.from({ length: count }, (_, i) => ({ id: `B-${i}`, before: large, after: large })) }
    } });
    const store = createModuleOwnerStore({ userData, dataStore });
    const added = store.mutate("A", { operation: "add", ...fields });
    for (const table of ["templates", "records", "history"]) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const ref = action === "DELETE" ? "OLD" : "NEW";
        db.exec(`CREATE TRIGGER guard_${table}_${action} BEFORE ${action} ON app_module_owner_${table}
          WHEN ${ref}.template_id='B' BEGIN SELECT RAISE(ABORT, 'unrelated write'); END`);
      }
    }
    for (const action of ["UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER guard_existing_A_history_${action} BEFORE ${action} ON app_module_owner_history
        WHEN OLD.template_id='A' BEGIN SELECT RAISE(ABORT, 'existing history write'); END`);
    }
    const stringify = vi.spyOn(JSON, "stringify");
    const elapsed = [];
    let current = added;
    try {
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        current = store.mutate("A", { operation: "update", ...fields, responsibilities: `change-${i}`, id: current.records[0].id, version: current.records[0].version });
        elapsed.push(performance.now() - started);
      }
      expect(stringify.mock.calls.some(([value]) => value?.id?.startsWith?.("B-") || value?.responsibilities === large.responsibilities)).toBe(false);
      expect(stringify.mock.calls.filter(([value]) => value && typeof value === "object" && (value.kind === "owner" || value.id === added.records[0].id || value.settings))).toHaveLength(9);
    } finally { stringify.mockRestore(); }
    console.log(`Unrelated history ${count}: ${elapsed.map(ms => ms.toFixed(2)).join(', ')} ms`);
    const restored = store.restore("A", { historyId: added.history[0].id, revision: current.revision });
    expect(restored.records[0].responsibilities).toBe("initial");
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_module_owner_history WHERE template_id='B'").get().n).toBe(count);
    expect(dataStore.read("module-owners.json").templates.A).toEqual(restored);
  }));
  it("rolls back metadata, owner, history, memory and notifications when history insert fails", () => fixture(({ userData, dataStore, db }) => {
    const broadcast = vi.fn();
    const store = createModuleOwnerStore({ userData, dataStore, broadcast });
    const before = store.mutate("A", { operation: "add", ...fields });
    broadcast.mockClear();
    db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON app_module_owner_history BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const input = { operation: "update", ...fields, responsibilities: "changed", id: before.records[0].id, version: before.records[0].version };
    expect(() => store.mutate("A", input)).toThrow("injected failure");
    expect(() => store.restore("A", { historyId: before.history[0].id, revision: before.revision })).toThrow("injected failure");
    expect(store.get("A")).toEqual(before);
    expect(dataStore.read("module-owners.json").templates.A).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER fail_history");
    const stale = createModuleOwnerStore({ userData, dataStore });
    const changed = store.mutate("A", input);
    expect(() => store.mutate("A", input)).toThrow();
    expect(() => stale.mutate("A", input)).toThrow("重新读取");
    expect(stale.get("A")).toEqual(before);
    expect(() => store.restore("A", { historyId: before.history[0].id, revision: before.revision })).toThrow();
    const other = store.mutate("A", { operation: "add", ...fields, name: "other" });
    const restored = store.restore("A", { historyId: before.history[0].id, revision: other.revision });
    expect(restored.records[1]).toEqual(other.records[1]);
    const deleted = store.mutate("A", { operation: "delete", id: restored.records[0].id, version: restored.records[0].version });
    const revived = store.restore("A", { historyId: deleted.history.at(-1).id, revision: deleted.revision });
    expect(revived.records.map(x => x.name)).toEqual(["other", "owner"]);
    expect(dataStore.read("module-owners.json").templates.A).toEqual(revived);
    expect(changed.revision).toBe(2);
  }));
});

