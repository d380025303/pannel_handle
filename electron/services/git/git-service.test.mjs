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
  createGitService: createGitServiceImpl,
  parseBranchList,
  parseHistory,
  parsePorcelainStatus,
  parsePorcelainV2,
  parseStashList,
  parseUnifiedDiff
} = require("./git-service.cjs");
const { createSshGitExecutor } = require("../../ssh/ssh-git-executor.cjs");

function createGitService(options) {
  const { sshSessionRuntime, ...serviceOptions } = options;
  if (!serviceOptions.sshGitExecutor && sshSessionRuntime) {
    serviceOptions.sshGitExecutor = createSshGitExecutor({ sshSessionRuntime });
  }
  return createGitServiceImpl(serviceOptions);
}

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createTerminalManager(session) {
  return {
    getSession: vi.fn(() => session)
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
      const current = Array.isArray(result) ? result[Math.min(calls.length - 1, result.length - 1)] : result;
      options.onStdout?.(current.stdout || "");
      options.onStderr?.(current.stderr || "");
      return {
        promise: Promise.resolve({ exitCode: current.code ?? 0 }),
        cancel: vi.fn()
      };
    })
  };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repositoryTarget(sessionId, cwd) {
  return { sessionId, cwd };
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
    service: createGitService({ terminalManager, sessionStore: {} })
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

  it.each(["+", "-"])("bounds a 500,000-line %s block", (prefix) => {
    const result = parseUnifiedDiff(`@@ -1,500000 +1,500000 @@\n${`${prefix}x\n`.repeat(500000)}`);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(MAX_DIFF_ROWS);
    expect(result.rows[0].type).toBe(prefix === "+" ? "add" : "delete");
    expect(result.rows.at(-1)).toMatchObject(prefix === "+"
      ? { newLineNumber: MAX_DIFF_ROWS, newText: "x" }
      : { oldLineNumber: MAX_DIFF_ROWS, oldText: "x" });
  });

  it("preserves pairing after overflowing deletions and respects remaining capacity", () => {
    const result = parseUnifiedDiff("@@ -10,6 +20,4 @@\r\n same\r\n-a\r\n-b\r\n-c\r\n-d\r\n+one\r\n+two\r\n tail", 3);
    expect(result).toEqual({ kind: "text", truncated: true, rows: [
      { type: "context", oldLineNumber: 10, newLineNumber: 20, oldText: "same", newText: "same" },
      { type: "modify", oldLineNumber: 11, newLineNumber: 21, oldText: "a", newText: "one" },
      { type: "modify", oldLineNumber: 12, newLineNumber: 22, oldText: "b", newText: "two" }
    ] });
  });

  it.each([
    ["-a\n-b\n+one\n+two\n+three", ["modify", "modify"]],
    ["-a\n-b\n-c\n+one", ["modify", "delete"]],
    ["-a\n+one\n+two\n+three", ["modify", "add"]]
  ])("caps asymmetric changed blocks: %s", (block, types) => {
    const result = parseUnifiedDiff(`@@ -1,3 +1,3 @@\n${block}`, 2);
    expect(result.rows.map((row) => row.type)).toEqual(types);
    expect(result.truncated).toBe(true);
  });

  it("does not truncate an exact-capacity block or append context beyond the limit", () => {
    const block = "@@ -1,2 +1,2 @@\n-a\n-b\n+one\n+two";
    expect(parseUnifiedDiff(block, 2)).toMatchObject({ truncated: false, rows: [{ type: "modify" }, { type: "modify" }] });
    expect(parseUnifiedDiff(`${block}\n context`, 2)).toMatchObject({ truncated: true, rows: [{ type: "modify" }, { type: "modify" }] });
  });
});

