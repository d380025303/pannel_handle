import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBusinessDataStore } from "./business-data-store.cjs";
const fixtures = [];
function fixture() {
  const userData = mkdtempSync(path.join(tmpdir(), "pannel-work-item-store-"));
  const db = createBusinessDataStore({ userData }).open(); fixtures.push({ userData, db });
  return { db, userData };
}
const source = number => ({ sourceRunId: `run-${number}`, templateId: number % 2 ? "one" : "two", ownerId: `owner-${number % 2}`, taskId: "timer", taskName: "巡检", template: { title: "工程" }, owner: { name: "负责人" }, tools: [], output: `最终结果 ${number}` });
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); rmSync(f.userData, { recursive: true, force: true }); } });
describe("work item SQLite persistence", () => {
  it("migrates legacy records and keeps explicit false across repeated reopen", () => {
    const { db, userData } = fixture();
    const item = db.insertWorkItem(source(0));
    db.close();
    const legacy = new DatabaseSync(path.join(userData, "agent-token-stats.sqlite3"));
    legacy.exec("UPDATE app_module_owner_work_items SET value_json=json_remove(value_json,'$.needsFollowUp'); ALTER TABLE app_module_owner_work_items DROP COLUMN needs_follow_up");
    legacy.close();
    db.open();
    expect(db.getWorkItem(item.id)).toMatchObject({ needsFollowUp: true, version: 1 });
    db.setWorkItemFollowUp(item.id, 1, false);
    db.close(); db.open(); db.close(); db.open();
    expect(db.getWorkItem(item.id)).toMatchObject({ needsFollowUp: false, version: 2 });
    expect(db.listWorkItems({ needsFollowUp: false }).total).toBe(1);
  });
  it("filters follow-up before pagination and combines other conditions", () => {
    const { db } = fixture();
    for (let i = 0; i < 45; i++) {
      const item = db.insertWorkItem(source(i));
      expect(item.needsFollowUp).toBe(true);
      if (i % 2) db.setWorkItemFollowUp(item.id, item.version, false);
    }
    expect(db.listWorkItems({ needsFollowUp: true })).toMatchObject({ total: 23, records: expect.any(Array) });
    expect(db.listWorkItems({ needsFollowUp: true, page: 1 }).records).toHaveLength(3);
    expect(db.listWorkItems({ needsFollowUp: false }).total).toBe(22);
    expect(db.listWorkItems({ needsFollowUp: false, templateId: "one", ownerId: "owner-1", statuses: ["pending"], keyword: "结果 1" }).total).toBe(6);
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
  it("excludes void items by default and filters multiple statuses before pagination", () => {
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
    expect(db.listWorkItems({ statuses: ["completed", "void"], templateId: "two", keyword: "结果 2" }).total).toBe(1);
  });
  it("paginates/filter summaries, preserves full replies and deduplicates stable source IDs across reopen", () => {
    const { db, userData } = fixture();
    const first = db.insertWorkItem(source(0));
    for (let number = 1; number < 23; number++) db.insertWorkItem(source(number));
    expect(db.listWorkItems().records).toHaveLength(20);
    expect(db.listWorkItems({ page: 1 }).records).toHaveLength(3);
    expect(db.listWorkItems({ templateId: "one" }).total).toBe(11);
    expect(db.listWorkItems({ ownerId: "owner-0", keyword: "结果 2" }).total).toBe(3);
    expect(db.listWorkItems({ keyword: "%" }).total).toBe(0);
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
