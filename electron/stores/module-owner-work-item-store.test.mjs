import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBusinessDataStore } from "./business-data-store.cjs";
import { createWorkItemStore, queryWorkItems } from "./module-owner-work-item-store.cjs";
const fixtures = [];
function fixture() {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-work-item-store-"));
  const db = createBusinessDataStore({ userData }).open(); fixtures.push({ userData, db });
  return { db, userData };
}
const source = number => ({ sourceRunId: `run-${number}`, templateId: number % 2 ? "one" : "two", ownerId: `owner-${number % 2}`, taskId: "timer", taskName: "巡检", template: { title: "工程" }, owner: { name: "负责人" }, tools: [], output: `最终结果 ${number}` });
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); rmSync(f.userData, { recursive: true, force: true }); } });
describe("work item SQLite persistence", () => {
  it("backfills once, preserves false and rolls back when the completion marker fails", () => {
    const database = new DatabaseSync(":memory:");
    const updates = [];
    let rejectMarker = false;
    const store = createWorkItemStore(() => ({
      exec: sql => {
        if (/UPDATE app_module_owner_work_items SET value_json/.test(sql)) updates.push(sql);
        database.exec(sql);
      },
      prepare: sql => {
        if (rejectMarker && /INSERT INTO app_migrations.*VALUES\(4,/.test(sql)) throw new Error("marker failed");
        return database.prepare(sql);
      }
    }), callback => callback());
    const initialize = () => {
      database.exec("BEGIN IMMEDIATE");
      try { store.initializeWorkItems(); database.exec("COMMIT"); }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    };
    try {
      database.exec("CREATE TABLE app_migrations(version INTEGER PRIMARY KEY,completed_at INTEGER NOT NULL)");
      initialize();
      const insert = database.prepare(`INSERT INTO app_module_owner_work_items
        (id,source_run_id,task_id,owner_id,template_id,status,version,created_at,output,task_name,owner_name,template_name,needs_follow_up,value_json)
        VALUES(?,?,'task','owner','template','pending',1,1,'','task','owner','template',?,?)`);
      insert.run("missing-true", "run-1", 1, '{}');
      insert.run("missing-false", "run-2", 0, '{}');
      insert.run("explicit-false", "run-3", 0, '{"needsFollowUp":false}');
      database.exec("DELETE FROM app_migrations WHERE version=4");
      updates.length = 0;
      rejectMarker = true;
      expect(initialize).toThrow("marker failed");
      expect(database.prepare("SELECT 1 FROM app_migrations WHERE version=4").get()).toBeUndefined();
      expect(store.getWorkItem("missing-true")).toEqual({});
      rejectMarker = false;
      initialize();
      expect(store.getWorkItem("missing-true")).toEqual({ needsFollowUp: true });
      expect(store.getWorkItem("missing-false")).toEqual({ needsFollowUp: false });
      expect(store.getWorkItem("explicit-false")).toEqual({ needsFollowUp: false });
      expect(updates).toHaveLength(2);
      updates.length = 0;
      initialize(); initialize();
      expect(updates).toHaveLength(0);
    } finally { database.close(); }
  });
  it("adds a covering task index to existing databases and uses both template and task", () => {
    const database = new DatabaseSync(":memory:");
    let query;
    const store = createWorkItemStore(() => ({
      exec: sql => database.exec(sql),
      prepare: sql => { query = sql; return database.prepare(sql); }
    }), callback => callback());
    try {
      database.exec("CREATE TABLE app_migrations(version INTEGER PRIMARY KEY,completed_at INTEGER NOT NULL)");
      store.initializeWorkItems();
      database.exec("DROP INDEX app_module_owner_work_items_task_status");
      store.initializeWorkItems();
      store.initializeWorkItems();
      expect(store.workItemTaskUnprocessed("template", "task")).toBe(false);
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all("template", "task");
      expect(plan.map(row => row.detail).join(" ")).toMatch(/USING COVERING INDEX app_module_owner_work_items_task_status \(template_id=\? AND task_id=\?\)/);
    } finally {
      database.close();
    }
  });
  it("migrates legacy records and keeps explicit false across repeated reopen", () => {
    const { db, userData } = fixture();
    const item = db.insertWorkItem(source(0));
    db.close();
    const legacy = new DatabaseSync(path.join(userData, "agent-token-stats.sqlite3"));
    legacy.exec("DELETE FROM app_migrations WHERE version=4; UPDATE app_module_owner_work_items SET value_json=json_remove(value_json,'$.needsFollowUp'); ALTER TABLE app_module_owner_work_items DROP COLUMN needs_follow_up");
    legacy.close();
    db.open();
    expect(db.getWorkItem(item.id)).toMatchObject({ needsFollowUp: true, version: 1 });
    db.setWorkItemFollowUp(item.id, 1, false);
    db.close(); db.open(); db.close(); db.open();
    expect(db.getWorkItem(item.id)).toMatchObject({ needsFollowUp: false, version: 2 });
    expect(db.listWorkItems({ needsFollowUp: false }).total).toBe(1);
  });
  it("filters follow-up before pagination and combines other conditions", async () => {
    const { db } = fixture();
    for (let i = 0; i < 45; i++) {
      const item = db.insertWorkItem(source(i));
      expect(item.needsFollowUp).toBe(true);
      if (i % 2) db.setWorkItemFollowUp(item.id, item.version, false);
    }
    expect(db.listWorkItems({ needsFollowUp: true })).toMatchObject({ total: 23, records: expect.any(Array) });
    expect(db.listWorkItems({ needsFollowUp: true, page: 1 }).records).toHaveLength(3);
    expect(db.listWorkItems({ needsFollowUp: false }).total).toBe(22);
    expect((await db.listWorkItems({ needsFollowUp: false, templateId: "one", ownerId: "owner-1", statuses: ["pending"], keyword: "结果 1" })).total).toBe(6);
  });
  it.each(["creating", "running", "uncertain", "failed", "stopped", "completed", "void"])("retains follow-up through %s and rejects stale versions", status => {
    const { db } = fixture(); const item = db.insertWorkItem(source(0));
    const marked = db.setWorkItemFollowUp(item.id, item.version, false);
    expect(() => db.setWorkItemFollowUp(item.id, item.version, true)).toThrow("已变更");
    if (status === "void") {
      const removed = db.changeWorkItem(item.id, marked.version, "void");
      expect(removed.needsFollowUp).toBe(false);
      expect(db.setWorkItemFollowUp(item.id, removed.version, true).needsFollowUp).toBe(true);
      expect(db.changeWorkItem(item.id, db.getWorkItem(item.id).version, "restore").needsFollowUp).toBe(true);
    } else {
      const attempt = db.startWorkItemAttempt(item.id, marked.version, {}, {});
      const current = db.getWorkItem(item.id);
      const updated = db.setWorkItemFollowUp(item.id, current.version, true);
      db.updateWorkItemAttempt(item.id, attempt.id, { status });
      expect(db.getWorkItem(item.id)).toMatchObject({ needsFollowUp: true, status });
      expect(db.getWorkItem(item.id).version).toBeGreaterThanOrEqual(updated.version);
    }
  });

  it.each(["pending", "creating", "running", "uncertain", "failed", "stopped", "completed", "void"])("checks unprocessed task results in status %s with template and task isolation", status => {
    const { db } = fixture(); const item = db.insertWorkItem(source(0));
    if (status === "void") db.changeWorkItem(item.id, item.version, "void");
    else if (status !== "pending") {
      const attempt = db.startWorkItemAttempt(item.id, item.version, {}, {});
      db.updateWorkItemAttempt(item.id, attempt.id, { status });
    }
    expect(db.workItemTaskUnprocessed("two", "timer")).toBe(!["completed", "void"].includes(status));
    expect(db.workItemTaskUnprocessed("one", "timer")).toBe(false);
    expect(db.workItemTaskUnprocessed("two", "other")).toBe(false);
    if (status === "void") {
      db.changeWorkItem(item.id, db.getWorkItem(item.id).version, "restore");
      expect(db.workItemTaskUnprocessed("two", "timer")).toBe(true);
    }
  });
  it("excludes void items by default and filters multiple statuses before pagination", async () => {
    const { db } = fixture();
    const pending = db.insertWorkItem(source(0));
    const removed = db.insertWorkItem(source(1));
    db.changeWorkItem(removed.id, removed.version, "void");
    const completed = db.insertWorkItem(source(2));
    const attempt = db.startWorkItemAttempt(completed.id, completed.version, {}, {});
    db.updateWorkItemAttempt(completed.id, attempt.id, { status: "completed" });
    expect(db.listWorkItems().total).toBe(2);
    expect(db.listWorkItems().records.map(item => item.id)).not.toContain(removed.id);
    expect(db.listWorkItems({ statuses: ["completed", "void"] }).total).toBe(2);
    expect(db.listWorkItems({ statuses: ["pending", "completed", "void"] }).total).toBe(3);
    expect(db.listWorkItems({ statuses: ["void"] }).records[0].id).toBe(removed.id);
    expect(db.listWorkItems({ status: "pending" }).records[0].id).toBe(pending.id);
    expect(db.listWorkItems({ statuses: [] })).toMatchObject({ records: [], total: 0 });
    expect((await db.listWorkItems({ statuses: ["completed", "void"], templateId: "two", keyword: "结果 2" })).total).toBe(1);
  });
  it("paginates/filter summaries, preserves full replies and deduplicates stable source IDs across reopen", async () => {
    const { db, userData } = fixture();
    const first = db.insertWorkItem(source(0));
    for (let number = 1; number < 23; number++) db.insertWorkItem(source(number));
    expect(db.listWorkItems().records).toHaveLength(20);
    expect(db.listWorkItems({ page: 1 }).records).toHaveLength(3);
    expect(db.listWorkItems({ templateId: "one" }).total).toBe(11);
    expect((await db.listWorkItems({ ownerId: "owner-0", keyword: "结果 2" })).total).toBe(3);
    expect((await db.listWorkItems({ keyword: "%" })).total).toBe(0);
    expect(db.listWorkItems().records[0]).not.toHaveProperty("output");
    db.close(); db.open();
    expect(db.insertWorkItem({ ...source(0), output: "不能覆盖" }).id).toBe(first.id);
    expect(db.getWorkItem(first.id).output).toBe("最终结果 0");
    expect(db.listWorkItems().total).toBe(23);
    expect(userData).toBeTruthy();
  });
  it("locks attempts atomically, ignores terminal/old callbacks and protects task ownership", () => {
    const { db } = fixture(); const item = db.insertWorkItem(source(0));
    const first = db.startWorkItemAttempt(item.id, item.version, { prompt: item.output }, {});
    expect(() => db.startWorkItemAttempt(item.id, item.version, {}, {})).toThrow("已变更");
    expect(db.workItemOwnerBusy(item.templateId, item.ownerId)).toBe(true);
    db.updateWorkItemAttempt(item.id, first.id, { status: "completed", output: "首次完成" });
    const done = db.getWorkItem(item.id);
    const second = db.startWorkItemAttempt(item.id, done.version, { prompt: item.output }, {});
    db.updateWorkItemAttempt(item.id, first.id, { status: "failed", output: "迟到结果" });
    expect(db.getWorkItem(item.id)).toMatchObject({ status: "creating", latestAttemptId: second.id });
    expect(db.getWorkItemAttempt(item.id, first.id)).toMatchObject({ status: "completed", output: "首次完成" });
    const other = db.insertWorkItem(source(1));
    expect(() => db.getWorkItemAttempt(other.id, first.id)).toThrow("不属于");
    expect(db.listWorkItemAttempts(item.id).records[0]).not.toHaveProperty("input");
    db.recoverWorkItemAttempts(); expect(db.getWorkItem(item.id).status).toBe("uncertain");
  });
});

it.each(["pending", "failed", "stopped"])("manually completes %s without altering attempts and persists it", status => {
  const { db } = fixture(); const item = db.insertWorkItem(source(0));
  if (status !== "pending") {
    const attempt = db.startWorkItemAttempt(item.id, item.version, {}, {});
    db.updateWorkItemAttempt(item.id, attempt.id, { status, error: "old error", endedAt: 10 });
  }
  const before = db.getWorkItem(item.id);
  const attempts = db.listWorkItemAttempts(item.id);
  expect(() => db.markWorkItemCompleted(item.id, before.version + 1)).toThrow("已变更");
  const updated = db.markWorkItemCompleted(item.id, before.version);
  expect(updated).toEqual({ ...before, status: "completed", error: "", version: before.version + 1, updatedAt: expect.any(Number) });
  expect(db.listWorkItemAttempts(item.id)).toEqual(attempts);
  if (before.latestAttemptId) {
    db.updateWorkItemAttempt(item.id, before.latestAttemptId, { status: "failed", error: "late event" });
    expect(db.getWorkItem(item.id).status).toBe("completed");
  }
  db.close(); db.open();
  expect(db.getWorkItem(item.id)).toEqual(updated);
});
it.each(["creating", "running", "uncertain", "completed", "void"])("rejects manual completion of %s", status => {
  const { db } = fixture(); const item = db.insertWorkItem(source(0));
  if (status === "void") db.changeWorkItem(item.id, item.version, "void");
  else {
    const attempt = db.startWorkItemAttempt(item.id, item.version, {}, {});
    db.updateWorkItemAttempt(item.id, attempt.id, { status });
  }
  const current = db.getWorkItem(item.id);
  expect(() => db.markWorkItemCompleted(item.id, current.version)).toThrow("仅待执行");
  expect(db.getWorkItem(item.id)).toEqual(current);
});

it("keeps substring/filter/page results identical on a read-only Worker snapshot", async () => {
  const { db, userData } = fixture();
  for (let i = 0; i < 45; i++) {
    const item = db.insertWorkItem({ ...source(i), output: `MiXeD %_结果 ${i}`, createdAt: 100 });
    if (i % 3 === 0) db.setWorkItemFollowUp(item.id, 1, false);
    if (i % 5 === 0) db.changeWorkItem(item.id, db.getWorkItem(item.id).version, "void");
  }
  const reference = new DatabaseSync(path.join(userData, "agent-token-stats.sqlite3"), { readOnly: true });
  try {
    for (const query of [
      { keyword: "mixed", page: 1 }, { keyword: "%_" }, { keyword: "巡检" },
      { keyword: "负责人" }, { keyword: "工程" }, { keyword: "missing" },
      { keyword: "结果", templateId: "one", ownerId: "owner-1", needsFollowUp: false, statuses: ["pending", "void"] },
      { keyword: "结果", statuses: [] }, { keyword: "结果", status: "void" }
    ]) expect(await db.listWorkItems(query)).toEqual(queryWorkItems(reference, query));
  } finally { reference.close(); }
  db.close(); db.open();
  expect((await db.listWorkItems({ keyword: "mixed" })).total).toBe(36);
});

it("keeps timers responsive for five searches over 3000 replies of 33 KiB", async () => {
  const { db, userData } = fixture();
  const writer = new DatabaseSync(path.join(userData, "agent-token-stats.sqlite3"));
  const store = createWorkItemStore(() => writer, callback => callback());
  const output = "a".repeat(33 * 1024);
  try {
    writer.exec("BEGIN");
    for (let i = 0; i < 3000; i++) store.insertWorkItem({ ...source(i), output });
    writer.exec("COMMIT");
    const timings = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      let ticks = 0;
      let lastTick = start;
      let maxGap = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - lastTick); lastTick = now; ticks++;
      }, 5);
      const zeroTimer = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
      try {
        expect(await db.listWorkItems({ keyword: "absent-needle", page: 0 })).toMatchObject({ total: 0, records: [] });
        const elapsed = performance.now() - start;
        const zeroDelay = await zeroTimer;
        timings.push({ elapsed: Math.round(elapsed), zeroDelay: Math.round(zeroDelay), maxGap: Math.round(maxGap), ticks });
        expect(ticks).toBeGreaterThan(5);
        expect(zeroDelay).toBeLessThan(100);
        expect(maxGap).toBeLessThan(100);
      } finally { clearInterval(timer); }
    }
    console.info("work item Worker search timing (ms)", timings);
  } finally { writer.close(); }
}, 30000);

it("rejects active searches on close and reports Worker connection failures", async () => {
  const { db, userData } = fixture();
  const pending = db.listWorkItems({ keyword: "missing" });
  const rejected = expect(pending).rejects.toThrow("已关闭");
  await db.close(); await rejected;
  db.open();
  expect((await db.listWorkItems({ keyword: "missing" })).total).toBe(0);
  const { createWorkItemSearchReader } = await import("./work-item-search-reader.cjs");
  const reader = createWorkItemSearchReader(path.join(userData, "missing.sqlite"));
  await expect(reader.search({ keyword: "x" })).rejects.toThrow();
  await reader.close();
});
