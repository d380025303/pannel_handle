import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createGitStatusService, parsePorcelainStatus, parseUnifiedDiff } = require("./git-status-service.cjs");

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
      ["-d", "Ubuntu-24.04", "--cd", "/home/me/project", "git", "status", "--porcelain=v1", "-z"],
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
      ["-d", "Ubuntu-24.04", "--cd", "/home/me/project", "git", "diff", "--no-color", "--find-renames", "HEAD", "--", "old.txt"],
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
