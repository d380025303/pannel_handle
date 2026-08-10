import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  MAX_DIFF_ROWS,
  createGitStatusService,
  parseBranchList,
  parseHistory,
  parsePorcelainStatus,
  parsePorcelainV2,
  parseStashList,
  parseUnifiedDiff
} = require("./git-status-service.cjs");

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createTerminalManager(session) {
  return {
    getSession: vi.fn(() => session),
    updateGitDirectory: vi.fn((_id, cwd) => {
      session.gitCwd = cwd;
      session.gitCwdHistory = [cwd, ...(session.gitCwdHistory || []).filter((item) => item !== cwd)].slice(0, 10);
      return session;
    })
  };
}

function createSpawnMock(results = [{ stdout: "", stderr: "", code: 0 }]) {
  const calls = [];
  const spawn = vi.fn((command, args, options) => {
    const result = results[Math.min(calls.length, results.length - 1)] || {};
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => queueMicrotask(() => child.emit("close", -1)));
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout, "utf-8"));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr, "utf-8"));
      child.emit("close", result.code ?? 0);
    });
    return child;
  });
  spawn.calls = calls;
  return spawn;
}

function createSshRuntimeMock(result = { stdout: "", stderr: "", code: 0 }) {
  const calls = [];
  return {
    calls,
    execStreaming: vi.fn(async (sessionId, command, options) => {
      calls.push({ sessionId, command, options });
      options.onStdout?.(result.stdout || "");
      options.onStderr?.(result.stderr || "");
      return {
        promise: Promise.resolve({ exitCode: result.code ?? 0 }),
        cancel: vi.fn()
      };
    })
  };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createRepository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-git-test-"));
  temporaryDirectories.push(directory);
  git(directory, "init");
  git(directory, "config", "user.name", "Pannel Test");
  git(directory, "config", "user.email", "pannel@example.test");
  const session = { id: `session-${temporaryDirectories.length}`, type: "windows", cwd: directory };
  const terminalManager = createTerminalManager(session);
  return {
    directory,
    session,
    terminalManager,
    service: createGitStatusService({ terminalManager, sessionStore: {} })
  };
}

