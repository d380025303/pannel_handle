import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
const { createModuleOwnerStore } = require("./module-owner-store.cjs");

describe("task metadata persistence", () => {
  it.each([0, 10000])("updates one row with %i unrelated history entries and survives reload", historyCount => {
    let db;
    class Database extends DatabaseSync {
      constructor(file) { super(file); db = this; }
    }
    const userData = "task-persistence-test";
    const dataStore = createBusinessDataStore({ userData, databaseFile: ":memory:", Database,
      fsApi: { readFileSync() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } } }).open();
    try {
      const record = { id: "owner", responsibilities: "x".repeat(2048), recentActivity: "" };
      const template = { revision: 7, settings: { mode: "plan", prompt: "test" }, records: [record], history: [], tasks: [] };
      dataStore.write("module-owners.json", { schemaVersion: 1, promptTemplates: [{ id: "prompt" }], templates: {
        one: template, two: { ...template, history: Array.from({ length: historyCount }, (_, id) => ({ id, before: record, after: record })) }
      } });
      const broadcast = vi.fn();
      const store = createModuleOwnerStore({ userData, dataStore, broadcast });
      // Reject any record/history write, including a delete followed by identical inserts.
      for (const table of ["app_module_owner_records", "app_module_owner_history"]) {
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
          db.exec(`CREATE TRIGGER forbid_${table}_${operation} BEFORE ${operation} ON ${table}
            BEGIN SELECT RAISE(ABORT, 'owner rows must remain untouched'); END;`);
        }
      }
      const otherMetadata = db.prepare("SELECT value_json FROM app_module_owner_templates WHERE template_id='two'").get().value_json;
      const tasks = [{ id: "task", executedCount: 3, nextRunAt: 123456, enabled: false, status: "stopped" }];
      const before = db.prepare("SELECT total_changes() AS count").get().count;
      const started = performance.now();
      const updated = store.tasks("one", tasks);
      const elapsed = performance.now() - started;
      expect(db.prepare("SELECT total_changes() AS count").get().count - before).toBe(1);
      console.info(`task update: unrelated history=${historyCount}, changes=1, elapsed=${elapsed.toFixed(3)} ms`);
      expect(updated).toEqual({ ...template, tasks });
      expect(broadcast).toHaveBeenCalledExactlyOnceWith("module-owners:changed", { templateId: "one" });
      expect(db.prepare("SELECT value_json FROM app_module_owner_templates WHERE template_id='two'").get().value_json).toBe(otherMetadata);
      const reloaded = createModuleOwnerStore({ userData, dataStore });
      expect(reloaded.get("one")).toEqual(updated);
      expect(reloaded.get("two").history).toHaveLength(historyCount);
      expect(reloaded.promptTemplates()).toEqual([{ id: "prompt" }]);
      tasks[0].executedCount = 999;
      updated.tasks[0].nextRunAt = 0;
      expect(store.getSchedulerState("one").tasks[0]).toMatchObject({ executedCount: 3, nextRunAt: 123456 });
      expect(store.tasks("new", []).records).toEqual([]);
      expect(createModuleOwnerStore({ userData, dataStore }).get("new").tasks).toEqual([]);

      db.exec(`CREATE TRIGGER reject_metadata BEFORE UPDATE ON app_module_owner_templates
        BEGIN SELECT RAISE(ABORT, 'write failed'); END;`);
      broadcast.mockClear();
      const saved = store.get("one");
      expect(() => store.tasks("one", [])).toThrow("write failed");
      expect(store.get("one")).toEqual(saved);
      expect(broadcast).not.toHaveBeenCalled();
      expect(createModuleOwnerStore({ userData, dataStore }).get("one")).toEqual(saved);
    } finally { dataStore.close(); }
  });
});
