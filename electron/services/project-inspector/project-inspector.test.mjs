import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createProjectInspectorService } = require("./index.cjs");
const { createFindingStore } = require("./finding-store.cjs");
const { verifyFinding } = require("./finding-verifier.cjs");
const { safePath, redact } = require("./project-profiler.cjs");
const { matches } = require("./role-manager.cjs");
const roots = [];
const services = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "巡检 project-")); roots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  git(["init"]); git(["config", "user.name", "Inspector Test"]); git(["config", "user.email", "inspector@example.invalid"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/main.js"), "const options = { nodeIntegration: true };\n");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=should-never-appear");
  git(["add", "."]); git(["commit", "-m", "fixture"]);
  return { root, repo, git };
}
async function setup(options = {}) {
  const fixtureData = fixture();
  const service = createProjectInspectorService({ userData: fixtureData.root, ...options }); services.push(service);
  const project = await service.addProject({ rootPath: fixtureData.repo });
  await service.profileProject(project.id);
  for (const role of service.listRoles(project.id)) service.updateRole({ id: role.id, confirmed: true });
  return { ...fixtureData, service, project };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("Project Inspector read-only domain", () => {
  it("reviews committed blobs, preserves dirty work and excludes secrets", async () => {
    const { service, project, repo, git } = await setup();
    fs.writeFileSync(path.join(repo, "src/main.js"), "USER DIRTY WORK\n");
    const before = git(["status", "--porcelain"]);
    const runs = await service.startInspection({ projectId: project.id, incremental: false });
    await service.waitForIdle();
    expect(runs.length).toBe(service.listRoles(project.id).length);
    const findings = service.listFindings({ projectId: project.id }).items;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "suspected", verification: "evidence_supported", location: { path: "src/main.js", startLine: 1 } });
    expect(findings[0].evidence.excerpt).toContain("nodeIntegration: true");
    expect(service.listInspectionRuns(project.id).every(run => run.dirty && run.scope === "committed-only")).toBe(true);
    expect(git(["status", "--porcelain"])).toBe(before);
    expect(fs.readFileSync(path.join(repo, "src/main.js"), "utf8")).toBe("USER DIRTY WORK\n");
    expect(JSON.stringify(service.listProjects())).not.toContain("should-never-appear");
  });
  it("retains ignored decisions across repeated scans, audits undo and rejects stale revisions", async () => {
    const { service, project } = await setup();
    await service.startInspection({ projectId: project.id, incremental: false }); await service.waitForIdle();
    const finding = service.listFindings({ projectId: project.id }).items[0];
    service.decideFinding(finding.id, finding.revision, "ignored", "accepted risk");
    expect(() => service.decideFinding(finding.id, finding.revision, "deferred")).toThrow("已更新");
    await service.startInspection({ projectId: project.id, incremental: false }); await service.waitForIdle();
    const latest = service.getFinding(finding.id);
    expect(latest.status).toBe("ignored"); expect(service.listFindings({ projectId: project.id }).total).toBe(1);
    service.decideFinding(latest.id, latest.revision, "awaiting_review");
    expect(service.store.list("approvals", project.id)).toHaveLength(2);
  });
  it("skips unchanged incremental runs and isolates concurrent duplicate triggers", async () => {
    let reviews = 0;
    const { service, project } = await setup({ reviewer: { review: async () => { reviews += 1; return { findings: [] }; } } });
    service.updateSettings(project.id, { engine: "codex", concurrency: 1 });
    const [first, second] = await Promise.all([service.startInspection({ projectId: project.id }), service.startInspection({ projectId: project.id })]);
    expect(first.map(run => run.id)).toEqual(second.map(run => run.id));
    await service.waitForIdle();
    const baselineReviews = reviews; expect(baselineReviews).toBeGreaterThan(0);
    await service.startInspection({ projectId: project.id }); await service.waitForIdle();
    expect(reviews).toBe(baselineReviews);
    expect(service.listInspectionRuns(project.id).filter(run => run.status === "skipped").length).toBeGreaterThan(0);
  });
  it("fails closed when the AI runner fails and persists failures", async () => {
    const { service, project } = await setup({ reviewer: { review: async () => { throw new Error("readOnly unavailable"); } } });
    service.updateSettings(project.id, { engine: "codex" });
    await service.startInspection({ projectId: project.id }); await service.waitForIdle();
    expect(service.listInspectionRuns(project.id).some(run => run.status === "failed")).toBe(true);
    expect(service.listFindings({ projectId: project.id }).total).toBe(0);
  });
  it("cancels queued and active work without creating findings", async () => {
    const reviewer = { review: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) };
    const { service, project } = await setup({ reviewer });
    service.updateSettings(project.id, { engine: "codex", concurrency: 1 });
    const runs = await service.startInspection({ projectId: project.id });
    for (const run of runs) service.cancelInspection(run.id);
    await service.waitForIdle();
    expect(service.listInspectionRuns(project.id).every(run => run.status === "cancelled")).toBe(true);
  });
  it("recovers interrupted work and keeps projects after reopening the database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-store-")); roots.push(root);
    const store = createFindingStore({ userData: root });
    store.put("projects", { id: "project", rootPath: "test" });
    store.put("runs", { id: "run", projectId: "project", status: "running" });
    store.close();
    const reopened = createFindingStore({ userData: root });
    expect(reopened.get("runs", "run").status).toBe("interrupted");
    expect(reopened.get("projects", "project").rootPath).toBe("test");
    expect(() => reopened.transaction(() => { reopened.put("projects", { id: "rollback" }); throw new Error("rollback"); })).toThrow();
    expect(reopened.get("projects", "rollback")).toBeNull(); reopened.close();
  });
  it("rejects false locations and does not trust a model's confirmed claim", () => {
    const context = { projectId: "p", roleId: "r", runId: "run", headCommit: "abc", sources: new Map([["src/a.js", "throw new Error('failure');"]]) };
    const candidate = { title: "failure", severity: "P2", type: "confirmed", ruleId: "test-rule", location: { path: "src/a.js", startLine: 1 }, anchor: "throw new Error", observations: ["code"], recommendation: "review", confidence: 0.9 };
    expect(verifyFinding(candidate, context).type).toBe("suspected");
    expect(() => verifyFinding({ ...candidate, location: { path: "src/a.js", startLine: 999 } }, context)).toThrow();
    expect(() => verifyFinding({ ...candidate, anchor: "imaginary function" }, context)).toThrow();
  });
  it("validates paths, settings and redacts tokens", async () => {
    const { service, project } = await setup();
    for (const file of ["../a", ".env", "src/.env.local", "keys/private.pem", "node_modules/a.js", "C:/a.js"]) expect(safePath(file)).toBe(false);
    expect(matches("electron/services/codex-app-server/a.cjs", "electron/services/*-app-server/**")).toBe(true);
    expect(redact("api_key='abcdefghijk' sk-abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijk");
    expect(() => service.updateSettings(project.id, { concurrency: 100 })).toThrow();
    expect(() => service.updateSettings(project.id, { engine: "codex" })).toThrow();
    await expect(service.addProject({ rootPath: "relative" })).rejects.toThrow();
  });
});