describe("git command routing", () => {
  it("runs non-interactive porcelain v2 status on Windows and WSL", async () => {
    const status = ["# branch.oid abc", "# branch.head main", "1 .M N... 100644 100644 100644 abc def README.md", ""].join("\0");
    const windowsSpawn = createSpawnMock([{ stdout: status }]);
    const windowsService = createGitService({
      terminalManager: createTerminalManager({ id: "win", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn: windowsSpawn
    });
    await expect(windowsService.getStatus(repositoryTarget("win", "C:\\work\\repo"))).resolves.toMatchObject({ clean: false, branch: { name: "main" }, files: [expect.objectContaining({ worktreeStatus: "M" })] });
    expect(windowsSpawn.calls[0]).toMatchObject({ command: "git", args: ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"] });
    expect(windowsSpawn.calls[0].options.env.GIT_TERMINAL_PROMPT).toBe("0");

    const wslSpawn = createSpawnMock([{ stdout: status }]);
    const wslService = createGitService({
      terminalManager: createTerminalManager({ id: "wsl", type: "wsl", cwd: "/work/repo", wslDistro: "Ubuntu-24.04" }),
      sessionStore: {},
      spawn: wslSpawn
    });
    await wslService.getStatus(repositoryTarget("wsl", "/work/repo"));
    expect(wslSpawn.calls[0].args).toEqual(["-d", "Ubuntu-24.04", "--cd", "/work/repo", "--exec", "env", "GIT_TERMINAL_PROMPT=0", "git", "status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]);
    expect(wslSpawn.calls[0].options.cwd).toBeUndefined();
  });

  it("routes one-level repository discovery through WSL", async () => {
    const wslSpawn = createSpawnMock([
      { stdout: "./alpha\0./plain\0" },
      { code: 128 },
      { stdout: "/work/alpha\ntrue\n" },
      { code: 128 }
    ]);
    const service = createGitService({
      terminalManager: createTerminalManager({ id: "wsl-scan", type: "wsl", cwd: "/work", wslDistro: "Ubuntu-24.04" }),
      sessionStore: {},
      spawn: wslSpawn
    });

    await expect(service.discoverRepositories("wsl-scan")).resolves.toEqual({
      root: "/work",
      repositories: [{ cwd: "/work/alpha", name: "alpha", relativePath: "alpha" }]
    });
    expect(wslSpawn.calls[0].args).toEqual(["-d", "Ubuntu-24.04", "--cd", "/work", "--exec", "find", ".", "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-print0"]);
    expect(wslSpawn.calls.slice(1).every((call) => call.args.includes("--is-inside-work-tree"))).toBe(true);
    expect(wslSpawn.calls.every((call) => call.options.cwd === undefined)).toBe(true);
  });

  it("quotes SSH directories and supports cancellable streaming execution", async () => {
    const status = ["# branch.oid abc", "# branch.head main", "? remote.txt", ""].join("\0");
    const sshRuntime = createSshRuntimeMock({ stdout: status });
    const service = createGitService({
      terminalManager: createTerminalManager({ id: "ssh", type: "ssh", cwd: "/srv/app's repo" }),
      sessionStore: {},
      sshSessionRuntime: sshRuntime
    });
    await expect(service.getStatus(repositoryTarget("ssh", "/srv/app's repo"))).resolves.toMatchObject({ files: [expect.objectContaining({ path: "remote.txt" })] });
    expect(sshRuntime.calls[0].command).toBe("cd '/srv/app'\\''s repo' && GIT_TERMINAL_PROMPT=0 git 'status' '--porcelain=v2' '--branch' '--untracked-files=all' '-z'");
  });

  it("routes one-level repository discovery through SSH with quoted paths", async () => {
    const sshRuntime = createSshRuntimeMock([
      { stdout: "./alpha\0" },
      { code: 128 },
      { stdout: "/srv/app's workspace/alpha\ntrue\n" }
    ]);
    const session = { id: "ssh-scan", type: "ssh", cwd: "/srv/app's workspace" };
    const service = createGitService({
      terminalManager: createTerminalManager(session),
      sessionStore: {},
      sshSessionRuntime: sshRuntime
    });

    await expect(service.discoverRepositories(session.id)).resolves.toEqual({
      root: session.cwd,
      repositories: [{ cwd: `${session.cwd}/alpha`, name: "alpha", relativePath: "alpha" }]
    });
    expect(sshRuntime.calls[0].command).toContain("cd '/srv/app'\\''s workspace' && find");
    expect(sshRuntime.calls.slice(1).every((call) => call.command.includes("GIT_TERMINAL_PROMPT=0 git 'rev-parse'"))).toBe(true);
  });

  it("uses scoped diff, stash index restoration, and contextual discard commands", async () => {
    const spawn = createSpawnMock(Array.from({ length: 5 }, () => ({ stdout: "" })));
    const service = createGitService({
      terminalManager: createTerminalManager({ id: "win", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });
    const target = repositoryTarget("win", "C:\\work\\repo");
    await service.getDiff(target, { scope: "staged", path: "src/App.tsx" });
    await service.applyStash(target, "stash@{0}", "apply-1");
    await service.popStash(target, "stash@{1}", "pop-1");
    await service.discardWorkingTree(target, { path: "src/App.tsx", status: "M", indexStatus: "M" }, "discard-1");
    await service.discardWorkingTree(target, { path: "scratch.txt", status: "?", indexStatus: "?" }, "discard-2");
    expect(spawn.calls.map((call) => call.args)).toEqual([
      ["diff", "--cached", "--no-color", "--find-renames", "--", ":(literal)src/App.tsx"],
      ["stash", "apply", "--index", "stash@{0}"],
      ["stash", "pop", "--index", "stash@{1}"],
      ["restore", "--worktree", "--", ":(literal)src/App.tsx"],
      ["clean", "-f", "--", ":(literal)scratch.txt"]
    ]);
  });

  it("rejects unsafe paths and refs", async () => {
    const service = createGitService({
      terminalManager: createTerminalManager({ id: "win", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn: createSpawnMock()
    });
    const target = repositoryTarget("win", "C:\\work\\repo");
    expect(() => service.applyStash(target, "stash@{x}", "bad-stash")).toThrow("stash reference");
    await expect(service.discardWorkingTree(target, { path: "../secret" }, "bad-path")).rejects.toThrow("repository-relative path");
    for (const invalidPath of [undefined, null, 123, {}, "", "a\0.txt", "/absolute.txt", "C:\\absolute.txt", "dir/../secret", "dir\\..\\secret"]) {
      await expect(service.discardWorkingTree(target, { path: invalidPath }, "bad-path")).rejects.toThrow("repository-relative path");
    }
  });

  it("preserves leading and trailing spaces in repository path arguments", async () => {
    const spawn = createSpawnMock();
    const service = createGitService({
      terminalManager: createTerminalManager({ id: "win", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });
    const target = repositoryTarget("win", "C:\\work\\repo");
    for (const repoPath of [" a.txt", "a.txt ", " a.txt "]) {
      await service.stageFiles(target, [repoPath], "stage-spaces");
      expect(spawn.calls.at(-1).args.at(-1)).toBe(`:(literal)${repoPath}`);
      await service.unstageFiles(target, [repoPath], "unstage-spaces");
      expect(spawn.calls.at(-1).args.at(-1)).toBe(`:(literal)${repoPath}`);
      await service.getDiff(target, { scope: "working", path: repoPath });
      expect(spawn.calls.at(-1).args.at(-1)).toBe(`:(literal)${repoPath}`);
      await service.discardWorkingTree(target, { path: repoPath }, "discard-spaces");
      expect(spawn.calls.at(-1).args.at(-1)).toBe(`:(literal)${repoPath}`);
    }
  });
});

describe("real temporary repository workflow", () => {
  it("previews merge conflict markers against ours while preserving ordinary working diffs", async () => {
    const { directory, session, service } = createRepository();
    const target = repositoryTarget(session.id, directory);
    git(directory, "config", "core.autocrlf", "false");
    const filePath = path.join(directory, "conflict.txt");
    fs.writeFileSync(filePath, "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "base");
    git(directory, "checkout", "-b", "theirs");
    fs.writeFileSync(filePath, "their content\n");
    git(directory, "commit", "-am", "theirs");
    git(directory, "checkout", "-b", "ours", "HEAD~1");
    fs.writeFileSync(filePath, "our content\n");
    git(directory, "commit", "-am", "ours");
    expect(() => git(directory, "merge", "theirs")).toThrow();
    expect(git(directory, "diff", "--", "conflict.txt")).toContain("@@@");
    const status = await service.getStatus(target);
    const file = status.files.find((entry) => entry.path === "conflict.txt");
    expect(file).toMatchObject({ conflicted: true, status: "U" });
    const diff = await service.getDiff(target, { ...file, scope: "working" });
    expect(diff).toMatchObject({ comparisonBase: "ours", kind: "text", truncated: false });
    expect(diff.rows.length).toBeGreaterThan(0);
    const content = diff.rows.map((row) => row.newText ?? "").join("\n");
    for (const text of ["<<<<<<<", "our content", "=======", "their content", ">>>>>>>"]) {
      expect(content).toContain(text);
    }
    git(directory, "merge", "--abort");
    fs.writeFileSync(filePath, "ordinary change\n");
    const workingDiff = await service.getDiff(target, { scope: "working", path: "conflict.txt", status: "M" });
    expect(workingDiff.comparisonBase).toBeUndefined();
    expect(workingDiff.rows).toEqual([{ type: "modify", oldLineNumber: 1, newLineNumber: 1, oldText: "our content", newText: "ordinary change" }]);
  }, 15000);

  it("lists and previews each untracked file inside a new directory", async () => {
    const { directory, session, service } = createRepository();
    const target = repositoryTarget(session.id, directory);
    const files = [
      ["new-folder/note.txt", "hello"],
      ["new-folder/nested/second.txt", "second"]
    ];
    for (const [filePath, content] of files) {
      const absolutePath = path.join(directory, filePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, `${content}\n`);
    }

    const status = await service.getStatus(target);
    expect(status.clean).toBe(false);
    expect(status.files.map((file) => file.path).sort()).toEqual(files.map(([filePath]) => filePath).sort());
    for (const [filePath, content] of files) {
      const file = status.files.find((entry) => entry.path === filePath);
      expect(file).toMatchObject({ status: "?", indexStatus: "?", worktreeStatus: "?" });
      const diff = await service.getDiff(target, { ...file, scope: "working" });
      expect(diff).toMatchObject({
        path: filePath,
        kind: "text",
        truncated: false,
        rows: [{ type: "add", newLineNumber: 1, newText: content }]
      });
      expect(diff.rows).toHaveLength(1);
    }
  });

  it.each(["commit", "stash"])("excludes file headers from multi-file %s previews", async (scope) => {
    const { directory, session, service } = createRepository();
    git(directory, "config", "core.autocrlf", "false");
    const target = repositoryTarget(session.id, directory);
    for (const name of ["a.txt", "b.txt"]) {
      fs.writeFileSync(path.join(directory, name), "old\n");
    }
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "Base");
    for (const name of ["a.txt", "b.txt"]) {
      fs.writeFileSync(path.join(directory, name), "new\n");
    }
    let revision;
    if (scope === "commit") {
      git(directory, "add", "-A");
      git(directory, "commit", "-m", "Change both files");
      revision = git(directory, "rev-parse", "HEAD");
    } else {
      git(directory, "stash", "push", "-m", "Change both files");
      revision = "stash@{0}";
    }

    const diff = await service.getDiff(target, { scope, revision });
    expect(diff.kind).toBe("text");
    expect(diff.truncated).toBe(false);
    expect(diff.rows).toEqual([
      { type: "modify", oldLineNumber: 1, newLineNumber: 1, oldText: "old", newText: "new" },
      { type: "modify", oldLineNumber: 1, newLineNumber: 1, oldText: "old", newText: "new" }
    ]);
  });

  it.each([ [" a.txt", "a.txt"], ["a[1].txt", "a1.txt"] ])("isolates diff, stage, unstage, and discard for %s", async (selectedName, otherName) => {
    const { directory, session, service } = createRepository();
    git(directory, "config", "core.autocrlf", "false");
    const target = repositoryTarget(session.id, directory);
    const plainPath = path.join(directory, otherName);
    const spacedPath = path.join(directory, selectedName);
    fs.writeFileSync(plainPath, "plain base\n");
    fs.writeFileSync(spacedPath, "spaced base\n");
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "Base");
    fs.writeFileSync(plainPath, "plain modified\n");
    fs.writeFileSync(spacedPath, "spaced modified\n");

    for (const scope of ["combined", "commit"]) {
      const diff = await service.getDiff(target, { scope, path: selectedName, revision: git(directory, "rev-parse", "HEAD") });
      expect(diff.rows.some((row) => row.newText === "plain modified" || row.newText === "plain base")).toBe(false);
      expect(diff.rows.length).toBeGreaterThan(0);
    }
    const workingDiff = await service.getDiff(target, { scope: "working", path: selectedName });
    expect(workingDiff.rows).toContainEqual(expect.objectContaining({ oldText: "spaced base", newText: "spaced modified" }));
    expect(workingDiff.rows.some((row) => row.newText === "plain modified")).toBe(false);

    expect((await service.stageFiles(target, [selectedName], "stage-spaced")).ok).toBe(true);
    expect(git(directory, "show", `:${otherName}`)).toBe("plain base");
    expect(git(directory, "show", `:${selectedName}`)).toBe("spaced modified");
    const stagedDiff = await service.getDiff(target, { scope: "staged", path: selectedName });
    expect(stagedDiff.rows).toContainEqual(expect.objectContaining({ oldText: "spaced base", newText: "spaced modified" }));

    git(directory, "add", "--", otherName);
    expect((await service.unstageFiles(target, [selectedName], "unstage-spaced")).ok).toBe(true);
    expect(git(directory, "show", `:${otherName}`)).toBe("plain modified");
    expect(git(directory, "show", `:${selectedName}`)).toBe("spaced base");
    expect(fs.readFileSync(spacedPath, "utf-8")).toBe("spaced modified\n");
    git(directory, "restore", "--staged", "--", otherName);

    expect((await service.discardWorkingTree(target, { path: selectedName, status: "M", indexStatus: "." }, "discard-spaced")).ok).toBe(true);
    expect(fs.readFileSync(spacedPath, "utf-8")).toBe("spaced base\n");
    expect(fs.readFileSync(plainPath, "utf-8")).toBe("plain modified\n");
    expect(git(directory, "show", `:${otherName}`)).toBe("plain base");
    expect((await service.getStatus(target)).files.map((file) => file.path)).toEqual([otherName]);
  });

  it("unstages both rename paths while preserving the renamed worktree file", async () => {
    const { directory, session, service } = createRepository();
    git(directory, "config", "core.autocrlf", "false");
    const target = repositoryTarget(session.id, directory);
    const content = "rename content\n";
    fs.writeFileSync(path.join(directory, "before.txt"), content);
    git(directory, "add", "before.txt");
    git(directory, "commit", "-m", "Base");
    git(directory, "mv", "before.txt", "after.txt");

    const { files } = await service.getStatus(target);
    expect(files).toEqual([
      expect.objectContaining({ indexStatus: "R", oldPath: "before.txt", path: "after.txt" })
    ]);
    expect((await service.unstageFiles(target, [files[0].oldPath, files[0].path], "unstage-renamed")).ok).toBe(true);

    expect(git(directory, "diff", "--cached", "--name-status")).toBe("");
    expect(fs.existsSync(path.join(directory, "before.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(directory, "after.txt"), "utf-8")).toBe(content);
  });

  it("discards worktree edits while preserving a staged rename", async () => {
    const { directory, session, service } = createRepository();
    git(directory, "config", "core.autocrlf", "false");
    const target = repositoryTarget(session.id, directory);
    fs.writeFileSync(path.join(directory, "old.txt"), "index content\n");
    git(directory, "add", "old.txt");
    git(directory, "commit", "-m", "Base");
    git(directory, "mv", "old.txt", "new.txt");
    fs.writeFileSync(path.join(directory, "new.txt"), "worktree edits\n");

    const before = await service.getStatus(target);
    expect(before.files).toEqual([
      expect.objectContaining({ path: "new.txt", oldPath: "old.txt", indexStatus: "R", worktreeStatus: "M" })
    ]);
    expect((await service.discardWorkingTree(target, before.files[0], "discard-renamed")).ok).toBe(true);
    expect(fs.readFileSync(path.join(directory, "new.txt"), "utf-8")).toBe("index content\n");
    expect(fs.existsSync(path.join(directory, "old.txt"))).toBe(false);
    expect(git(directory, "show", ":new.txt")).toBe("index content");
    expect((await service.getStatus(target)).files).toEqual([
      expect.objectContaining({ path: "new.txt", oldPath: "old.txt", indexStatus: "R", worktreeStatus: "." })
    ]);
  });

  it("isolates unborn unstage, untracked diff, and clean for bracket filenames", async () => {
    const { directory, session, service } = createRepository();
    git(directory, "config", "core.autocrlf", "false");
    const target = repositoryTarget(session.id, directory);
    fs.writeFileSync(path.join(directory, "a[1].txt"), "selected content\n");
    fs.writeFileSync(path.join(directory, "a1.txt"), "other content\n");
    git(directory, "add", "-A");
    expect((await service.unstageFiles(target, ["a[1].txt"], "unstage-unborn")).ok).toBe(true);
    expect(git(directory, "ls-files")).toBe("a1.txt");
    for (const scope of ["working", "combined"]) {
      const diff = await service.getDiff(target, { scope, path: "a[1].txt", status: "?" });
      expect(diff.rows).toContainEqual(expect.objectContaining({ newText: "selected content" }));
    }
    git(directory, "rm", "--cached", "--", "a1.txt");
    expect((await service.discardWorkingTree(target, { path: "a[1].txt", status: "?" }, "clean-brackets")).ok).toBe(true);
    expect(fs.existsSync(path.join(directory, "a[1].txt"))).toBe(false);
    expect(fs.readFileSync(path.join(directory, "a1.txt"), "utf-8")).toBe("other content\n");
  });

  it("discovers only the current directory and immediate child working trees", async () => {
    const aggregate = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-git-aggregate-"));
    temporaryDirectories.push(aggregate);
    const alpha = path.join(aggregate, "alpha");
    const beta = path.join(aggregate, "beta");
    const nested = path.join(aggregate, "group", "nested");
    const bare = path.join(aggregate, "bare.git");
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
    fs.mkdirSync(nested, { recursive: true });
    git(alpha, "init");
    git(beta, "init");
    git(nested, "init");
    git(aggregate, "init", "--bare", bare);
    const session = { id: "aggregate-session", type: "windows", cwd: aggregate };
    const service = createGitService({ terminalManager: createTerminalManager(session), sessionStore: {} });

    const result = await service.discoverRepositories(session.id);

    expect(result.root).toBe(path.resolve(aggregate));
    expect(result.repositories.map((repository) => repository.cwd)).toEqual([path.resolve(alpha), path.resolve(beta)]);
    expect(result.repositories.map((repository) => repository.relativePath)).toEqual(["alpha", "beta"]);

    fs.writeFileSync(path.join(beta, "changed.txt"), "changed\n", "utf-8");
    const workspace = await service.getWorkspaceSnapshot(session.id);
    expect(workspace.repositories).toEqual([
      expect.objectContaining({ cwd: path.resolve(alpha), snapshot: expect.objectContaining({ status: expect.objectContaining({ clean: true }) }) }),
      expect.objectContaining({ cwd: path.resolve(beta), snapshot: expect.objectContaining({ status: expect.objectContaining({ clean: false }) }) })
    ]);
  });

  it("deduplicates the containing repository when scanning from one of its directories", async () => {
    const { directory, session, service } = createRepository();
    const nested = path.join(directory, "src");
    fs.mkdirSync(nested);
    fs.mkdirSync(path.join(nested, "child"));
    session.cwd = nested;

    const result = await service.discoverRepositories(session.id);

    expect(result.repositories).toEqual([expect.objectContaining({ cwd: path.resolve(directory), relativePath: ".." })]);
  });

  it("creates a message stash, previews it, restores index state, and drops it", async () => {
    const { directory, service } = createRepository();
    const target = repositoryTarget("session-1", directory);
    fs.writeFileSync(path.join(directory, "stash.txt"), "base\n", "utf-8");
    await service.stageAll(target, "stage-base");
    await service.commit(target, { subject: "Base" }, "commit-base");
    fs.writeFileSync(path.join(directory, "stash.txt"), "staged\n", "utf-8");
    await service.stageAll(target, "stage-stash");
    fs.writeFileSync(path.join(directory, "working.txt"), "working\n", "utf-8");
    expect((await service.stashChanges(target, "work in progress", "stash-create")).ok).toBe(true);
    const list = await service.getStashes(target);
    expect(list.stashes[0].message).toContain("work in progress");
    const diff = await service.getDiff(target, { scope: "stash", revision: list.stashes[0].ref });
    expect(diff.rows.length).toBeGreaterThan(0);
    expect((await service.applyStash(target, list.stashes[0].ref, "stash-apply")).ok).toBe(true);
    const status = await service.getStatus(target);
    expect(status.files.find((file) => file.path === "stash.txt")?.indexStatus).toBe("M");
    expect((await service.dropStash(target, list.stashes[0].ref, "stash-drop")).ok).toBe(true);
    expect((await service.getStashes(target)).stashes).toHaveLength(0);
  });

  it("reports a missing matching remote branch without changing the local branch", async () => {
    const { directory, service } = createRepository();
    const target = repositoryTarget("session-1", directory);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-git-remote-"));
    temporaryDirectories.push(remote);
    git(remote, "init", "--bare");
    git(directory, "remote", "add", "origin", remote);
    fs.writeFileSync(path.join(directory, "sync.txt"), "local\n", "utf-8");
    git(directory, "add", "sync.txt");
    git(directory, "commit", "-m", "Local base");
    const originalHead = git(directory, "rev-parse", "HEAD");

    const result = await service.pullBranch(target, "origin", "missing-pull");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not exist");
    expect(git(directory, "rev-parse", "HEAD")).toBe(originalHead);
    expect((await service.getStatus(target)).branch.upstream).toBeUndefined();
  });
});
