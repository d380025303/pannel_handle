import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createBusinessDataStore } from "./business-data-store.cjs";
import { createOpenRouterConfigStore } from "./openrouter-config-store.cjs";

function fixture(configFile = "openrouter.json", verificationProfile = "") {
  let db;
  const dataStore = createBusinessDataStore({
    userData: "unused", databaseFile: ":memory:",
    fsApi: { readFileSync() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } },
    Database: class extends DatabaseSync { constructor(file) { super(file); db = this; } }
  }).open();
  const options = { configFile, dataStore, verificationProfile };
  return { db, dataStore, options, store: createOpenRouterConfigStore(options) };
}

describe("incremental model verification persistence", () => {
  it.each(["openrouter", "nararouter", "minimax"])("writes exactly one row per result for 500 %s models", provider => {
    const fx = fixture(`${provider}.json`, "profile-v1");
    try {
      fx.store.setCachedModels(Array.from({ length: 500 }, (_, i) => ({ id: `model-${i}` })), 123);
      const table = `app_${provider}_records`;
      // Fail immediately if a verification save touches any catalog row.
      for (const operation of ["INSERT", "DELETE", "UPDATE"]) {
        const row = operation === "INSERT" ? "NEW" : "OLD";
        fx.db.exec(`CREATE TRIGGER guard_${operation} BEFORE ${operation} ON ${table}
          WHEN ${row}.record_group='cachedModels' BEGIN SELECT RAISE(ABORT, 'catalog touched'); END`);
      }
      const changes = () => fx.db.prepare("SELECT total_changes() AS count").get().count;
      const before = changes();
      const started = performance.now();
      for (let i = 0; i < 500; i++) {
        const previous = changes();
        fx.store.setModelVerification(`model-${i}`, { status: "passed", checkedAt: 456 });
        expect(changes() - previous).toBe(1);
      }
      const elapsed = performance.now() - started;
      expect(changes() - before).toBe(500);
      console.info(`${provider}: 500 verifications, 500 row changes, ${elapsed.toFixed(2)} ms (including assertions)`);
      const saved = fx.store.setModelVerification("model-0", { status: "failed", checkedAt: 789 });
      expect(changes() - before).toBe(501);
      const reloaded = createOpenRouterConfigStore(fx.options);
      reloaded.load();
      expect(reloaded.getModelVerifications()["model-0"]).toEqual(saved);
      expect(Object.keys(reloaded.getModelVerifications())).toHaveLength(500);
      expect(reloaded.getCachedModels()).toEqual(fx.store.getCachedModels());
      expect(reloaded.getPublicConfig().fetchedAt).toBe(123);
      for (const operation of ["INSERT", "DELETE", "UPDATE"]) fx.db.exec(`DROP TRIGGER guard_${operation}`);
      fx.store.setCachedModels([{ id: "model-0" }], 999);
      expect(fx.dataStore.read(fx.options.configFile).modelVerifications).toEqual({ "model-0": saved });
    } finally { fx.dataStore.close(); }
  });

  it.each([true, false])("rolls back memory and SQLite after an UPSERT failure (existing: %s)", existing => {
    const fx = fixture();
    try {
      fx.store.setCachedModels([{ id: "model" }]);
      if (existing) fx.store.setModelVerification("model", { status: "passed", checkedAt: 123 });
      const before = fx.dataStore.read("openrouter.json");
      const memory = fx.store.getModelVerifications();
      // Abort after the row mutation to exercise the real transaction rollback.
      for (const operation of ["INSERT", "UPDATE"]) fx.db.exec(`CREATE TRIGGER fail_${operation}
        AFTER ${operation} ON app_openrouter_records WHEN NEW.record_group='modelVerifications'
        BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`);
      expect(() => fx.store.setModelVerification("model", { status: "failed", checkedAt: 456 })).toThrow("injected write failure");
      expect(fx.store.getModelVerifications()).toEqual(memory);
      expect(fx.dataStore.read("openrouter.json")).toEqual(before);
      for (const operation of ["INSERT", "UPDATE"]) fx.db.exec(`DROP TRIGGER fail_${operation}`);
      const saved = fx.store.setModelVerification("model", { status: "failed", checkedAt: 456 });
      expect(fx.dataStore.read("openrouter.json").modelVerifications.model).toEqual(saved);
    } finally { fx.dataStore.close(); }
  });

  it("invalidates old profiles atomically and never resurrects stale results on reload", () => {
    const fx = fixture("nararouter.json", "old");
    try {
      fx.store.setCachedModels([{ id: "a" }, { id: "b" }]);
      for (const id of ["a", "b"]) fx.store.setModelVerification(id, { status: "passed", checkedAt: 123 });
      const options = { ...fx.options, verificationProfile: "new" };
      const current = createOpenRouterConfigStore(options);
      current.load();
      const before = fx.dataStore.read("nararouter.json");
      fx.db.exec(`CREATE TRIGGER fail_profile AFTER INSERT ON app_nararouter_records
        WHEN NEW.record_group='modelVerifications' BEGIN SELECT RAISE(FAIL, 'profile write failed'); END`);
      expect(() => current.setModelVerification("a", { status: "passed", checkedAt: 456 })).toThrow("profile write failed");
      expect(current.getModelVerifications()).toEqual({});
      expect(fx.dataStore.read("nararouter.json")).toEqual(before);
      fx.db.exec("DROP TRIGGER fail_profile");
      const saved = current.setModelVerification("a", { status: "passed", checkedAt: 456 });
      const reloaded = createOpenRouterConfigStore(options);
      reloaded.load();
      expect(reloaded.getModelVerifications()).toEqual({ a: saved });
      expect(reloaded.getCachedModels()).toEqual(current.getCachedModels());
    } finally { fx.dataStore.close(); }
  });
});