describe("git status parsers", () => {
  it("preserves both index and worktree state in legacy porcelain entries", () => {
    const output = ["MM src/App.tsx", "A  src/new.ts", "?? scratch.txt", "R  src/new-name.ts", "src/old-name.ts", ""].join("\0");
    expect(parsePorcelainStatus(output)).toEqual([
      expect.objectContaining({ status: "M", indexStatus: "M", worktreeStatus: "M", path: "src/App.tsx" }),
      expect.objectContaining({ status: "A", indexStatus: "A", worktreeStatus: " ", path: "src/new.ts" }),
      expect.objectContaining({ status: "?", indexStatus: "?", worktreeStatus: "?", path: "scratch.txt" }),
      expect.objectContaining({ status: "R", indexStatus: "R", path: "src/new-name.ts", oldPath: "src/old-name.ts" })
    ]);
  });

  it("parses porcelain v2 branch metadata, double changes, conflicts, and renames", () => {
    const output = [
      "# branch.oid abcdef123456",
      "# branch.head feature/体验",
      "# branch.upstream origin/feature/体验",
      "# branch.ab +2 -3",
      "1 MM N... 100644 100644 100644 abc def src/App.tsx",
      "2 R. N... 100644 100644 100644 abc def R100 src/new name.ts",
      "src/old name.ts",
      "u UU N... 100644 100644 100644 100644 abc def fed conflict.txt",
      "? scratch.txt",
      ""
    ].join("\0");
    const parsed = parsePorcelainV2(output);
    expect(parsed.branch).toMatchObject({ name: "feature/体验", detached: false, ahead: 2, behind: 3, upstream: { remote: "origin", branch: "feature/体验" } });
    expect(parsed.files).toEqual([
      expect.objectContaining({ path: "src/App.tsx", indexStatus: "M", worktreeStatus: "M" }),
      expect.objectContaining({ path: "src/new name.ts", oldPath: "src/old name.ts", indexStatus: "R" }),
      expect.objectContaining({ path: "conflict.txt", conflicted: true, status: "U" }),
      expect.objectContaining({ path: "scratch.txt", status: "?" })
    ]);
  });

  it("parses branch, stash, and history records", () => {
    expect(parseBranchList("refs/heads/main\tmain\t*\tabc1234\tnow\nrefs/remotes/origin/HEAD\torigin/HEAD\t\tabc\tnow")).toEqual([
      { name: "main", kind: "local", current: true, commit: "abc1234", relativeTime: "now" }
    ]);
    expect(parseStashList("stash@{0}\tabc\t1 minute ago\tOn main: work")).toEqual([
      { ref: "stash@{0}", commit: "abc", relativeTime: "1 minute ago", message: "On main: work" }
    ]);
    expect(parseHistory("abcdef\x1fabcdef\x1fAda\x1fada@example.test\x1f10\x1fSubject\x1fHEAD -> main\x1e")).toEqual([
      expect.objectContaining({ oid: "abcdef", authorName: "Ada", authoredAt: 10000, decorations: ["HEAD -> main"] })
    ]);
  });

  it("parses side-by-side diffs and truncates row output", () => {
    const diff = ["@@ -1,2 +1,3 @@", " same", "-old", "+new", "+extra"].join("\n");
    expect(parseUnifiedDiff(diff)).toMatchObject({
      kind: "text",
      truncated: false,
      rows: [
        { type: "context", oldLineNumber: 1, newLineNumber: 1, oldText: "same", newText: "same" },
        { type: "modify", oldLineNumber: 2, newLineNumber: 2, oldText: "old", newText: "new" },
        { type: "add", newLineNumber: 3, newText: "extra" }
      ]
    });
    expect(parseUnifiedDiff("Binary files a/x and b/x differ")).toMatchObject({ kind: "binary", rows: [] });
    const oversized = ["@@ -1,6000 +1,6000 @@", ...Array.from({ length: 6000 }, (_, index) => ` line ${index}`)].join("\n");
    expect(parseUnifiedDiff(oversized)).toMatchObject({ truncated: true });
    expect(parseUnifiedDiff(oversized).rows).toHaveLength(MAX_DIFF_ROWS);
  });
});

