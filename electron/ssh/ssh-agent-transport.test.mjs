import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSshAgentTransport } = require("./ssh-agent-transport.cjs");

function createStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.writable = true;
  stream.write = vi.fn();
  stream.end = vi.fn();
  stream.signal = vi.fn();
  return stream;
}

describe("ssh-agent-transport", () => {
  it("owns the bidirectional stdio channel lifecycle", async () => {
    const stream = createStream();
    const client = { exec: vi.fn((_command, done) => done(null, stream)), end: vi.fn() };
    const runtime = { connectClient: vi.fn(async () => client) };
    const transport = await createSshAgentTransport({ sshSessionRuntime: runtime }).createStdioTransport("ssh-1");

    transport.write("hello\n");
    transport.close();

    expect(runtime.connectClient).toHaveBeenCalledWith("ssh-1", expect.objectContaining({ actionName: "Codex usage connection" }));
    expect(client.exec).toHaveBeenCalledWith("bash -lic 'exec codex app-server --stdio'", expect.any(Function));
    expect(stream.write).toHaveBeenCalledWith("hello\n");
    expect(stream.signal).toHaveBeenCalledWith("TERM");
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("reuses and explicitly closes a remote command client", async () => {
    const client = new EventEmitter();
    client.end = vi.fn();
    client.exec = vi.fn((_command, done) => {
      const stream = createStream();
      done(null, stream);
      queueMicrotask(() => { stream.emit("data", Buffer.from("ok")); stream.emit("close", 0); });
    });
    const runtime = { connectClient: vi.fn(async () => client) };
    const commandClient = createSshAgentTransport({ sshSessionRuntime: runtime })
      .createReusableCommandClient("ssh-1");

    await expect(commandClient.exec("one")).resolves.toBe("ok");
    await expect(commandClient.exec("two")).resolves.toBe("ok");
    commandClient.close();

    expect(runtime.connectClient).toHaveBeenCalledTimes(1);
    expect(client.exec).toHaveBeenCalledTimes(2);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
