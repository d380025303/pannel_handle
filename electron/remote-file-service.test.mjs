import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEXT_PREVIEW_LIMIT, createRemoteFileService } from "./remote-file-service.cjs";

function createTerminalManager(session) {
  return {
    getSession: vi.fn(() => session)
  };
}

function createSessionStore(secret = "plain-secret") {
  return {
    decryptSecret: vi.fn(() => secret)
  };
}

function createSftpMock(overrides = {}) {
  return {
    connect: vi.fn(),
    cwd: vi.fn(async () => "/home/deploy"),
    list: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 4 })),
    get: vi.fn(async () => Buffer.from("text")),
    put: vi.fn(),
    fastPut: vi.fn(),
    fastGet: vi.fn(),
    end: vi.fn(),
    ...overrides
  };
}

describe("remote-file-service", () => {
  it("connects with saved SSH password and lists files", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: {
        host: "example.com",
        username: "deploy",
        port: 2222,
        encryptedSecret: "ciphertext",
        extraArgs: []
      }
    };
    const sftp = createSftpMock({
      list: vi.fn(async () => [
        { name: "app.log", type: "-", size: 10, modifyTime: 1000 },
        { name: "var", type: "d", size: 0, modifyTime: 900 }
      ])
    });
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.list("run-1", "/home/deploy")).resolves.toEqual([
      expect.objectContaining({ name: "var", path: "/home/deploy/var", type: "directory" }),
      expect.objectContaining({ name: "app.log", path: "/home/deploy/app.log", type: "file" })
    ]);
    expect(sftp.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "example.com",
      username: "deploy",
      port: 2222,
      password: "plain-secret"
    }));
  });

  it("rejects missing sessions", async () => {
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(undefined),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock()
    });

    await expect(service.list("run-1", ".")).rejects.toThrow("Session is not running.");
  });

  it("lists Windows files with directories first", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const childDir = path.join(dir, "src");
    const childFile = path.join(dir, "readme.txt");
    fs.mkdirSync(childDir);
    fs.writeFileSync(childFile, "hello", "utf-8");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      await expect(service.getHome("run-1")).resolves.toBe(dir);
      await expect(service.list("run-1", dir)).resolves.toEqual([
        expect.objectContaining({ name: "src", path: childDir, type: "directory" }),
        expect.objectContaining({ name: "readme.txt", path: childFile, type: "file", size: 5 })
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews and writes Windows text files with conflict detection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-files-"));
    const filePath = path.join(dir, "note.txt");
    fs.writeFileSync(filePath, "text", "utf-8");
    try {
      const service = createRemoteFileService({
        terminalManager: createTerminalManager({ id: "run-1", type: "windows", cwd: dir }),
        sessionStore: createSessionStore(),
        sftpFactory: () => createSftpMock()
      });

      const preview = await service.readText("run-1", filePath);
      expect(preview).toEqual({
        kind: "text",
        size: 4,
        content: "text",
        version: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1"
      });

      await expect(service.writeText("run-1", filePath, "updated", preview.version)).resolves.toEqual({
        status: "saved",
        size: 7,
        version: "27eb5e51506c911f6fc4bb345c0d9db6f60415fceab7c18e1e9b862637415777"
      });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("updated");

      await expect(service.writeText("run-1", filePath, "again", preview.version)).resolves.toEqual({
        status: "conflict"
      });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("updated");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps WSL Linux paths to the distro UNC path", async () => {
    const readdir = vi.fn(async () => [
      { name: "app.js", isDirectory: () => false, isSymbolicLink: () => false }
    ]);
    const stat = vi.fn(async () => ({ size: 8, mtimeMs: 1234 }));
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "wsl", cwd: "/home/me/project", wslDistro: "Ubuntu-24.04" }),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock(),
      fsApi: {
        promises: {
          readdir,
          stat
        }
      }
    });

    await expect(service.getHome("run-1")).resolves.toBe("/home/me/project");
    await expect(service.list("run-1", "/home/me/project")).resolves.toEqual([
      expect.objectContaining({ name: "app.js", path: "/home/me/project/app.js", type: "file", size: 8 })
    ]);
    expect(readdir).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project", { withFileTypes: true });
    expect(stat).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project\\app.js");
  });

  it("returns preview states for text, binary, and oversized files", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.readText("run-1", "/tmp/a.txt")).resolves.toEqual({
      kind: "text",
      size: 4,
      content: "text",
      version: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1"
    });

    sftp.stat.mockResolvedValueOnce({ size: 3 });
    sftp.get.mockResolvedValueOnce(Buffer.from([0, 1, 2]));
    await expect(service.readText("run-1", "/tmp/bin")).resolves.toEqual({
      kind: "binary",
      size: 3
    });

    sftp.stat.mockResolvedValueOnce({ size: TEXT_PREVIEW_LIMIT + 1 });
    await expect(service.readText("run-1", "/tmp/large.log")).resolves.toEqual({
      kind: "too_large",
      size: TEXT_PREVIEW_LIMIT + 1,
      limit: TEXT_PREVIEW_LIMIT
    });
  });

  it("writes text when the expected content version still matches", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.writeText(
      "run-1",
      "/tmp/a.txt",
      "updated",
      "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1"
    )).resolves.toEqual({
      status: "saved",
      size: 7,
      version: "27eb5e51506c911f6fc4bb345c0d9db6f60415fceab7c18e1e9b862637415777"
    });
    expect(sftp.put).toHaveBeenCalledWith(Buffer.from("updated"), "/tmp/a.txt");
  });

  it("rejects a conflicting remote change without writing", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.writeText("run-1", "/tmp/a.txt", "updated", "stale")).resolves.toEqual({
      status: "conflict"
    });
    expect(sftp.put).not.toHaveBeenCalled();
  });

  it("rejects edited text over the preview limit", async () => {
    const session = {
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com", extraArgs: [] }
    };
    const sftp = createSftpMock();
    const service = createRemoteFileService({
      terminalManager: createTerminalManager(session),
      sessionStore: createSessionStore(),
      sftpFactory: () => sftp
    });

    await expect(service.writeText("run-1", "/tmp/a.txt", "x".repeat(TEXT_PREVIEW_LIMIT + 1), "version"))
      .rejects.toThrow("edit limit");
    expect(sftp.get).not.toHaveBeenCalled();
    expect(sftp.put).not.toHaveBeenCalled();
  });
});