describe("git command routing", () => {
  it("runs non-interactive porcelain v2 status on Windows and WSL", async () => {
    const status = ["# branch.oid abc", "# branch.head main", "1 .M N... 100644 100644 100644 abc def README.md", ""].join("\0");
    const windowsSpawn = createSpawnMock([{ stdout: status }]);
    const windowsService = createGitStatusService({
      terminalManager: createTerminalManager({ id: "win", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn: windowsSpawn
    });
    await expect(windowsService.getStatus("win")).resolves.toMatchObject({ clean: false, branch: { name: "main" }, files: [expect.objectContaining({ worktreeStatus: "M" })] });
    expect(windowsSpawn.calls[0]).toMatchObject({ command: "git", args: ["status", "--porcelain=v2", "--branch", "-z"] });
    expect(windowsSpawn.calls[0].options.env.GIT_TERMINAL_PROMPT).toBe("0");

    const wslSpawn = createSpawnMock([{ stdout: status }]);
    const wslService = createGitStatusService({
      terminalManager: createTerminalManager({ id: "wsl", type: "wsl", cwd: "/work/repo", wslDistro: "Ubuntu-24.04" }),
      sessionStore: {},
      spawn: wslSpawn
    });
    await wslService.getStatus("wsl");
    expect(wslSpawn.calls[0].args).toEqual(["-d", "Ubuntu-24.04", "--cd", "/work/repo", "--exec", "env", "GIT_TERMINAL_PROMPT=0", "git", "status", "--porcelain=v2", "--branch", "-z"]);
  });

  it("quotes SSH directories and supports cancellable streaming execution", async () => {
    const status = ["# branch.oid abc", "# branch.head main", "? remote.txt", ""].join("\0");
    const sshRuntime = createSshRuntimeMock({ stdout: status });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "ssh", type: "ssh", cwd: "/srv/app's repo" }),
      sessionStore: {},
      sshSessionRuntime: sshRuntime
    });
    await expect(service.getStatus("ssh")).resolves.toMatchObject({ files: [expect.objectContaining({ path: "remote.txt" })] });
    expect(sshRuntime.calls[0].command).toBe("cd '/srv/app'\\''s repo' && GIT_TERMINAL_PROMPT=0 git 'status' '--porcelain=v2' '--branch' '-z'");
  });

  it("uses scoped diff, stash index restoration, and contextual discard commands", async () => {
    const spawn = createSpawnMock(Array.from({ length: 5 }, () => ({ stdout: "" })));
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "win", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });
    await service.getDiff("win", { scope: "staged", path: "src/App.tsx" });
    await service.applyStash("win", "stash@{0}", "apply-1");
    await service.popStash("win", "stash@{1}", "pop-1");
    await service.discardWorkingTree("win", { path: "src/App.tsx", status: "M", indexStatus: "M" }, "discard-1");
    await service.discardWorkingTree("win", { path: "scratch.txt", status: "?", indexStatus: "?" }, "discard-2");
    expect(spawn.calls.map((call) => call.args)).toEqual([
      ["diff", "--cached", "--no-color", "--find-renames", "--", "src/App.tsx"],
      ["stash", "apply", "--index", "stash@{0}"],
      ["stash", "pop", "--index", "stash@{1}"],
      ["restore", "--worktree", "--", "src/App.tsx"],
      ["clean", "-f", "--", "scratch.txt"]
    ]);
  });

  it("rejects unsafe paths and refs", async () => {
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "win", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn: createSpawnMock()
    });
    expect(() => service.applyStash("win", "stash@{x}", "bad-stash")).toThrow("stash reference");
    await expect(service.discardWorkingTree("win", { path: "../secret" }, "bad-path")).rejects.toThrow("repository-relative path");
  });
});