it("merges scopes without losing original role history or enabling an unconfirmed reviewer", async () => {
  const { service, project } = await setup();
  const roles = service.listRoles(project.id);
  const merged = service.mergeRoles({ ids: roles.map(role => role.id), name: "Combined review" });
  expect(merged).toMatchObject({ confirmed: false, lastCommit: null, failures: 0 });
  expect(new Set(merged.paths)).toEqual(new Set(roles.flatMap(role => role.paths)));
  expect(service.listRoles(project.id)).toHaveLength(1);
  for (const role of roles) {
    expect(service.store.get("roles", role.id)).toMatchObject({ mergedInto: merged.id, enabled: false });
    expect(() => service.updateRole({ id: role.id, enabled: true })).toThrow("已合并");
  }
  expect(() => service.mergeRoles({ ids: [merged.id, merged.id], name: "Invalid" })).toThrow("不同负责人");
});
it("rejects role merging while an affected inspection is queued", async () => {
  const { service, project } = await setup();
  const roles = service.listRoles(project.id);
  service.store.put("runs", { id: "queued-test", projectId: project.id, roleId: roles[0].id, status: "queued" });
  expect(() => service.mergeRoles({ ids: roles.map(role => role.id), name: "Combined review" })).toThrow("等待或取消");
  expect(service.listRoles(project.id)).toHaveLength(roles.length);
});

