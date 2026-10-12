import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import http from "node:http";
import { Duplex } from "node:stream";
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
  function createCommandRuntime(emitOutput) {
    const client = new EventEmitter();
    client.end = vi.fn();
    const streams = [];
    client.exec = vi.fn((_command, done) => {
      const stream = createStream();
      stream.close = vi.fn(() => stream.emit("close", 0));
      streams.push(stream);
      done(null, stream);
      queueMicrotask(() => emitOutput(stream));
    });
    const runtime = { connectClient: vi.fn(async () => client) };
    return { client, streams, runtime };
  }

  const unicodeOutput = "中文🚀";
  const unicodeBytes = Buffer.from(unicodeOutput);
  const chunkings = [
    ...Array.from({ length: unicodeBytes.length - 1 }, (_, index) => [unicodeBytes.subarray(0, index + 1), unicodeBytes.subarray(index + 1)]),
    Array.from(unicodeBytes, byte => Buffer.from([byte]))
  ];

  it.each(chunkings.map((chunks, index) => ({ chunks, index })))("decodes stdout and stderr across UTF-8 split $index", async ({ chunks }) => {
    let exitCode = 0;
    const { runtime, client } = createCommandRuntime(stream => {
      for (const chunk of chunks) {
        stream.emit("data", chunk);
        stream.stderr.emit("data", chunk);
      }
      stream.emit("close", exitCode);
    });
    const commandClient = createSshAgentTransport({ sshSessionRuntime: runtime }).createReusableCommandClient("ssh-1");
    await expect(commandClient.exec("one")).resolves.toBe(unicodeOutput);
    await expect(commandClient.exec("two")).resolves.toBe(unicodeOutput);
    expect(runtime.connectClient).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
    exitCode = 1;
    await expect(commandClient.exec("fail")).rejects.toThrow(unicodeOutput);
    expect(client.end).toHaveBeenCalledOnce();
    commandClient.close();
  });

  it.each([0, 1])("flushes incomplete UTF-8 tails on exit %i", async exitCode => {
    const { runtime } = createCommandRuntime(stream => {
      stream.emit("data", Buffer.from([0xe4]));
      stream.stderr.emit("data", Buffer.from([0xf0, 0x9f]));
      stream.emit("close", exitCode);
    });
    const commandClient = createSshAgentTransport({ sshSessionRuntime: runtime }).createReusableCommandClient("ssh-1");
    if (exitCode === 0) await expect(commandClient.exec("tail")).resolves.toBe("\ufffd");
    else await expect(commandClient.exec("tail")).rejects.toThrow("\ufffd");
    commandClient.close();
  });

  it.each([
    { chunks: Array.from(unicodeBytes, byte => Buffer.from([byte])), limit: unicodeBytes.length, succeeds: true },
    { chunks: Array.from(unicodeBytes, byte => Buffer.from([byte])), limit: unicodeBytes.length - 1, succeeds: false },
    { chunks: [Buffer.from([0xe4])], limit: 2, succeeds: false }
  ])("enforces the output byte limit including decoder tails: $limit / $succeeds", async ({ chunks, limit, succeeds }) => {
    const { runtime, streams, client } = createCommandRuntime(stream => {
      for (const chunk of chunks) stream.emit("data", chunk);
      stream.emit("close", 0);
    });
    const commandClient = createSshAgentTransport({ sshSessionRuntime: runtime }).createReusableCommandClient("ssh-1", {
      maxOutputBytes: limit, outputLimitMessage: "Output too large."
    });
    if (succeeds) {
      await expect(commandClient.exec("limit")).resolves.toBe(unicodeOutput);
      expect(streams[0].close).not.toHaveBeenCalled();
      expect(client.end).not.toHaveBeenCalled();
    } else {
      await expect(commandClient.exec("limit")).rejects.toThrow("Output too large.");
      expect(streams[0].close).toHaveBeenCalledOnce();
      expect(client.end).toHaveBeenCalledOnce();
    }
    commandClient.close();
  });

  function createHttpRuntime(response) {
    const channels = [];
    const client = {
      forwardOut: vi.fn((_sourceHost, _sourcePort, _host, _port, done) => {
        let answered = false;
        const channel = new Duplex({
          read() {},
          final(callback) {
            this.push(null);
            callback();
          },
          write(_chunk, _encoding, callback) {
            callback();
            if (!answered) {
              answered = true;
              setImmediate(() => this.push(response));
            }
          }
        });
        channels.push(channel);
        done(null, channel);
      }),
      end: vi.fn()
    };
    return { channels, client, runtime: { connectClient: vi.fn(async () => client) } };
  }

  it("closes completed keep-alive HTTP channels and opens a new channel for the next request", async () => {
    const { channels, client, runtime } = createHttpRuntime("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}");
    const forwarder = await createSshAgentTransport({ sshSessionRuntime: runtime }).createHttpForwarder("ssh-1", 48123);
    const request = () => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: 48123, agent: forwarder.agent }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
    try {
      await expect(request()).resolves.toBe("{}");
      await new Promise(resolve => setImmediate(resolve));
      expect(channels[0].destroyed).toBe(true);
      await expect(request()).resolves.toBe("{}");
      await new Promise(resolve => setImmediate(resolve));
      expect(client.forwardOut).toHaveBeenCalledTimes(2);
      expect(channels.every(channel => channel.destroyed)).toBe(true);
      expect(runtime.connectClient).toHaveBeenCalledTimes(1);
    } finally { forwarder.close(); }
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("keeps an active SSE channel open until the forwarder is closed", async () => {
    const { channels, client, runtime } = createHttpRuntime("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\ndata: {}\n\n");
    const forwarder = await createSshAgentTransport({ sshSessionRuntime: runtime }).createHttpForwarder("ssh-1", 48123);
    let request;
    try {
      const response = await new Promise((resolve, reject) => {
        request = http.get({ host: "127.0.0.1", port: 48123, agent: forwarder.agent }, res => {
          res.on("error", () => {});
          res.once("data", () => resolve(res));
        }).on("error", reject);
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(response.complete).toBe(false);
      expect(channels[0].destroyed).toBe(false);
      const closed = new Promise(resolve => channels[0].once("close", resolve));
      forwarder.close();
      await closed;
      expect(channels[0].destroyed).toBe(true);
      expect(client.end).toHaveBeenCalledOnce();
    } finally {
      request?.destroy();
      if (!channels[0]?.destroyed) forwarder.close();
    }
  });

  it("forwards CodeBuddy HTTP sockets to the remote loopback port", async () => {
    const socket = new EventEmitter();
    socket.destroy = vi.fn();
    const client = { forwardOut: vi.fn((_sourceHost, _sourcePort, _host, _port, done) => done(null, socket)), end: vi.fn() };
    const runtime = { connectClient: vi.fn(async () => client) };
    const forwarder = await createSshAgentTransport({ sshSessionRuntime: runtime }).createHttpForwarder("ssh-1", 48123);
    const received = await new Promise((resolve, reject) => forwarder.agent.createConnection({}, (error, stream) => error ? reject(error) : resolve(stream)));
    expect(received).toBe(socket);
    expect(client.forwardOut).toHaveBeenCalledWith("127.0.0.1", 0, "127.0.0.1", 48123, expect.any(Function));
    forwarder.close();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("opens a remote loopback port for the local OpenCode question server", async () => {
    const client = new EventEmitter();
    client.forwardIn = vi.fn((_host, _port, done) => done(null, 54210));
    client.unforwardIn = vi.fn((_host, _port, done) => done());
    client.end = vi.fn();
    const runtime = { connectClient: vi.fn(async () => client) };
    const forwarder = await createSshAgentTransport({ sshSessionRuntime: runtime })
      .createReverseHttpForwarder("ssh-1", 54211);
    expect(forwarder.url).toBe("http://127.0.0.1:54210");
    expect(client.forwardIn).toHaveBeenCalledWith("127.0.0.1", 0, expect.any(Function));
    forwarder.close();
    expect(client.unforwardIn).toHaveBeenCalledWith("127.0.0.1", 54210, expect.any(Function));
    expect(client.end).toHaveBeenCalledOnce();
  });

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
