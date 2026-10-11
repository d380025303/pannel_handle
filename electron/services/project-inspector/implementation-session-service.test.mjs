import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createFindingStore } = require("./finding-store.cjs");
const { createImplementationSessionService } = require("./implementation-session-service.cjs");
const fixtures = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-implementation-"));
  const store = createFindingStore({ userData: root });

it("can review and merge a sealed worktree after its writer was closed", async () => {
  const f = await readyForVerification();
  await f.service.verifyImplementation({ findingId: "f", expectedRevision: f.store.get("findings", "f").revision, digest: "d".repeat(64) });
  f.router.snapshot.mockImplementation(() => { throw new Error("图形会话不存在。"); });
  const review = await f.service.reviewImplementation("f");
  const result = await f.service.approveMerge({ findingId: "f", expectedRevision: f.store.get("findings", "f").revision, digest: review.review.digest });
  expect(result.status).toBe("merged");
});
  const commit = "a".repeat(40);
  const finding = { id: "f", projectId: "p", title: "Issue", status: "awaiting_implementation", revision: 4, headCommit: commit, location: { path: "source.js" }, ruleId: "electron-node-integration", detectionEngine: "static", evidence: { excerpt: "source evidence" } };
  store.put("projects", { id: "p", rootPath: "C:/project" }); store.put("findings", finding);
  const workspace = { id: "work", cwd: "C:/data/inspector-worktrees/work", branch: "inspector/work", baseCommit: commit };
  const workspaces = { commit: vi.fn(async () => ({ headCommit: "b".repeat(40), dirty: false })), merge: vi.fn(async () => ({ headCommit: "b".repeat(40), mergedAt: 1 })), create: vi.fn(async () => workspace), assertWorkspace: vi.fn(async () => workspace.cwd), review: vi.fn(async () => ({ headCommit: commit, dirty: true, diff: "patch", digest: "d".repeat(64), files: ["source.js"] })) };
  const planning = { getPlan: vi.fn(() => ({ id: "plan", status: "completed", planOutput: "Approved complete plan", approvedHeadCommit: commit })) };
  const launcher = { launchSession: vi.fn(async () => ({ id: "restored" })), createSession: vi.fn(async () => ({ id: "implementation", templateId: "owned" })) };
  const router = { snapshot: vi.fn(() => ({ threadId: "thread", inspectorStage: "implementation", inspectorSafety: "enforced", mode: "default", executionPermission: "askApproval" })), submit: vi.fn(async () => {}), close: vi.fn() };
  const terminalManager = { closeSession: vi.fn(), getSession: vi.fn(() => null), listSessions: vi.fn(() => []) };
  const sessionStore = { getTemplate: vi.fn(() => ({ inspectorStage: "implementation", inspectorWorkspaceId: "work", inspectorThreadId: "thread", inspectorLinkId: store.list("sessions")[0]?.id })) };
  const inspectProject = vi.fn(async () => ({ rootPath: "C:/project", headCommit: commit, dirty: true }));
  const testRunner = vi.fn(async () => ({ passed: true, results: [{ script: "test", exitCode: 0, passed: true, output: "Actual test output" }] }));
  const inspector = { startInspection: vi.fn(async () => [{ id: "reinspection" }]) };
  const service = createImplementationSessionService({ userData: root, store, planning, launcher, router, terminalManager, sessionStore, workspaces, inspectProject, testRunner, inspector });
  fixtures.push({ root, store, service });
  return { store, service, planning, launcher, router, workspaces, inspectProject, sessionStore, terminalManager, testRunner, inspector };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service.close(); f.store.close(); fs.rmSync(f.root, { recursive: true, force: true }); } });
