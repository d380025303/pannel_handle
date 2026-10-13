import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const { createSshFileSystem } = require("./ssh-file-system.cjs");

describe("ssh-file-system", () => {
  function client(overrides = {}) {
    return { client: new EventEmitter(), list: vi.fn(async () => []), end: vi.fn(), ...overrides };
  }

  it("retries bounded reads with a fresh buffer after a connection failure", async () => {
    const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const source = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw error;
    })());
    const first = client({ createReadStream: vi.fn(() => source) });
    const next = client({ createReadStream: vi.fn(() => Readable.from([Buffer.from("complete")])),
      get: vi.fn(async () => Buffer.from("unlimited")) });
    const runtime = { createSftpClient: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    expect(await fs.get("s", "/a", { maxBytes: 16 })).toEqual(Buffer.from("complete"));
    expect(source.destroyed).toBe(true);
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(2);
    expect(await fs.get("s", "/a")).toEqual(Buffer.from("unlimited"));
    expect(next.get).toHaveBeenCalledWith("/a");
  });

  it("destroys failed bounded streams and propagates file errors without retrying", async () => {
    const error = Object.assign(new Error("Permission denied"), { code: 3 });
    const source = new Readable({ read() { this.destroy(error); } });
    const runtime = { createSftpClient: vi.fn(async () => client({ createReadStream: () => source })) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    await expect(fs.get("s", "/a", { maxBytes: 16 })).rejects.toBe(error);
    expect(source.destroyed).toBe(true);
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent connection attempts and reconnects after idle close", async () => {
    const first = client();
    const next = client();
    const runtime = { createSftpClient: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    await Promise.all([fs.list("s", "/a"), fs.list("s", "/b")]);
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(1);
    first.client.emit("close");
    await fs.list("s", "/c");
    first.client.emit("end");
    await fs.list("s", "/d");
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(2);
    expect(next.list).toHaveBeenCalledTimes(2);
  });

  it("retries a disconnected read once and does not replay interrupted writes", async () => {
    const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const first = client({ stat: vi.fn().mockRejectedValue(error) });
    const next = client({ stat: vi.fn().mockResolvedValue({ size: 4 }), put: vi.fn().mockRejectedValue(error) });
    const runtime = { createSftpClient: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    await expect(fs.stat("s", "/a")).resolves.toEqual({ size: 4 });
    await expect(fs.put("s", Buffer.from("text"), "/a")).rejects.toBe(error);
    expect(next.put).toHaveBeenCalledTimes(1);
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(2);
  });

  it("retries mutations only when no SFTP request could be sent", async () => {
    const first = client({ put: vi.fn().mockRejectedValue(new Error("put: No SFTP connection available")) });
    const next = client({ put: vi.fn().mockResolvedValue(undefined) });
    const runtime = { createSftpClient: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    await fs.put("s", Buffer.from("text"), "/a");
    expect(next.put).toHaveBeenCalledTimes(1);
  });

  it("stops after one retry and propagates ordinary file errors", async () => {
    const error = new Error("stat: No SFTP connection available");
    const runtime = { createSftpClient: vi.fn(async () => client({ stat: vi.fn().mockRejectedValue(error) })) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    await expect(fs.stat("s", "/a")).rejects.toBe(error);
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(2);
    const denied = Object.assign(new Error("Permission denied"), { code: 3 });
    runtime.createSftpClient.mockResolvedValue(client({ stat: vi.fn().mockRejectedValue(denied) }));
    await expect(fs.exists("s", "/a")).rejects.toBe(denied);
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(3);
  });

  it("does not fall back to deleting a file when directory removal loses connection", async () => {
    const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const sftp = client({ stat: vi.fn(async () => ({ isDirectory: true })), rmdir: vi.fn().mockRejectedValue(error), delete: vi.fn() });
    const fs = createSshFileSystem({ sshSessionRuntime: { createSftpClient: vi.fn(async () => sftp) } });
    await expect(fs.remove("s", "/dir")).rejects.toBe(error);
    expect(sftp.delete).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "shutdown"])("cancels pending connections on %s", async action => {
    let resolve;
    const sftp = client();
    const runtime = { createSftpClient: vi.fn(() => new Promise(done => { resolve = done; })) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    const result = expect(fs.list("s", "/a")).rejects.toThrow("canceled");
    await fs[action]("s");
    resolve(sftp);
    await result;
    expect(sftp.end).toHaveBeenCalledTimes(1);
    expect(sftp.list).not.toHaveBeenCalled();
  });

  it("allows another connection after a connection attempt fails", async () => {
    const runtime = { createSftpClient: vi.fn().mockRejectedValueOnce(new Error("connect failed")).mockResolvedValue(client()) };
    const fs = createSshFileSystem({ sshSessionRuntime: runtime });
    await expect(fs.list("s", "/a")).rejects.toThrow("connect failed");
    await fs.list("s", "/a");
    expect(runtime.createSftpClient).toHaveBeenCalledTimes(2);
  });
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
