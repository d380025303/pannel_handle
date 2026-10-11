import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createFindingStore } = require("./finding-store.cjs");
const { createApprovalService } = require("./approval-service.cjs");
const fixtures = [];
function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-approval-"));
  const store = createFindingStore({ userData: root }); fixtures.push({ root, store });
  store.put("projects", { id: "project", rootPath: root });
  store.put("findings", { id: "finding", projectId: "project", title: "review", revision: 1, status: "awaiting_review", headCommit: "abc", location: { path: "src/a.js", startLine: 1, endLine: 1 }, evidence: { observations: ["original evidence"], excerpt: "code" }, recommendation: "test", confidence: 0.6, type: "suspected", severity: "P1" });
  const calls = [];
  const adapter = {
    createPlanningSession: vi.fn(async () => { calls.push("create"); return { id: "new-session" }; }),
    setExecutionPermission: vi.fn(async () => calls.push("permission")), setMode: vi.fn(async () => calls.push("mode")),
    snapshot: vi.fn(async () => ({ threadId: "thread", mode: "plan", executionPermission: "readOnly", inspectorSafety: "enforced" })),
    submit: vi.fn(async () => calls.push("submit")), close: vi.fn(async () => {})
  };
  Object.assign(adapter, overrides);
  const inspectProject = vi.fn(async () => ({ rootPath: root, headCommit: "abc", dirty: false }));
  const service = createApprovalService({ store, adapter, inspectProject });
  return { store, adapter, service, calls, inspectProject };
}
afterEach(() => { for (const { store, root } of fixtures.splice(0)) { store.close(); fs.rmSync(root, { recursive: true, force: true }); } });
it("deduplicates concurrent approvals and applies both restrictions before first submission", async () => {
  const { service, store, adapter, calls } = setup();
  const input = { findingId: "finding", expectedRevision: 1 };
  const [a, b] = await Promise.all([service.approvePlanning(input), service.approvePlanning(input)]);
  expect(a.id).toBe(b.id); expect(calls).toEqual(["create", "permission", "mode", "submit"]);
  expect(adapter.submit.mock.calls[0][1]).toContain("original evidence");
  expect(store.get("findings", "finding")).toMatchObject({ status: "planning", revision: 2 });
  expect((await service.approvePlanning(input)).id).toBe(a.id);
  expect(adapter.createPlanningSession).toHaveBeenCalledTimes(1);
});
it("fails closed when readOnly cannot be applied", async () => {
  const { service, adapter, store } = setup({ setExecutionPermission: vi.fn(async () => { throw new Error("unsupported"); }) });
  await expect(service.approvePlanning({ findingId: "finding", expectedRevision: 1 })).rejects.toThrow("unsupported");
  expect(adapter.submit).not.toHaveBeenCalled(); expect(adapter.close).toHaveBeenCalledWith("new-session");
  expect(store.get("findings", "finding").status).toBe("awaiting_review");
  expect(store.list("sessions")[0].status).toBe("failed");
});
it("requires enforcement proof beyond a Plan mode snapshot", async () => {
  const { service, adapter } = setup({ snapshot: vi.fn(async () => ({ threadId: "t", mode: "plan", executionPermission: "readOnly" })) });
  await expect(service.approvePlanning({ findingId: "finding", expectedRevision: 1 })).rejects.toThrow("工具隔离");
  expect(adapter.submit).not.toHaveBeenCalled();
});
it("rejects stale revisions and commit changes before creating a session", async () => {
  const { service, adapter, inspectProject } = setup();
  await expect(service.approvePlanning({ findingId: "finding", expectedRevision: 3 })).rejects.toThrow("已更新");
  inspectProject.mockResolvedValue({ rootPath: "changed", headCommit: "new", dirty: false });
  await expect(service.approvePlanning({ findingId: "finding", expectedRevision: 1 })).rejects.toThrow("版本已变化");
  expect(adapter.createPlanningSession).not.toHaveBeenCalled();
});
it("destroys a new session if prompt submission fails, without approving implementation", async () => {
  const { service, adapter, store } = setup({ submit: vi.fn(async () => { throw new Error("disconnected"); }) });
  await expect(service.approvePlanning({ findingId: "finding", expectedRevision: 1 })).rejects.toThrow("disconnected");
  expect(adapter.close).toHaveBeenCalledWith("new-session");
  expect(store.list("approvals").every(value => value.stage === "planning" && value.decision === "failed")).toBe(true);
});
