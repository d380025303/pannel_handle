import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createGitStatusService,
  parseBranchList,
  parsePorcelainStatus,
  parseStashList,
  parseUnifiedDiff
} = require("./git-status-service.cjs");

function createTerminalManager(session) {
  return {
    getSession: vi.fn(() => session)
  };
}

function createSpawnMock({ stdout = "", stderr = "", code = 0 } = {}) {
  const calls = [];
  const spawn = vi.fn((command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout, "utf-8"));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf-8"));
      child.emit("close", code);
    });
    return child;
  });
  spawn.calls = calls;
  return spawn;
}

function createSpawnSequenceMock(results) {
  const calls = [];
  const spawn = vi.fn((command, args, options) => {
    calls.push({ command, args, options });
    const result = results[Math.min(calls.length - 1, results.length - 1)] || {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
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

function createSshClientMock({ stdout = "", stderr = "", code = 0 } = {}) {
  const client = new EventEmitter();
  client.connect = vi.fn(() => queueMicrotask(() => client.emit("ready")));
  client.end = vi.fn();
  client.exec = vi.fn((_command, callback) => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    callback(undefined, stream);
    queueMicrotask(() => {
      if (stdout) stream.emit("data", Buffer.from(stdout, "utf-8"));
      if (stderr) stream.stderr.emit("data", Buffer.from(stderr, "utf-8"));
      stream.emit("close", code);
    });
  });
  return client;
}

describe("git-status-service", () => {
  it("parses porcelain status entries", () => {
    const output = [
      " M src/App.tsx",
      "A  src/new.ts",
      " D old.txt",
      "?? scratch.txt",
      "R  src/new-name.ts",
      "src/old-name.ts",
      ""
    ].join("\0");

    expect(parsePorcelainStatus(output)).toEqual([
      { status: "M", label: "已修改", path: "src/App.tsx" },
      { status: "A", label: "已添加", path: "src/new.ts" },
      { status: "D", label: "已删除", path: "old.txt" },
      { status: "?", label: "未跟踪", path: "scratch.txt" },
      { status: "R", label: "已重命名", path: "src/new-name.ts", oldPath: "src/old-name.ts" }
    ]);
  });

  it("parses branch entries and filters remote HEAD refs", () => {
    const output = [
      "refs/heads/main\tmain\t*\tabc1234\t2 hours ago",
      "refs/heads/feature/git\tfeature/git\t\tdef5678\t3 days ago",
      "refs/remotes/origin/HEAD\torigin/HEAD\t\tabc1234\t2 hours ago",
      "refs/remotes/origin/main\torigin/main\t\tabc1234\t2 hours ago"
    ].join("\n");

    expect(parseBranchList(output)).toEqual([
      { name: "main", kind: "local", current: true, commit: "abc1234", relativeTime: "2 hours ago" },
      { name: "feature/git", kind: "local", current: false, commit: "def5678", relativeTime: "3 days ago" },
      { name: "origin/main", kind: "remote", current: false, commit: "abc1234", relativeTime: "2 hours ago" }
    ]);
  });

  it("parses stash list entries", () => {
    const output = [
      "stash@{0}\tabc123456789\t5 minutes ago\tWIP on main: abc1234 work",
      "stash@{1}\tdef567812345\t2 days ago\tOn feature: scratch"
    ].join("\n");

    expect(parseStashList(output)).toEqual([
      { ref: "stash@{0}", commit: "abc123456789", relativeTime: "5 minutes ago", message: "WIP on main: abc1234 work" },
      { ref: "stash@{1}", commit: "def567812345", relativeTime: "2 days ago", message: "On feature: scratch" }
    ]);
  });

  it("parses unified diff hunks into side-by-side rows", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,4 +1,5 @@",
      " title",
      "-old value",
      "+new value",
      "+extra value",
      " tail"
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual({
      kind: "text",
      rows: [
        { type: "context", oldLineNumber: 1, newLineNumber: 1, oldText: "title", newText: "title" },
        { type: "modify", oldLineNumber: 2, newLineNumber: 2, oldText: "old value", newText: "new value" },
        { type: "add", newLineNumber: 3, newText: "extra value" },
        { type: "context", oldLineNumber: 3, newLineNumber: 4, oldText: "tail", newText: "tail" }
      ]
    });
  });

  it("detects binary diffs", () => {
    expect(parseUnifiedDiff("Binary files a/logo.png and b/logo.png differ")).toEqual({
      kind: "binary",
      rows: []
    });
  });

  it("runs git status in a Windows session cwd", async () => {
    const spawn = createSpawnMock({ stdout: " M README.md\0" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });

    await expect(service.getStatus("run-1")).resolves.toEqual({
      cwd: "C:\\work\\repo",
      clean: false,
      files: [{ status: "M", label: "已修改", path: "README.md" }]
    });
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain=v1", "-z"],
      expect.objectContaining({ cwd: "C:\\work\\repo", windowsHide: true })
    );
  });

  it("runs git status through wsl.exe for WSL sessions", async () => {
    const spawn = createSpawnMock({ stdout: "" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "wsl",
        cwd: "/home/me/project",
        wslDistro: "Ubuntu-24.04"
      }),
      sessionStore: {},
      spawn
    });

    await expect(service.getStatus("run-1")).resolves.toEqual({
      cwd: "/home/me/project",
      clean: true,
      files: []
    });
    expect(spawn).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", "Ubuntu-24.04", "--cd", "/home/me/project", "--exec", "git", "status", "--porcelain=v1", "-z"],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it("runs git status over SSH with the saved secret", async () => {
    const client = createSshClientMock({ stdout: "?? remote.txt\0" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "ssh",
        cwd: "/srv/app",
        sshConfig: {
          host: "example.com",
          username: "deploy",
          encryptedSecret: "ciphertext"
        }
      }),
      sessionStore: { decryptSecret: vi.fn(() => "secret") },
      clientFactory: () => client
    });

    await expect(service.getStatus("run-1")).resolves.toEqual({
      cwd: "/srv/app",
      clean: false,
      files: [{ status: "?", label: "未跟踪", path: "remote.txt" }]
    });
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "example.com",
      username: "deploy",
      password: "secret"
    }));
    expect(client.exec).toHaveBeenCalledWith(
      "cd '/srv/app' && git 'status' '--porcelain=v1' '-z'",
      expect.any(Function)
    );
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("runs git diff in a Windows session cwd", async () => {
    const spawn = createSpawnMock({
      stdout: [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-old",
        "+new"
      ].join("\n")
    });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });

    await expect(service.getDiff("run-1", { status: "M", path: "README.md" })).resolves.toEqual({
      cwd: "C:\\work\\repo",
      path: "README.md",
      oldPath: undefined,
      status: "M",
      kind: "text",
      rows: [{ type: "modify", oldLineNumber: 1, newLineNumber: 1, oldText: "old", newText: "new" }]
    });
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["diff", "--no-color", "--find-renames", "HEAD", "--", "README.md"],
      expect.objectContaining({ cwd: "C:\\work\\repo", windowsHide: true })
    );
  });

  it("runs git diff through wsl.exe for WSL sessions", async () => {
    const spawn = createSpawnMock({ stdout: "" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "wsl",
        cwd: "/home/me/project",
        wslDistro: "Ubuntu-24.04"
      }),
      sessionStore: {},
      spawn
    });

    await expect(service.getDiff("run-1", { status: "D", path: "old.txt" })).resolves.toEqual({
      cwd: "/home/me/project",
      path: "old.txt",
      oldPath: undefined,
      status: "D",
      kind: "text",
      rows: []
    });
    expect(spawn).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", "Ubuntu-24.04", "--cd", "/home/me/project", "--exec", "git", "diff", "--no-color", "--find-renames", "HEAD", "--", "old.txt"],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it("runs git diff over SSH with the saved secret", async () => {
    const client = createSshClientMock({
      stdout: [
        "diff --git a/app.js b/app.js",
        "--- a/app.js",
        "+++ b/app.js",
        "@@ -1 +1 @@",
        "-old",
        "+new"
      ].join("\n")
    });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "ssh",
        cwd: "/srv/app",
        sshConfig: {
          host: "example.com",
          username: "deploy",
          encryptedSecret: "ciphertext"
        }
      }),
      sessionStore: { decryptSecret: vi.fn(() => "secret") },
      clientFactory: () => client
    });

    await expect(service.getDiff("run-1", { status: "M", path: "app.js" })).resolves.toMatchObject({
      cwd: "/srv/app",
      path: "app.js",
      kind: "text",
      rows: [{ type: "modify", oldLineNumber: 1, newLineNumber: 1, oldText: "old", newText: "new" }]
    });
    expect(client.exec).toHaveBeenCalledWith(
      "cd '/srv/app' && git 'diff' '--no-color' '--find-renames' 'HEAD' '--' 'app.js'",
      expect.any(Function)
    );
  });

  it("builds an added-file diff for untracked files", async () => {
    const spawn = createSpawnMock({
      code: 1,
      stdout: [
        "diff --git a/dev/null b/new.txt",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+first",
        "+second"
      ].join("\n")
    });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });

    await expect(service.getDiff("run-1", { status: "?", path: "new.txt" })).resolves.toEqual({
      cwd: "C:\\work\\repo",
      path: "new.txt",
      oldPath: undefined,
      status: "?",
      kind: "text",
      rows: [
        { type: "add", newLineNumber: 1, newText: "first" },
        { type: "add", newLineNumber: 2, newText: "second" }
      ]
    });
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["diff", "--no-color", "--no-index", "--", "/dev/null", "new.txt"],
      expect.objectContaining({ cwd: "C:\\work\\repo", windowsHide: true })
    );
  });

  it("lists branches in a Windows session cwd", async () => {
    const spawn = createSpawnMock({ stdout: "refs/heads/main\tmain\t*\tabc1234\t2 hours ago\n" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });

    await expect(service.getBranches("run-1")).resolves.toEqual({
      cwd: "C:\\work\\repo",
      branches: [{ name: "main", kind: "local", current: true, commit: "abc1234", relativeTime: "2 hours ago" }]
    });
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["for-each-ref", expect.stringContaining("--format="), "refs/heads", "refs/remotes"],
      expect.objectContaining({ cwd: "C:\\work\\repo", windowsHide: true })
    );
  });

  it("lists branches through wsl.exe --exec for WSL sessions", async () => {
    const spawn = createSpawnMock({ stdout: "refs/heads/main\tmain\t*\tabc1234\t2 hours ago\n" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "wsl",
        cwd: "/home/me/project",
        wslDistro: "Ubuntu-24.04"
      }),
      sessionStore: {},
      spawn
    });

    await expect(service.getBranches("run-1")).resolves.toEqual({
      cwd: "/home/me/project",
      branches: [{ name: "main", kind: "local", current: true, commit: "abc1234", relativeTime: "2 hours ago" }]
    });
    expect(spawn).toHaveBeenCalledWith(
      "wsl.exe",
      [
        "-d",
        "Ubuntu-24.04",
        "--cd",
        "/home/me/project",
        "--exec",
        "git",
        "for-each-ref",
        expect.stringContaining("--format=%(refname)"),
        "refs/heads",
        "refs/remotes"
      ],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it("checks out local and remote branches", async () => {
    const spawn = createSpawnSequenceMock([
      { stdout: "Switched to branch 'feature'\n" },
      { stdout: "" },
      { stdout: "refs/heads/feature\tfeature\t*\tabc1234\t1 minute ago\n" },
      { stdout: "branch 'main' set up to track 'origin/main'\n" },
      { stdout: "" },
      { stdout: "refs/heads/main\tmain\t*\tabc1234\t1 minute ago\n" }
    ]);
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });

    await expect(service.checkoutBranch("run-1", { kind: "local", name: "feature" })).resolves.toMatchObject({ ok: true });
    await expect(service.checkoutBranch("run-1", { kind: "remote", name: "origin/main" })).resolves.toMatchObject({ ok: true });
    expect(spawn.calls[0]).toMatchObject({ command: "git", args: ["checkout", "feature"] });
    expect(spawn.calls[3]).toMatchObject({ command: "git", args: ["checkout", "--track", "origin/main"] });
  });

  it("runs stash operations in Windows and WSL sessions", async () => {
    const windowsSpawn = createSpawnMock({ stdout: "Saved working directory and index state WIP\n" });
    const windowsService = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn: windowsSpawn
    });
    await expect(windowsService.stashChanges("run-1")).resolves.toMatchObject({ ok: true });
    expect(windowsSpawn).toHaveBeenCalledWith(
      "git",
      ["stash", "push", "-u"],
      expect.objectContaining({ cwd: "C:\\work\\repo", windowsHide: true })
    );

    const wslSpawn = createSpawnMock({ stdout: "" });
    const wslService = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", cwd: "/home/me/project", wslDistro: "Ubuntu-24.04" }),
      sessionStore: {},
      spawn: wslSpawn
    });
    await expect(wslService.applyStash("run-1", "stash@{0}")).resolves.toMatchObject({ ok: true });
    await expect(wslService.popStash("run-1", "stash@{1}")).resolves.toMatchObject({ ok: true });
    expect(wslSpawn.calls[0]).toMatchObject({
      command: "wsl.exe",
      args: ["-d", "Ubuntu-24.04", "--cd", "/home/me/project", "--exec", "git", "stash", "apply", "stash@{0}"]
    });
    expect(wslSpawn.calls[1]).toMatchObject({
      command: "wsl.exe",
      args: ["-d", "Ubuntu-24.04", "--cd", "/home/me/project", "--exec", "git", "stash", "pop", "stash@{1}"]
    });
  });

  it("runs branch, stash, and revert operations over SSH", async () => {
    const client = createSshClientMock({ stdout: "" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({
        id: "run-1",
        type: "ssh",
        cwd: "/srv/app",
        sshConfig: { host: "example.com", username: "deploy", encryptedSecret: "ciphertext" }
      }),
      sessionStore: { decryptSecret: vi.fn(() => "secret") },
      clientFactory: () => client
    });

    await expect(service.stashChanges("run-1")).resolves.toMatchObject({ ok: true });
    await expect(service.revertFile("run-1", { status: "?", path: "scratch.txt" })).resolves.toMatchObject({ ok: true });
    expect(client.exec).toHaveBeenNthCalledWith(
      1,
      "cd '/srv/app' && git 'stash' 'push' '-u'",
      expect.any(Function)
    );
    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      "cd '/srv/app' && git 'clean' '-f' '--' 'scratch.txt'",
      expect.any(Function)
    );
  });

  it("reverts tracked, untracked, and renamed files", async () => {
    const spawn = createSpawnMock({ stdout: "" });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn
    });

    await expect(service.revertFile("run-1", { status: "M", path: "src/App.tsx" })).resolves.toMatchObject({ ok: true });
    await expect(service.revertFile("run-1", { status: "?", path: "scratch.txt" })).resolves.toMatchObject({ ok: true });
    await expect(service.revertFile("run-1", { status: "R", path: "new-name.ts", oldPath: "old-name.ts" })).resolves.toMatchObject({ ok: true });
    expect(spawn.calls[0]).toMatchObject({ command: "git", args: ["restore", "--staged", "--worktree", "--", "src/App.tsx"] });
    expect(spawn.calls[1]).toMatchObject({ command: "git", args: ["clean", "-f", "--", "scratch.txt"] });
    expect(spawn.calls[2]).toMatchObject({ command: "git", args: ["restore", "--staged", "--worktree", "--", "new-name.ts", "old-name.ts"] });
  });

  it("rejects invalid stash refs and repository paths", async () => {
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work\\repo" }),
      sessionStore: {},
      spawn: createSpawnMock()
    });

    await expect(service.applyStash("run-1", "stash@{x}")).rejects.toThrow("stash reference");
    await expect(service.popStash("run-1", "main")).rejects.toThrow("stash reference");
    await expect(service.revertFile("run-1", { status: "M", path: "../secret.txt" })).rejects.toThrow("repository-relative path");
    await expect(service.revertFile("run-1", { status: "M", path: "C:\\secret.txt" })).rejects.toThrow("repository-relative path");
    await expect(service.revertFile("run-1", { status: "M", path: "bad\0path" })).rejects.toThrow("repository-relative path");
  });

  it("rejects missing sessions and failed git commands", async () => {
    const missingService = createGitStatusService({
      terminalManager: createTerminalManager(undefined),
      sessionStore: {}
    });
    await expect(missingService.getStatus("run-1")).rejects.toThrow("Session is not running.");

    const spawn = createSpawnMock({ stderr: "fatal: not a git repository", code: 128 });
    const service = createGitStatusService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: "C:\\work" }),
      sessionStore: {},
      spawn
    });
    await expect(service.getStatus("run-1")).rejects.toThrow("not a git repository");
    await expect(service.getDiff("run-1", { status: "M", path: "README.md" })).rejects.toThrow("not a git repository");
  });
});
