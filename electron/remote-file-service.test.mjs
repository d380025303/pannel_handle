import { describe, expect, it, vi } from "vitest";
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

  it("rejects non-SSH sessions", async () => {
    const service = createRemoteFileService({
      terminalManager: createTerminalManager({ id: "run-1", type: "windows" }),
      sessionStore: createSessionStore(),
      sftpFactory: () => createSftpMock()
    });

    await expect(service.list("run-1", ".")).rejects.toThrow("Remote files are only available for SSH sessions.");
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
      content: "text"
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
});
