import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
const { createModuleOwnerStore } = require("./module-owner-store.cjs");
const dirs = [];
const fields = { name: "渲染", responsibilities: "桌面交互", directories: ["src", "src", "C:\\repo\\electron"] };
function fixture() { const userData = mkdtempSync(path.join(tmpdir(), "pannel-owners-")); dirs.push(userData); const broadcast = vi.fn(); return { userData, broadcast, store: createModuleOwnerStore({ userData, broadcast }) }; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("module owner persistence and history", () => {
  it("isolates templates, normalizes directories, persists settings and snapshots across restarts", () => {
    const f = fixture();
    const result = f.store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo", source: "ai", sessionId: "run" });
    expect(result.records[0].directories).toEqual(["src", "electron"]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ kind: "owner", before: null, after: result.records[0] });
    expect(result.history[0]).not.toHaveProperty("records");
    expect(result.history[0]).toMatchObject({ source: "ai", sessionId: "run", operation: "add" });
    expect(f.store.get("two").records).toEqual([]);
    f.store.configure("one", { mode: "default", prompt: "custom" });
    const reloaded = createModuleOwnerStore({ userData: f.userData });
    expect(reloaded.get("one").records).toEqual(result.records);
    expect(reloaded.get("one").settings).toEqual({ mode: "default", prompt: "custom" });
    expect(f.broadcast).toHaveBeenCalledWith("module-owners:changed", { templateId: "one" });
  });
  it("restores only the selected owner, preserves others and records before/after", () => {
    const f = fixture();
    const first = f.store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo" });
    const record = first.records[0];
    const withOther = f.store.mutate("one", { operation: "add", ...fields, name: "其他" }, { cwd: "C:\\repo" });
    const changed = f.store.mutate("one", { operation: "update", id: record.id, version: record.version, ...fields, responsibilities: "new" }, { cwd: "C:\\repo" });
    expect(changed.history.at(-1)).toMatchObject({ before: record, after: { responsibilities: "new" } });
    expect(() => f.store.mutate("one", { operation: "delete", id: record.id, version: record.version })).toThrow("重新读取");
    expect(() => f.store.restore("one", { historyId: first.history[0].id, revision: 1 })).toThrow("重新预览");
    const restored = f.store.restore("one", { historyId: first.history[0].id, revision: changed.revision });
    expect(restored.records[0].responsibilities).toBe(fields.responsibilities);
    expect(restored.records[0].version).toBeGreaterThan(changed.records[0].version);
    expect(restored.records[1]).toEqual(withOther.records[1]);
    expect(restored.history).toHaveLength(4);
    expect(restored.history.at(-1)).toMatchObject({ operation: "restore", before: changed.records[0], after: restored.records[0] });
    const deleted = f.store.mutate("one", { operation: "delete", id: record.id, version: restored.records[0].version });
    expect(deleted.history.at(-1)).toMatchObject({ before: restored.records[0], after: null });
    const revived = f.store.restore("one", { historyId: deleted.history.at(-1).id, revision: deleted.revision });
    expect(revived.records.find(item => item.id === record.id)).toMatchObject({ id: record.id, responsibilities: fields.responsibilities });
    expect(revived.records[0]).toEqual(withOther.records[1]);
    const again = f.store.restore("one", { historyId: restored.history.at(-1).id, revision: revived.revision });
    expect(again.records.find(item => item.id === record.id).version).toBe(again.revision);
  });
  it("rejects restore name conflicts without writing history", () => {
    const f = fixture();
    const first = f.store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo" });
    const record = first.records[0];
    f.store.mutate("one", { operation: "delete", id: record.id, version: record.version });
    const current = f.store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo" });
    expect(() => f.store.restore("one", { historyId: first.history[0].id, revision: current.revision })).toThrow("名称不能重复");
    expect(f.store.get("one")).toEqual(current);
  });
  it("rejects duplicate names, empty fields, escaping paths and unknown arguments without changing history", () => {
    const f = fixture();
    f.store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo" });
    const before = f.store.get("one");
    for (const patch of [{}, { name: " " }, { name: "other", directories: [] }, { name: "other", directories: ["../outside"] }, { name: "other", directories: ["D:\\outside"] }, { name: "other", extra: true }]) {
      expect(() => f.store.mutate("one", { operation: "add", ...fields, ...patch }, { cwd: "C:\\repo" })).toThrow();
    }
    expect(f.store.get("one")).toEqual(before);
  });
  it("preserves unreadable saved data instead of overwriting it", () => {
    const f = fixture(); const file = path.join(f.userData, "module-owners.json");
    writeFileSync(file, "broken");
    const store = createModuleOwnerStore({ userData: f.userData });
    expect(() => store.get("one")).toThrow("读取失败");
    expect(() => store.mutate("one", { operation: "add", ...fields })).toThrow();
    expect(readFileSync(file, "utf8")).toBe("broken");
  });
});