const input = { findingId: "f", expectedRevision: 4, planId: "plan" };
it("requires a completed specifically reviewed Plan and a separate current-revision approval", async () => {
  const f = fixture();
  await expect(f.service.approveImplementation({ ...input, planId: "other" })).rejects.toThrow("审阅");
  await expect(f.service.approveImplementation({ ...input, expectedRevision: 3 })).rejects.toThrow("状态已变化");
  expect(f.workspaces.create).not.toHaveBeenCalled(); expect(f.router.submit).not.toHaveBeenCalled();
});
it("deduplicates implementation approval and sends full evidence only to the verified worktree session", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.approveImplementation(input), f.service.approveImplementation(input)]);
  expect(a.id).toBe(b.id); expect(f.workspaces.create).toHaveBeenCalledTimes(1);
  expect(f.launcher.createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "C:/data/inspector-worktrees/work", inspectorStage: "implementation", inspectorWorkspaceId: "work" }));
  expect(f.router.submit.mock.calls[0][1]).toContain("Approved complete plan");
  expect(f.router.submit.mock.calls[0][1]).toContain("source evidence");
  expect(f.store.get("findings", "f")).toMatchObject({ status: "implementing", revision: 5 });
  expect(f.store.list("approvals")[0]).toMatchObject({ stage: "implementation", decision: "approved" });
});
it("fails closed before submission and preserves the worktree when sandbox verification fails", async () => {
  const f = fixture(); f.router.snapshot.mockReturnValue({ threadId: "thread", inspectorSafety: null });
  await expect(f.service.approveImplementation(input)).rejects.toThrow("写入边界");
  expect(f.router.submit).not.toHaveBeenCalled(); expect(f.router.close).toHaveBeenCalledWith("implementation");
  expect(f.service.getImplementation("f")).toMatchObject({ status: "failed", workspace: { id: "work" } });
  await expect(f.service.approveImplementation(input)).rejects.toThrow("已有实施工作树");
});
it("rejects a moved Git baseline before creating any worktree", async () => {
  const f = fixture(); f.inspectProject.mockResolvedValue({ rootPath: "C:/project", headCommit: "b".repeat(40) });
  await expect(f.service.approveImplementation(input)).rejects.toThrow("基线已变化");
  expect(f.workspaces.create).not.toHaveBeenCalled();
});
it("does not review a changing worktree while its agent is running", async () => {
  const f = fixture(); await f.service.approveImplementation(input);
  f.terminalManager.getSession.mockReturnValue({ id: "implementation" });
  f.router.snapshot.mockReturnValue({ busy: true });
  await expect(f.service.reviewImplementation("f")).rejects.toThrow("仍在执行");
  expect(f.workspaces.review).not.toHaveBeenCalled();
  f.router.snapshot.mockReturnValue({ busy: false });
  expect((await f.service.reviewImplementation("f")).review.diff).toBe("patch");
});

it("restores the original protected implementation thread without resubmitting the task", async () => {
  const f = fixture(); await f.service.approveImplementation(input);
  const [a, b] = await Promise.all([f.service.openImplementation("f"), f.service.openImplementation("f")]);
  expect(a.sessionId).toBe("restored"); expect(b.sessionId).toBe(a.sessionId);
  expect(f.launcher.launchSession).toHaveBeenCalledTimes(1);
  expect(f.router.submit).toHaveBeenCalledTimes(1);
  expect(f.store.get("findings", "f").implementationSessionId).toBe("restored");
});
it("rejects an unrelated implementation template", async () => {
  const f = fixture(); await f.service.approveImplementation(input);
  f.sessionStore.getTemplate.mockReturnValue({ inspectorStage: "implementation", inspectorLinkId: "unrelated", inspectorWorkspaceId: "work", inspectorThreadId: "thread" });
  await expect(f.service.openImplementation("f")).rejects.toThrow("关联模板不可用");
  expect(f.launcher.launchSession).not.toHaveBeenCalled();
});

it("persists completed implementation output and advances to diff review without resolving the finding", async () => {
  const f = fixture(); await f.service.approveImplementation(input);
  f.terminalManager.getSession.mockReturnValue({ id: "implementation" });
  f.router.snapshot.mockReturnValue({ busy: false, turnStatus: "completed", inspectorStage: "implementation", inspectorSafety: "enforced", items: [{ type: "agentMessage", text: "Changes complete. Tests still need independent verification." }] });
  f.service.sync();
  expect(f.store.get("findings", "f")).toMatchObject({ status: "awaiting_diff_review", revision: 6 });
  expect(f.service.getImplementation("f")).toMatchObject({ status: "completed", implementationOutput: expect.stringContaining("independent verification") });
});

