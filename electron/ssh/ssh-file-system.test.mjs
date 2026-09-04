import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSshFileSystem } = require("./ssh-file-system.cjs");

describe("ssh-file-system", () => {
  it("caches SFTP clients by session and closes them on disconnect", async () => {
    const client = { list: vi.fn(async () => []), end: vi.fn() };
    const runtime = { createSftpClient: vi.fn(async () => client) };
    const fileSystem = createSshFileSystem({ sshSessionRuntime: runtime });

    await fileSystem.list("ssh-1", "/srv");
    await fileSystem.list("ssh-1", "/tmp");
    await fileSystem.disconnect("ssh-1");

    expect(runtime.createSftpClient).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("uses and closes a dedicated SFTP client for downloads", async () => {
    const client = {
      stat: vi.fn(async () => ({ size: 8 })),
      fastGet: vi.fn(async (_remote, _local, options) => options.step(8, 8, 8)),
      end: vi.fn()
    };
    const runtime = { createSftpClient: vi.fn(async (_sessionId, options) => options.sftp) };
    const fileSystem = createSshFileSystem({ sshSessionRuntime: runtime, sftpFactory: () => client });
    const progress = vi.fn();

    await fileSystem.downloadFile("download-1", "ssh-1", "/srv/a.bin", "C:\\tmp\\a.bin", { onProgress: progress });

    expect(client.fastGet).toHaveBeenCalledWith("/srv/a.bin", "C:\\tmp\\a.bin", expect.objectContaining({ step: expect.any(Function) }));
    expect(progress).toHaveBeenLastCalledWith(8, 8);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
