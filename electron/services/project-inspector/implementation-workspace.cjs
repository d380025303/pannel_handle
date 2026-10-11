const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { git, resolveProject, safePath, redact } = require("./project-profiler.cjs");

const SHA = /^[a-f0-9]{40,64}$/;
const BRANCH = /^inspector\/[a-f0-9-]{36}$/;

function createImplementationWorkspaceManager({ userData }) {
  const workspaceRoot = path.resolve(userData, "inspector-worktrees");
  const locks = new Map();
  async function checkoutSafetyArgs(root) {
    let filters = "";
    try {
      filters = await git(root, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    // Disable filters only for this command, without changing user Git config.
    // LFS content therefore remains a pointer until separately reviewed/fetched.
    const keys = [...new Set(filters.split(/\r?\n/).filter(Boolean))];
    if (keys.some(key => !/^filter\.[^=\x00-\x1f]+\.(clean|smudge|process|required)$/.test(key))) throw new Error("Git checkout 过滤器配置无法安全解析。");
    return keys.flatMap(key => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
  }
  async function serialize(root, operation) {
    const key = path.resolve(root).toLowerCase();
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    locks.set(key, next);
    try { return await next; }
    finally { if (locks.get(key) === next) locks.delete(key); }
  }
  async function assertWorkspace(workspace) {
    if (!workspace || !SHA.test(workspace.baseCommit) || !BRANCH.test(workspace.branch)) throw new Error("实施工作树记录无效。");
    const expected = path.join(workspaceRoot, workspace.branch.slice("inspector/".length));
    if (path.resolve(workspace.cwd).toLowerCase() !== expected.toLowerCase()) throw new Error("实施目录超出受控工作树边界。");
    const actual = await fs.realpath(workspace.cwd);
    const canonicalRoot = await fs.realpath(workspaceRoot);
    if (path.dirname(actual).toLowerCase() !== canonicalRoot.toLowerCase()) throw new Error("实施目录已被重定向。");
    const sourceGit = await git(workspace.projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const worktreeGit = await git(actual, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (sourceGit.trim().toLowerCase() !== worktreeGit.trim().toLowerCase()) throw new Error("实施工作树已不属于原项目。");
    const branch = (await git(actual, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    if (branch !== workspace.branch) throw new Error("实施工作树分支已变化，不能继续自动处理。");
    return actual;
  }
  async function create(projectRoot, expectedCommit) {
    if (!SHA.test(expectedCommit)) throw new Error("实施基线 commit 无效。");
    return serialize(projectRoot, async () => {
      const project = await resolveProject(projectRoot);
      if (project.headCommit !== expectedCommit) throw new Error("项目版本已变化，请重新规划后审批实施。");
      let sourceRef = null;
      try { sourceRef = (await git(project.rootPath, ["symbolic-ref", "--quiet", "HEAD"])).trim(); }
      catch (error) { if (error.code !== 1) throw error; }
      const safetyArgs = await checkoutSafetyArgs(project.rootPath);
      await fs.mkdir(workspaceRoot, { recursive: true });
      const id = randomUUID();
      const cwd = path.join(workspaceRoot, id);
      const branch = `inspector/${id}`;
      // Dirty source files are deliberately not copied into this worktree.
      await git(project.rootPath, [...safetyArgs, "worktree", "add", "-b", branch, cwd, expectedCommit]);
      const workspace = { id, cwd, branch, projectRoot: project.rootPath, sourceRef, baseCommit: expectedCommit, createdAt: Date.now(), sourceDirtyAtApproval: project.dirty };
      try { await assertWorkspace(workspace); return workspace; }
      catch (error) {
        // Preserve any ambiguous worktree for manual recovery; never force-delete it.
        throw Object.assign(error, { workspace });
      }
    });
  }
  async function review(workspace) {
    const cwd = await assertWorkspace(workspace);
    const headCommit = (await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!SHA.test(headCommit)) throw new Error("实施工作树 commit 无效。");
    await git(cwd, ["merge-base", "--is-ancestor", workspace.baseCommit, headCommit]);
    const status = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
    let diff = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", workspace.baseCommit, "--"], { maxBuffer: 4 * 1024 * 1024 });
    const tracked = (await git(cwd, ["diff", "--name-only", "-z", workspace.baseCommit, "--"])).split("\0").filter(Boolean);
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const file of untracked) {
      if (!safePath(file)) throw new Error("实施工作树包含敏感或不支持的新增文件，请先人工处理。");
      const target = path.join(cwd, file);
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("新增文件过大或不是普通文件，不能自动审查。");
      const bytes = await fs.readFile(target);
      diff += `\n--- /dev/null\n+++ ${file}\n${bytes.includes(0) ? `[binary sha256:${createHash("sha256").update(bytes).digest("hex")}]` : bytes.toString("utf8").split("\n").map(line => `+${line}`).join("\n")}\n`;
      if (Buffer.byteLength(diff) > 4 * 1024 * 1024) throw new Error("实施差异超过审核上限，请缩小变更范围。");
    }
    const digest = createHash("sha256").update(JSON.stringify([headCommit, status, diff])).digest("hex");
    return { headCommit, dirty: Boolean(status.trim()), status, diff: redact(diff), digest, files: [...new Set([...tracked, ...untracked])], reviewedAt: Date.now() };
  }
  async function commit(workspace, expectedDigest) {
    return serialize(workspace.projectRoot, async () => {
      const result = await review(workspace);
      if (result.digest !== expectedDigest) throw new Error("差异在审核后已变化，请重新审查。");
      if (result.files.some(file => !safePath(file))) throw new Error("实施涉及敏感或生成文件，不能自动提交。");
      if (!result.dirty) return result;
      await git(workspace.cwd, ["add", "--all", "--"]);
      await git(workspace.cwd, ["-c", "commit.gpgSign=false", "commit", "-m", "项目巡检：隔离实施修改"]);
      return review(workspace);
    });
  }
  async function merge(workspace, approval) {
    if (!approval || approval.decision !== "approved" || approval.stage !== "merge" || approval.workspaceId !== workspace.id
      || !SHA.test(approval.expectedHeadCommit) || approval.testsPassed !== true) throw new Error("必须先审核差异和测试结果，并单独批准合并。");
    return serialize(workspace.projectRoot, async () => {
      const reviewResult = await review(workspace);
      if (reviewResult.dirty) throw new Error("实施工作树仍有未提交更改，请先完成实施提交后审核。");
      if (reviewResult.headCommit !== approval.expectedHeadCommit) throw new Error("实施版本在审核后已变化，请重新审核。");
      if (reviewResult.headCommit === workspace.baseCommit) throw new Error("实施工作树没有可合并的新提交。");
      const source = await resolveProject(workspace.projectRoot);
      if (source.dirty) throw new Error("原工作区有未提交更改，合并不会覆盖或暂存这些修改。");
      if (source.headCommit !== workspace.baseCommit) throw new Error("原工作区基线已变化，请重新复核兼容性。");
      let currentRef = null;
      try { currentRef = (await git(source.rootPath, ["symbolic-ref", "--quiet", "HEAD"])).trim(); }
      catch (error) { if (error.code !== 1) throw error; }
      if (currentRef !== workspace.sourceRef) throw new Error("原工作区分支已切换，请重新审核合并目标。");
      const safetyArgs = await checkoutSafetyArgs(source.rootPath);
      const operationMarkers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge"];
      for (const marker of operationMarkers) {
        const markerPath = (await git(source.rootPath, ["rev-parse", "--path-format=absolute", "--git-path", marker])).trim();
        try { await fs.lstat(markerPath); throw new Error("原项目有未完成的 Git 操作，请先处理后合并。"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      // Fast-forward only: never reset, force, stash or create conflict resolutions.
      await git(source.rootPath, [...safetyArgs, "merge", "--ff-only", "--no-edit", reviewResult.headCommit]);
      const merged = await resolveProject(source.rootPath);
      if (merged.headCommit !== reviewResult.headCommit) throw new Error("无法确认合并结果，请检查 Git 状态。");
      return { headCommit: merged.headCommit, mergedAt: Date.now(), requiresReinspection: true };
    });
  }
  async function remove(workspace) {
    return serialize(workspace.projectRoot, async () => {
      const cwd = await assertWorkspace(workspace);
      const state = await review(workspace);
      if (state.dirty) throw new Error("实施工作树有未提交更改，请先处理后移除。");
      await git(workspace.projectRoot, ["worktree", "remove", cwd]);
      // Keep the branch so commits remain recoverable after removing the directory.
      return { branch: workspace.branch, removedAt: Date.now() };
    });
  }
  return { create, review, commit, merge, remove, assertWorkspace };
}
module.exports = { createImplementationWorkspaceManager };