async function readyForVerification() {
  const f = fixture(); await f.service.approveImplementation(input);
  await f.service.reviewImplementation("f");
  f.workspaces.review.mockResolvedValue({ headCommit: "b".repeat(40), dirty: false, diff: "Reviewed patch", digest: "e".repeat(64), files: ["source.js"] });
  return f;
}
it("seals the tested commit and requires a separate approval before merging", async () => {
  const f = await readyForVerification();
  const verified = await f.service.verifyImplementation({ findingId: "f", expectedRevision: 5, digest: "d".repeat(64) });
  expect(verified).toMatchObject({ sealed: true, verification: { passed: true, headCommit: "b".repeat(40) } });
  expect(f.workspaces.merge).not.toHaveBeenCalled();
  await expect(f.service.openImplementation("f")).rejects.toThrow("封存");
  await expect(f.service.assertSessionAllowed({ inspectorLinkId: verified.id, inspectorWorkspaceId: "work", inspectorFindingId: "f", cwd: "C:/data/inspector-worktrees/work" })).rejects.toThrow("封存");
  const result = await f.service.approveMerge({ findingId: "f", expectedRevision: 6, digest: "e".repeat(64) });
  expect(result).toMatchObject({ status: "merged", reinspectionRunIds: ["reinspection"] });
  expect(f.workspaces.merge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: "merge", decision: "approved", testsPassed: true, expectedHeadCommit: "b".repeat(40) }));
  expect(f.store.get("findings", "f").status).toBe("awaiting_reinspection");
});
it("blocks failed tests and allows reopening the implementation for corrections", async () => {
  const f = await readyForVerification(); f.testRunner.mockResolvedValue({ passed: false, results: [{ script: "test", exitCode: 1, passed: false }] });
  const result = await f.service.verifyImplementation({ findingId: "f", expectedRevision: 5, digest: "d".repeat(64) });
  expect(result.sealed).toBe(false);
  expect(f.store.get("findings", "f").status).toBe("verification_failed");
  await expect(f.service.approveMerge({ findingId: "f", expectedRevision: 6, digest: "e".repeat(64) })).rejects.toThrow("主进程测试结果");
  expect(f.workspaces.merge).not.toHaveBeenCalled();
});
it("rejects outdated reviews and invalidates passing tests if the worktree changes", async () => {
  const f = await readyForVerification();
  await expect(f.service.verifyImplementation({ findingId: "f", expectedRevision: 5, digest: "0".repeat(64) })).rejects.toThrow("最新差异");
  expect(f.testRunner).not.toHaveBeenCalled();
  f.workspaces.review.mockResolvedValue({ headCommit: "b".repeat(40), dirty: true, diff: "changed", digest: "e".repeat(64) });
  const result = await f.service.verifyImplementation({ findingId: "f", expectedRevision: 5, digest: "d".repeat(64) });
  expect(result.verification.passed).toBe(false);
});

async function mergedForReinspection() {
  const f = await readyForVerification();
  await f.service.verifyImplementation({ findingId: "f", expectedRevision: 5, digest: "d".repeat(64) });
  await f.service.approveMerge({ findingId: "f", expectedRevision: 6, digest: "e".repeat(64) });
  return f;
}
it("resolves only a fully covered known static rule at the merged commit, with a source-only qualification", async () => {
  const f = await mergedForReinspection();
  f.store.put("runs", { id: "reinspection", projectId: "p", status: "completed", headCommit: "b".repeat(40), engine: "static", incremental: false, reviewedPaths: ["source.js"], stats: { truncated: false, rejected: 0 } });
  f.service.sync();
  expect(f.store.get("findings", "f")).toMatchObject({ status: "resolved", repairVerification: { status: "source_resolved" } });
  expect(f.service.getImplementation("f").reinspection.summary).toContain("不等于运行时");
});
it("reports reinspection risk when budget truncation leaves incomplete coverage", async () => {
  const f = await mergedForReinspection();
  f.store.put("runs", { id: "reinspection", projectId: "p", status: "completed", headCommit: "b".repeat(40), engine: "static", incremental: false, reviewedPaths: ["source.js"], stats: { truncated: true, rejected: 0 } });
  f.service.sync();
  expect(f.store.get("findings", "f").status).toBe("reinspection_risk");
});
it("does not interpret AI silence as proof of repair", async () => {
  const f = await mergedForReinspection();
  const link = f.service.getImplementation("f");
  f.store.put("sessions", { ...link, rootFinding: { ...link.rootFinding, detectionEngine: "codex" } });
  f.store.put("runs", { id: "reinspection", projectId: "p", status: "completed", headCommit: "b".repeat(40), engine: "codex", incremental: false, reviewedPaths: ["source.js"], stats: { truncated: false, rejected: 0 } });
  f.service.sync();
  expect(f.store.get("findings", "f").status).toBe("reinspection_risk");
});
it("keeps a still-detected rule open even when all files were reviewed", async () => {
  const f = await mergedForReinspection();
  f.store.put("runs", { id: "reinspection", projectId: "p", status: "completed", headCommit: "b".repeat(40), engine: "static", incremental: false, reviewedPaths: ["source.js"], stats: { truncated: false, rejected: 0 } });
  f.store.put("findings", { ...f.store.get("findings", "f"), runId: "reinspection" });
  f.service.sync();
  expect(f.store.get("findings", "f").status).toBe("reinspection_risk");
  expect(f.service.getImplementation("f").reinspection.summary).toContain("仍检出");
});
