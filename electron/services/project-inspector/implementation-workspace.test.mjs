import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
// Real Git worktree operations compete with the full suite on Windows.
vi.setConfig({ testTimeout: 30_000 });
const require = createRequire(import.meta.url);
const { createImplementationWorkspaceManager } = require("./implementation-workspace.cjs");
const fixtures = [];
const git = (cwd, args) => execFileSync("git", ["-c", "core.hooksPath=", ...args], { cwd, encoding: "utf8", windowsHide: true });
it("disables checkout filters without modifying the user's Git configuration", async () => {
  const { repo, manager } = fixture();
  fs.writeFileSync(path.join(repo, ".gitattributes"), "source.js filter=untrusted\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "attributes"]);
  git(repo, ["config", "filter.untrusted.smudge", "echo FILTER_EXECUTED"]);
  git(repo, ["config", "filter.untrusted.clean", "echo FILTER_EXECUTED"]);
  git(repo, ["config", "filter.untrusted.required", "true"]);
  const base = git(repo, ["rev-parse", "HEAD"]).trim();
  const workspace = await manager.create(repo, base);
  expect(workspace.sourceDirtyAtApproval).toBe(false);
  expect(fs.readFileSync(path.join(workspace.cwd, "source.js"), "utf8")).toContain("value = 1");
  expect(git(repo, ["config", "--get", "filter.untrusted.smudge"]).trim()).toBe("echo FILTER_EXECUTED");
});
it("blocks a merge while the source repository has an unfinished Git operation", async () => {
  const { repo, base, manager } = fixture();
  const workspace = await manager.create(repo, base);
  fs.writeFileSync(path.join(workspace.cwd, "source.js"), "export const value = 2;\n");
  git(workspace.cwd, ["add", "."]); git(workspace.cwd, ["commit", "-m", "implementation"]);
  const review = await manager.review(workspace);
  const marker = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]).trim();
  fs.writeFileSync(marker, `${review.headCommit}\n`);
  await expect(manager.merge(workspace, { decision: "approved", stage: "merge", workspaceId: workspace.id, testsPassed: true, expectedHeadCommit: review.headCommit })).rejects.toThrow("未完成的 Git 操作");
  expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(base);
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "巡检-implementation "));
  fixtures.push(root);
  const repo = path.join(root, "source"); fs.mkdirSync(repo);
  git(repo, ["init"]); git(repo, ["config", "user.name", "Inspector"]); git(repo, ["config", "user.email", "inspector@example.invalid"]);
  fs.writeFileSync(path.join(repo, "source.js"), "export const value = 1;\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "baseline"]);
  const base = git(repo, ["rev-parse", "HEAD"]).trim();
  const manager = createImplementationWorkspaceManager({ userData: path.join(root, "data") });
  return { root, repo, base, manager };
}
afterEach(() => { for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it("starts from the approved commit while preserving dirty source files", async () => {
  const { repo, base, manager } = fixture();
  fs.writeFileSync(path.join(repo, "source.js"), "USER UNSAVED CODE\n");
  const workspace = await manager.create(repo, base);
  expect(workspace.sourceDirtyAtApproval).toBe(true);
  expect(fs.readFileSync(path.join(workspace.cwd, "source.js"), "utf8")).toContain("value = 1");
  fs.writeFileSync(path.join(workspace.cwd, "source.js"), "export const value = 2;\n");
  expect(fs.readFileSync(path.join(repo, "source.js"), "utf8")).toBe("USER UNSAVED CODE\n");
  const review = await manager.review(workspace);
  expect(review.files).toEqual(["source.js"]); expect(review.diff).toContain("value = 2");
  await expect(manager.remove(workspace)).rejects.toThrow("未提交");
});
it("requires separate merge approval and blocks dirty source trees", async () => {
  const { repo, base, manager } = fixture();
  const workspace = await manager.create(repo, base);
  fs.writeFileSync(path.join(workspace.cwd, "source.js"), "export const value = 2;\n");
  git(workspace.cwd, ["add", "."]); git(workspace.cwd, ["commit", "-m", "implementation"]);
  const review = await manager.review(workspace);
  const approval = { decision: "approved", stage: "merge", workspaceId: workspace.id, testsPassed: true, expectedHeadCommit: review.headCommit };
  await expect(manager.merge(workspace, { ...approval, stage: "planning" })).rejects.toThrow("单独批准");
  await expect(manager.merge(workspace, { ...approval, testsPassed: false })).rejects.toThrow("测试结果");
  fs.writeFileSync(path.join(repo, "source.js"), "dirty\n");
  await expect(manager.merge(workspace, approval)).rejects.toThrow("原工作区有未提交");
  expect(fs.readFileSync(path.join(repo, "source.js"), "utf8")).toBe("dirty\n");
  fs.writeFileSync(path.join(repo, "source.js"), "export const value = 1;\n");
  const result = await manager.merge(workspace, approval);
  expect(result).toMatchObject({ headCommit: review.headCommit, requiresReinspection: true });
  expect(fs.readFileSync(path.join(repo, "source.js"), "utf8")).toContain("value = 2");
});
it("rejects stale approved heads and changes to the original baseline", async () => {
  const { repo, base, manager } = fixture();
  const workspace = await manager.create(repo, base);
  fs.writeFileSync(path.join(workspace.cwd, "source.js"), "export const value = 2;\n");
  git(workspace.cwd, ["add", "."]); git(workspace.cwd, ["commit", "-m", "implementation"]);
  const review = await manager.review(workspace);
  await expect(manager.merge(workspace, { decision: "approved", stage: "merge", workspaceId: workspace.id, testsPassed: true, expectedHeadCommit: base })).rejects.toThrow("审核后已变化");
  fs.writeFileSync(path.join(repo, "other.js"), "export const other = 1;\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "source change"]);
  await expect(manager.merge(workspace, { decision: "approved", stage: "merge", workspaceId: workspace.id, testsPassed: true, expectedHeadCommit: review.headCommit })).rejects.toThrow("基线已变化");
  await expect(manager.create(repo, base)).rejects.toThrow("版本已变化");
});
it("rejects directories and branches outside the managed workspace", async () => {
  const { repo, base, manager } = fixture();
  const workspace = await manager.create(repo, base);
  await expect(manager.review({ ...workspace, cwd: repo })).rejects.toThrow("边界");
  await expect(manager.review({ ...workspace, branch: "master" })).rejects.toThrow("记录无效");
  const removed = await manager.remove(workspace);
  expect(removed.branch).toBe(workspace.branch);
  expect(git(repo, ["rev-parse", workspace.branch]).trim()).toBe(base);
});

it("includes newly created file content in the review digest and commits only the reviewed state", async () => {
  const { repo, base, manager } = fixture();
  const workspace = await manager.create(repo, base);
  fs.writeFileSync(path.join(workspace.cwd, "new.js"), "export const result = 1;\n");
  const review = await manager.review(workspace);
  expect(review.diff).toContain("+++ new.js"); expect(review.diff).toContain("+export const result = 1;");
  fs.writeFileSync(path.join(workspace.cwd, "new.js"), "export const result = 2;\n");
  await expect(manager.commit(workspace, review.digest)).rejects.toThrow("审核后已变化");
  const fresh = await manager.review(workspace);
  const committed = await manager.commit(workspace, fresh.digest);
  expect(committed.dirty).toBe(false); expect(committed.headCommit).not.toBe(base);
  expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(base);
  expect(fs.existsSync(path.join(repo, "new.js"))).toBe(false);
});
it("refuses to automatically commit sensitive changed files", async () => {
  const { repo, base, manager } = fixture(); const workspace = await manager.create(repo, base);
  fs.writeFileSync(path.join(workspace.cwd, ".env"), "password=supersecretvalue");
  await expect(manager.review(workspace)).rejects.toThrow("敏感");
  expect(git(workspace.cwd, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

it("rejects a source branch switch even when its commit is unchanged", async () => {
  const { repo, base, manager } = fixture(); const workspace = await manager.create(repo, base);
  fs.writeFileSync(path.join(workspace.cwd, "source.js"), "export const value = 2;\n");
  const review = await manager.review(workspace); const committed = await manager.commit(workspace, review.digest);
  git(repo, ["checkout", "-b", "other-target"]);
  await expect(manager.merge(workspace, { stage: "merge", decision: "approved", workspaceId: workspace.id, expectedHeadCommit: committed.headCommit, testsPassed: true })).rejects.toThrow("分支已切换");
  expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(base);
});