it("does not resurrect merged roles after an asynchronous Git preparation", async () => {
  const { service, project } = await setup();
  const profiler = require("./project-profiler.cjs");
  const resolved = await profiler.resolveProject(project.rootPath);
  let release;
  const spy = vi.spyOn(profiler, "resolveProject").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  try {
    const pending = service.startInspection({ projectId: project.id });
    const expectation = expect(pending).rejects.toThrow("停用或合并");
    service.mergeRoles({ ids: service.listRoles(project.id).map(role => role.id), name: "Combined review" });
    release(resolved);
    await expectation;
    expect(service.listInspectionRuns(project.id)).toHaveLength(0);
  } finally { spy.mockRestore(); }
});

it("runs a periodic full inspection once and advances each schedule instead of repeatedly catching up", async () => {
  let clock = 1000000, reviews = 0;
  const { service, project } = await setup({ now: () => clock, reviewer: { review: async () => { reviews++; return { findings: [], usage: { input_tokens: 10, output_tokens: 2 } }; } } });
  service.updateSettings(project.id, { engine: "codex", schedulerEnabled: true, missedRunPolicy: "catch-up", concurrency: 4 });
  for (const role of service.listRoles(project.id)) service.store.put("roles", { ...role, enabled: role.paths.includes("src/**"), intervalMinutes: 5, nextRunAt: clock - 1000000 });
  await service.tick(); await service.waitForIdle();
  const first = reviews; expect(first).toBeGreaterThan(0);
  expect(service.listInspectionRuns(project.id).every(run => run.trigger === "scheduled" && !run.incremental)).toBe(true);
  await service.tick(); await service.waitForIdle(); expect(reviews).toBe(first);
  expect(service.getUsage(project.id).inputTokens).toBe(first * 10);
  clock += 300001; await service.tick(); await service.waitForIdle(); expect(reviews).toBeGreaterThan(first);
});
it("skips expired schedule windows and honors persisted failure backoff", async () => {
  const clock = 1000000;
  const { service, project } = await setup({ now: () => clock });
  service.updateSettings(project.id, { schedulerEnabled: true, missedRunPolicy: "skip" });
  for (const role of service.listRoles(project.id)) service.store.put("roles", { ...role, intervalMinutes: 5, nextRunAt: clock - 300001 });
  await service.tick(); expect(service.listInspectionRuns(project.id)).toHaveLength(0);
  expect(service.listRoles(project.id).every(role => role.nextRunAt > clock)).toBe(true);
  service.updateSettings(project.id, { schedulerEnabled: false, gitEnabled: true });
  for (const role of service.listRoles(project.id)) service.store.put("roles", { ...role, failures: 1, nextRunAt: clock + 60000 });
  await service.tick(); expect(service.listInspectionRuns(project.id)).toHaveLength(0);
});
it("reports known over-budget usage without treating unknown failed usage as zero", async () => {
  const { service, project } = await setup();
  service.store.put("runs", { id: "known-failure", projectId: project.id, roleId: "r", engine: "codex", status: "failed", usage: { input_tokens: 123, output_tokens: 45, cached_input_tokens: 30 } });
  service.store.put("runs", { id: "unknown-failure", projectId: project.id, roleId: "r", engine: "codex", status: "failed" });
  expect(service.getUsage(project.id)).toMatchObject({ inputTokens: 123, outputTokens: 45, cachedInputTokens: 30, unknownRuns: 1 });
});
