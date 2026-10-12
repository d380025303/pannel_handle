import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createBusinessDataStore } = require("../../stores/business-data-store.cjs");
const { createModuleOwnerStore } = require("./module-owner-store.cjs");
const { createPromptTemplateService } = require("./prompt-template-service.cjs");
const { createModuleOwnerScheduler } = require("./module-owner-scheduler.cjs");
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); rmSync(f.userData, { recursive: true, force: true }); } });
function fixture() {
  const userData = mkdtempSync(path.join(tmpdir(), "prompt-templates-"));
  const db = createBusinessDataStore({ userData }); db.open();
  const store = createModuleOwnerStore({ userData, dataStore: db });
  const listTemplates = () => [{ templateId: "one", title: "项目一" }, { templateId: "two", title: "项目二" }];
  const api = createPromptTemplateService({ store, listTemplates });
  const scheduler = createModuleOwnerScheduler({ store, template: id => ({ id }), supported: () => true, now: () => 1000, job: () => null, revokeTask: () => {} });
  for (const id of ["one", "two"]) store.mutate(id, { operation: "add", name: id, responsibilities: "模块", directories: ["src"] }, { cwd: "C:/repo" });
  const f = { userData, db, store, api, scheduler }; fixtures.push(f); return f;
}
function task(f, id, source, prompt = source.prompt) {
  return f.scheduler.save(id, { ownerId: f.store.get(id).records[0].id, name: "巡检", prompt, promptTemplateId: source.id, mode: "default", enabled: true, tools: [], schedule: { kind: "interval", minutes: 30, count: 10 } })[0];
}
it("persists globally, selects publication across projects and preserves scheduling", () => {
  const f = fixture(); const source = f.api.savePromptTemplate({ name: "共享", prompt: "原文" })[0];
  const first = task(f, "one", source); const second = task(f, "two", source, "独立修改");
  const updated = f.api.savePromptTemplate({ id: source.id, version: 1, name: "共享", prompt: "新文" })[0];
  expect(f.store.get("one").tasks[0].prompt).toBe("原文");
  const preview = f.api.previewPromptPublish({ id: source.id, version: 2 });
  expect(preview.tasks.map(value => value.modified)).toEqual([false, true]);
  expect(f.api.publishPromptTemplate({ id: source.id, version: 2, targets: [preview.tasks[0]].map(({ templateId, taskId, fingerprint }) => ({ templateId, taskId, fingerprint })) })).toEqual({ updatedCount: 1 });
  expect(f.store.get("one").tasks[0]).toEqual({ ...first, prompt: "新文", promptTemplateVersion: 2, promptTemplateSnapshot: "新文" });
  expect(f.store.get("two").tasks[0]).toEqual(second);
  const reloaded = createModuleOwnerStore({ userData: f.userData, dataStore: f.db });
  const { referenceCount, ...persisted } = updated;
  expect(reloaded.promptTemplates()[0]).toEqual(persisted);
  expect(reloaded.get("one").tasks[0].prompt).toBe("新文");
  expect(() => f.api.deletePromptTemplate({ id: source.id, version: 2 })).toThrow("解除引用");
});
it("rejects stale previews and rolls back all selected updates on storage failure", () => {
  const f = fixture(); const source = f.api.savePromptTemplate({ name: "共享", prompt: "原文" })[0];
  task(f, "one", source); task(f, "two", source);
  f.api.savePromptTemplate({ id: source.id, version: 1, name: "共享", prompt: "新文" });
  const preview = f.api.previewPromptPublish({ id: source.id, version: 2 });
  const input = { id: source.id, version: 2, targets: preview.tasks.map(({ templateId, taskId, fingerprint }) => ({ templateId, taskId, fingerprint })) };
  const before = f.store.get("one");
  const fail = vi.spyOn(f.db, "write").mockImplementationOnce(() => { throw new Error("disk failure"); });
  expect(() => f.api.publishPromptTemplate(input)).toThrow("disk failure"); fail.mockRestore();
  expect(f.store.get("one")).toEqual(before); expect(f.store.get("two").tasks[0].prompt).toBe("原文");
  f.store.tasks("two", f.store.get("two").tasks.map(value => ({ ...value, prompt: "刚修改" })));
  expect(() => f.api.publishPromptTemplate(input)).toThrow("重新预览");
  expect(f.store.get("one")).toEqual(before);
  expect(() => f.api.savePromptTemplate({ id: source.id, version: 1, name: "过期", prompt: "错误" })).toThrow("已变更");
});
it("copies references and detaches without changing prompt", () => {
  const f = fixture(); const source = f.api.savePromptTemplate({ name: "共享", prompt: "原文" })[0];
  const original = task(f, "one", source, "定制");
  const other = f.store.mutate("one", { operation: "add", name: "其他", responsibilities: "模块", directories: ["electron"] }, { cwd: "C:/repo" }).records[1];
  const copied = f.scheduler.copy("one", { taskId: original.id, targetOwnerIds: [other.id] })[1];
  expect(copied).toMatchObject({ prompt: "定制", promptTemplateId: source.id, promptTemplateSnapshot: "原文", enabled: false });
  const { promptTemplateId, promptTemplateVersion, promptTemplateSnapshot, executedCount, nextRunAt, lastRun, ...input } = original;
  f.scheduler.save("one", input);
  expect(f.store.get("one").tasks[0]).not.toHaveProperty("promptTemplateId");
  expect(f.store.get("one").tasks[0].prompt).toBe("定制");
});