it("persists owner changes and restores through SQLite across restarts", () => {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-owners-sqlite-")); dirs.push(userData);
  let dataStore = createBusinessDataStore({ userData }).open();
  let store = createModuleOwnerStore({ userData, dataStore });
  const first = store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo", source: "ai", sessionId: "s" });
  store.configure("one", { mode: "default", prompt: "sqlite" });
  dataStore.close(); dataStore = createBusinessDataStore({ userData }).open();
  store = createModuleOwnerStore({ userData, dataStore });
  expect(store.get("one").history).toEqual(first.history);
  expect(store.get("one").settings.prompt).toBe("sqlite");
  expect(store.get("two").records).toEqual([]);
  const restored = store.restore("one", { historyId: first.history[0].id, revision: first.revision });
  expect(restored.records[0]).toMatchObject({ id: first.records[0].id, version: 2 }); expect(restored.history).toHaveLength(2);
  dataStore.close();
});

it("keeps memory and notifications unchanged when persistence fails", () => {
  const broadcast = vi.fn();
  const dataStore = { read: () => ({ schemaVersion: 1, templates: {} }), write: () => { throw new Error("disk failure"); } };
  const store = createModuleOwnerStore({ userData: "unused", dataStore, broadcast });
  expect(() => store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo" })).toThrow("disk failure");
  expect(store.get("one").revision).toBe(0); expect(store.get("one").history).toEqual([]);
  expect(broadcast).not.toHaveBeenCalled();
});

it("preserves legacy snapshots alongside owner history through SQLite restarts", () => {
  const f = fixture();
  const old = { id: "old", revision: 0, operation: "initial", source: "system", at: 1, records: [] };
  writeFileSync(path.join(f.userData, "module-owners.json"), JSON.stringify({ schemaVersion: 1, templates: { one: { revision: 0, records: [], history: [old], settings: { mode: "plan", prompt: "test" } } } }));
  let dataStore = createBusinessDataStore({ userData: f.userData }).open();
  let store = createModuleOwnerStore({ userData: f.userData, dataStore });
  const current = store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo" });
  expect(() => store.restore("one", { historyId: "old", revision: current.revision })).toThrow("仅供查看");
  dataStore.close(); dataStore = createBusinessDataStore({ userData: f.userData }).open();
  store = createModuleOwnerStore({ userData: f.userData, dataStore });
  expect(store.get("one").history).toEqual([old, current.history[1]]);
  expect(JSON.parse(readFileSync(path.join(f.userData, "module-owners.json"), "utf8")).templates.one.history).toEqual([old]);
  dataStore.close();
});

it("persists task metadata in SQLite without changing owner versions or history", () => {
  const f = fixture(); let db = createBusinessDataStore({ userData: f.userData }); db.open();
  let store = createModuleOwnerStore({ userData: f.userData, dataStore: db });
  const state = store.mutate("one", { operation: "add", ...fields }, { cwd: "C:\\repo" });
  expect(store.get("one").tasks).toBeUndefined();
  const tasks = [{ id: "task", ownerId: state.records[0].id, enabled: true, executedCount: 3, nextRunAt: 123, lastRun: { status: "completed", sessionId: "run" } }];
  store.tasks("one", tasks); db.close();
  db = createBusinessDataStore({ userData: f.userData }); db.open();
  store = createModuleOwnerStore({ userData: f.userData, dataStore: db });
  expect(store.get("one").tasks).toEqual(tasks);
  expect(store.get("one").revision).toBe(state.revision);
  expect(store.get("one").records).toEqual(state.records);
  expect(store.get("one").history).toEqual(state.history);
  db.close();
});


it("queries history by stable owner ID, isolates templates and returns independent snapshots", () => {
  const f = fixture();
  const first = f.store.mutate("one", { operation: "add", ...fields }, { cwd: "C:/repo" }).records[0];
  f.store.mutate("one", { operation: "add", ...fields, name: "其他模块" }, { cwd: "C:/repo" });
  f.store.mutate("one", { operation: "update", id: first.id, version: first.version, ...fields, name: "改名模块" }, { cwd: "C:/repo" });
  const result = f.store.listHistory("one", { ownerId: first.id });
  expect(result.revision).toBe(3);
  expect(result.history.map(entry => entry.operation)).toEqual(["add", "update"]);
  expect(result.history.every(entry => entry.ownerId === first.id)).toBe(true);
  result.history[0].after.name = "changed copy";
  expect(f.store.listHistory("one", { ownerId: first.id }).history[0].after.name).toBe(fields.name);
  expect(f.store.listHistory("two", { ownerId: first.id })).toEqual({ revision: 0, history: [] });
  expect(f.store.listHistory("one", { ownerId: "missing" }).history).toEqual([]);
  expect(() => f.store.listHistory("one", { ownerId: " " })).toThrow();
});

it("excludes legacy whole-table snapshots from owner history", () => {
  const f = fixture();
  const record = { id: "owner", ...fields, version: 1, createdAt: 1, updatedAt: 1 };
  writeFileSync(path.join(f.userData, "module-owners.json"), JSON.stringify({ schemaVersion: 1, templates: { one: {
    revision: 1, records: [record], settings: { mode: "plan", prompt: "test" },
    history: [{ id: "legacy", revision: 1, operation: "update", at: 1, records: [record] }]
  } } }));
  const store = createModuleOwnerStore({ userData: f.userData });
  expect(store.listHistory("one", { ownerId: "owner" })).toEqual({ revision: 1, history: [] });
  expect(store.get("one").history).toHaveLength(1);
});
