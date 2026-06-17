import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createGitStatusService, parsePorcelainStatus } = require("./git-status-service.cjs");

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
      { status: "M", label: "Modified", path: "src/App.tsx" },
      { status: "A", label: "Added", path: "src/new.ts" },
      { status: "D", label: "Deleted", path: "old.txt" },
      { status: "?", label: "Untracked", path: "scratch.txt" },
      { status: "R", label: "Renamed", path: "src/new-name.ts", oldPath: "src/old-name.ts" }
    ]);
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
      files: [{ status: "M", label: "Modified", path: "README.md" }]
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
      files: [{ status: "?", label: "Untracked", path: "remote.txt" }]
    });
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "example.com",
      username: "deploy",
      password: "secret"
    }));
    expect(client.exec).toHaveBeenCalledWith(
      "cd '/srv/app' && git status --porcelain=v1 -z",
      expect.any(Function)
    );
    expect(client.end).toHaveBeenCalledTimes(1);
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
  });
});
