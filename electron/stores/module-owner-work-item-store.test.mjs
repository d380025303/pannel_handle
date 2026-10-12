import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