describe("real temporary repository workflow", () => {
  it("stages, commits, preserves staged content when discarding, and unstages", async () => {
    const { directory, service } = createRepository();
    fs.writeFileSync(path.join(directory, "note.txt"), "initial\n", "utf-8");
    let status = await service.getStatus("session-1");
    expect(status.branch.unborn).toBe(true);
    expect(status.files[0]).toMatchObject({ path: "note.txt", indexStatus: "?" });

    expect((await service.stageFiles("session-1", ["note.txt"], "stage-initial")).ok).toBe(true);
    expect((await service.commit("session-1", { subject: "Initial", body: "Body" }, "commit-initial")).ok).toBe(true);
    fs.writeFileSync(path.join(directory, "note.txt"), "staged\n", "utf-8");
    await service.stageFiles("session-1", ["note.txt"], "stage-change");
    fs.writeFileSync(path.join(directory, "note.txt"), "working\n", "utf-8");

    status = await service.getStatus("session-1");
    expect(status.files[0]).toMatchObject({ indexStatus: "M", worktreeStatus: "M" });
    await service.discardWorkingTree("session-1", status.files[0], "discard-working");
    expect(fs.readFileSync(path.join(directory, "note.txt"), "utf-8").replace(/\r\n/g, "\n")).toBe("staged\n");
    status = await service.getStatus("session-1");
    expect(status.files[0]).toMatchObject({ indexStatus: "M", worktreeStatus: "." });

    await service.unstageFiles("session-1", ["note.txt"], "unstage-change");
    status = await service.getStatus("session-1");
    expect(status.files[0]).toMatchObject({ indexStatus: ".", worktreeStatus: "M" });
    const commitWithoutStagedChanges = await service.commit("session-1", { subject: "Must not commit working tree" }, "commit-working-only");
    expect(commitWithoutStagedChanges).toMatchObject({ ok: false, message: "Stage at least one change before committing." });
  });

  it("creates Unicode branches and paginates current-HEAD history", async () => {
    const { directory, service } = createRepository();
    fs.writeFileSync(path.join(directory, "one.txt"), "1\n", "utf-8");
    await service.stageAll("session-1", "stage-all");
    await service.commit("session-1", { subject: "First" }, "commit-first");
    expect((await service.createBranch("session-1", "功能/体验", "branch-unicode")).ok).toBe(true);
    fs.writeFileSync(path.join(directory, "one.txt"), "2\n", "utf-8");
    await service.stageAll("session-1", "stage-second");
    await service.commit("session-1", { subject: "Second" }, "commit-second");
    const snapshot = await service.getSnapshot("session-1");
    expect(snapshot.status.branch.name).toBe("功能/体验");
    const history = await service.getHistory("session-1");
    expect(history.commits.map((entry) => entry.subject)).toEqual(["Second", "First"]);
    expect(history.hasMore).toBe(false);
  });

  it("creates a message stash, previews it, restores index state, and drops it", async () => {
    const { directory, service } = createRepository();
    fs.writeFileSync(path.join(directory, "stash.txt"), "base\n", "utf-8");
    await service.stageAll("session-1", "stage-base");
    await service.commit("session-1", { subject: "Base" }, "commit-base");
    fs.writeFileSync(path.join(directory, "stash.txt"), "staged\n", "utf-8");
    await service.stageAll("session-1", "stage-stash");
    fs.writeFileSync(path.join(directory, "working.txt"), "working\n", "utf-8");
    expect((await service.stashChanges("session-1", "work in progress", "stash-create")).ok).toBe(true);
    const list = await service.getStashes("session-1");
    expect(list.stashes[0].message).toContain("work in progress");
    const diff = await service.getDiff("session-1", { scope: "stash", revision: list.stashes[0].ref });
    expect(diff.rows.length).toBeGreaterThan(0);
    expect((await service.applyStash("session-1", list.stashes[0].ref, "stash-apply")).ok).toBe(true);
    const status = await service.getStatus("session-1");
    expect(status.files.find((file) => file.path === "stash.txt")?.indexStatus).toBe("M");
    expect((await service.dropStash("session-1", list.stashes[0].ref, "stash-drop")).ok).toBe(true);
    expect((await service.getStashes("session-1")).stashes).toHaveLength(0);
  });

  it("sets upstream on first push and enforces fast-forward-only pulls", async () => {
    const { directory, service } = createRepository();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-git-remote-"));
    temporaryDirectories.push(remote);
    git(remote, "init", "--bare");
    git(directory, "remote", "add", "origin", remote);
    fs.writeFileSync(path.join(directory, "sync.txt"), "one\n", "utf-8");
    await service.stageAll("session-1", "sync-stage");
    await service.commit("session-1", { subject: "Sync base" }, "sync-commit");
    expect((await service.pushBranch("session-1", "origin", "sync-push")).ok).toBe(true);
    let snapshot = await service.getSnapshot("session-1");
    expect(snapshot.status.branch.upstream?.remote).toBe("origin");

    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-git-clone-"));
    temporaryDirectories.push(clone);
    execFileSync("git", ["clone", remote, clone], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    git(clone, "config", "user.name", "Other Test");
    git(clone, "config", "user.email", "other@example.test");
    fs.writeFileSync(path.join(clone, "sync.txt"), "two\n", "utf-8");
    git(clone, "add", "-A");
    git(clone, "commit", "-m", "Remote change");
    git(clone, "push");

    expect((await service.fetchRemote("session-1", "origin", "sync-fetch")).ok).toBe(true);
    snapshot = await service.getSnapshot("session-1");
    expect(snapshot.status.branch.behind).toBe(1);
    expect((await service.pullBranch("session-1", "sync-pull")).ok).toBe(true);
    expect(fs.readFileSync(path.join(directory, "sync.txt"), "utf-8").replace(/\r\n/g, "\n")).toBe("two\n");
  });
});
