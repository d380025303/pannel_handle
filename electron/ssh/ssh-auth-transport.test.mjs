import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
const { createSshAgentTransport } = createRequire(import.meta.url)("./ssh-agent-transport.cjs");

function fixture() {
  const stream = new EventEmitter(); stream.stderr = new EventEmitter();
  stream.write = vi.fn(); stream.end = vi.fn(); stream.signal = vi.fn(); stream.setWindow = vi.fn();
  const client = new EventEmitter(); client.end = vi.fn();
  client.exec = vi.fn((_command, _options, callback) => callback(null, stream));
  const runtime = { connectClient: vi.fn(async () => client) };
  return { stream, client, runtime, transport: createSshAgentTransport({ sshSessionRuntime: runtime }) };
}

it("creates an SSH PTY for authentication and preserves its exit status", async () => {
  const f = fixture();
  const term = await f.transport.createInteractiveTransport("one", { command: "login-command", actionName: "OpenCode login" });
  expect(f.client.exec).toHaveBeenCalledWith("login-command", { pty: { term: "xterm-256color", cols: 100, rows: 24 } }, expect.any(Function));
  const data = vi.fn(); const exit = vi.fn(); term.onData(data); term.onExit(exit);
  f.stream.emit("data", Buffer.from("hello")); term.write("answer"); term.resize(80, 20);
  expect(data).toHaveBeenCalledWith("hello"); expect(f.stream.write).toHaveBeenCalledWith("answer");
  expect(f.stream.setWindow).toHaveBeenCalledWith(20, 80, 0, 0);
  f.stream.emit("exit", 0); f.stream.emit("close"); f.client.emit("close");
  expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 0, signal: undefined, reason: "remote-exit" });
  expect(f.client.end).toHaveBeenCalledOnce();
});

it("reports a disconnect without an exit status as failure", async () => {
  const f = fixture(); const term = await f.transport.createInteractiveTransport("one", { command: "login" });
  const exit = vi.fn(); term.onExit(exit); f.client.emit("close");
  expect(exit).toHaveBeenCalledWith({ exitCode: null, signal: null, reason: "connection-close" });
});

it("does not launch the command when cancelled during SSH connection setup", async () => {
  const f = fixture(); let resolve;
  f.runtime.connectClient = vi.fn(() => new Promise(done => { resolve = done; }));
  const controller = new AbortController();
  const pending = f.transport.createInteractiveTransport("one", { command: "login", signal: controller.signal });
  controller.abort(); resolve(f.client);
  await expect(pending).rejects.toThrow("已取消");
  expect(f.client.exec).not.toHaveBeenCalled(); expect(f.client.end).toHaveBeenCalledOnce();
});

it("terminates a cancelled authentication channel", async () => {
  const f = fixture(); const term = await f.transport.createInteractiveTransport("one", { command: "login" });
  const exit = vi.fn(); term.onExit(exit); term.kill(); f.stream.emit("close");
  expect(f.stream.signal).toHaveBeenCalledWith("TERM"); expect(f.stream.end).toHaveBeenCalledOnce();
  expect(exit).not.toHaveBeenCalled();
});

const utf8Text = "中文🚀";
const utf8Bytes = Buffer.from(utf8Text);
for (const channel of ["stdout", "stderr"]) {
  for (let split = 1; split < utf8Bytes.length; split += 1) {
    it(`preserves UTF-8 on ${channel} split at byte ${split}`, async () => {
      const f = fixture();
      const term = await f.transport.createInteractiveTransport("one", { command: "login" });
      const chunks = []; term.onData(text => chunks.push(text));
      const source = channel === "stdout" ? f.stream : f.stream.stderr;
      source.emit("data", utf8Bytes.subarray(0, split));
      source.emit("data", utf8Bytes.subarray(split));
      f.stream.emit("close");
      expect(chunks.join("")).toBe(utf8Text);
    });
  }

  it(`preserves byte-by-byte UTF-8 on ${channel}`, async () => {
    const f = fixture();
    const term = await f.transport.createInteractiveTransport("one", { command: "login" });
    const chunks = []; term.onData(text => chunks.push(text));
    const source = channel === "stdout" ? f.stream : f.stream.stderr;
    for (const byte of utf8Bytes) source.emit("data", Buffer.from([byte]));
    f.stream.emit("close");
    expect(chunks.join("")).toBe(utf8Text);
  });
}

it("decodes interleaved stdout and stderr independently", async () => {
  const f = fixture();
  const term = await f.transport.createInteractiveTransport("one", { command: "login" });
  const chunks = []; term.onData(text => chunks.push(text));
  const stderr = Buffer.from("登录🌟");
  for (let i = 0; i < utf8Bytes.length; i += 1) {
    f.stream.emit("data", utf8Bytes.subarray(i, i + 1));
    f.stream.stderr.emit("data", stderr.subarray(i, i + 1));
  }
  f.stream.emit("close");
  expect(chunks).toEqual(["中", "登", "文", "录", "🚀", "🌟"]);
});

for (const reason of ["remote-exit", "connection-close", "transport-error"]) {
  it(`flushes incomplete tails once before ${reason}`, async () => {
    const f = fixture();
    const term = await f.transport.createInteractiveTransport("one", { command: "login" });
    const events = []; term.onData(text => events.push(text));
    const exit = vi.fn(value => events.push(value.reason)); term.onExit(exit);
    f.stream.emit("data", Buffer.from("中").subarray(0, 2));
    f.stream.stderr.emit("data", Buffer.from("🚀").subarray(0, 3));
    expect(events).toEqual([]);
    if (reason === "remote-exit") f.stream.emit("close");
    else if (reason === "connection-close") f.client.emit("close");
    else f.stream.emit("error", new Error("disconnected"));
    f.stream.emit("close"); f.client.emit("close");
    f.client.emit("error", new Error("late error"));
    f.stream.emit("data", Buffer.from("late stdout"));
    f.stream.stderr.emit("data", Buffer.from("late stderr"));
    expect(events).toEqual(["�", "�", reason]);
    expect(exit).toHaveBeenCalledOnce();
    expect(f.client.end).toHaveBeenCalledOnce();
  });
}
