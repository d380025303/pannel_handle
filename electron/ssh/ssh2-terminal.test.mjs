import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSsh2Terminal, buildEnvironmentCommand } = require("./ssh2-terminal.cjs");

function createFakeStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.writes = [];
  stream.windows = [];
  stream.ended = false;
  stream.write = vi.fn((data) => stream.writes.push(data));
  stream.end = vi.fn(() => {
    stream.ended = true;
  });
  stream.setWindow = vi.fn((rows, cols, height, width) => {
    stream.windows.push([rows, cols, height, width]);
  });
  return stream;
}

function createFakeClient(stream = createFakeStream()) {
  const client = new EventEmitter();
  client.connect = vi.fn((config) => {
    client.config = config;
  });
  client.shell = vi.fn((_options, callback) => {
    callback(undefined, stream);
  });
  client.end = vi.fn();
  return { client, stream };
}

describe("ssh2 terminal", () => {
  function captureOutput() {
    const { client, stream } = createFakeClient();
    const term = createSsh2Terminal({
      connectionConfig: { host: "example.com" },
      clientFactory: () => client
    });
    const data = [];
    term.onData((chunk) => data.push(chunk));
    client.emit("ready");
    return { client, stream, term, data };
  }

  it.each(["stdout", "stderr"])("preserves Chinese and emoji across every byte partition on %s", (channel) => {
    const original = "中文😀";
    const bytes = Buffer.from(original);
    for (let partition = 0; partition < 2 ** (bytes.length - 1); partition++) {
      const { stream, data } = captureOutput();
      const output = channel === "stdout" ? stream : stream.stderr;
      let start = 0;
      for (let boundary = 1; boundary < bytes.length; boundary++) {
        if (partition & (1 << (boundary - 1))) {
          output.emit("data", bytes.subarray(start, boundary));
          start = boundary;
        }
      }
      output.emit("data", bytes.subarray(start));
      output.emit("end");
      stream.emit("close");
      expect(data.join(""), `partition ${partition}`).toBe(original);
    }
  });

  it("keeps decoding state independent when stdout and stderr interleave", () => {
    const { stream, data } = captureOutput();
    const stdout = Buffer.from("中文😀");
    const stderr = Buffer.from("错误🚀");
    for (let index = 0; index < stdout.length; index++) {
      stream.emit("data", stdout.subarray(index, index + 1));
      stream.stderr.emit("data", stderr.subarray(index, index + 1));
    }
    stream.emit("end");
    stream.stderr.emit("end");
    expect(data).toEqual(["中", "错", "文", "误", "😀", "🚀"]);
  });

  it.each(["stdout", "stderr"])("flushes incomplete %s bytes once at end before exit", (channel) => {
    const { client, stream, term, data } = captureOutput();
    const output = channel === "stdout" ? stream : stream.stderr;
    term.onExit(() => data.push("exit"));
    output.emit("data", Buffer.from("😀").subarray(0, 2));
    expect(data).toEqual([]);
    output.emit("end");
    expect(data).toEqual(["�"]);
    output.emit("close");
    stream.emit("close");
    client.emit("close");
    expect(data).toEqual(["�", "exit"]);
  });

  it.each(["stream", "client"])("flushes both channels before exit on %s close without end", (source) => {
    const { client, stream, term, data } = captureOutput();
    term.onExit(() => data.push("exit"));
    stream.emit("data", Buffer.from("中").subarray(0, 1));
    stream.stderr.emit("data", Buffer.from("😀").subarray(0, 2));
    (source === "stream" ? stream : client).emit("close");
    stream.emit("close");
    client.emit("close");
    expect(data).toEqual(["�", "�", "exit"]);
  });

  it("opens an interactive shell and forwards data, writes, and resizes", () => {
    const { client, stream } = createFakeClient();
    const term = createSsh2Terminal({
      connectionConfig: { host: "example.com" },
      cols: 120,
      rows: 40,
      clientFactory: () => client
    });
    const data = [];
    const statuses = [];
    term.onData((chunk) => data.push(chunk));
    term.onStatus(({ status }) => statuses.push(status));
    term.write("queued");

    client.emit("ready");
    stream.emit("data", Buffer.from("ready"));
    term.write("typed");
    term.resize(100, 30);

    expect(client.connect).toHaveBeenCalledWith({ host: "example.com" });
    expect(client.shell).toHaveBeenCalledWith({
      term: "xterm-256color",
      cols: 120,
      rows: 40
    }, expect.any(Function));
    expect(data).toEqual(["ready"]);
    expect(statuses).toEqual(["connected"]);
    expect(stream.writes).toEqual(["queued", "typed"]);
    expect(stream.windows).toEqual([[30, 100, 0, 0]]);
  });

  it("answers keyboard-interactive prompts with the saved secret", () => {
    const { client } = createFakeClient();
    createSsh2Terminal({
      connectionConfig: {
        host: "example.com",
        password: "plain-secret"
      },
      clientFactory: () => client
    });
    const finish = vi.fn();

    client.emit("keyboard-interactive", "", "", "", [
      { prompt: "Password: ", echo: false },
      { prompt: "Token: ", echo: true }
    ], finish);

    expect(finish).toHaveBeenCalledWith(["plain-secret", ""]);
  });

  it("emits a single exit event when the shell closes", () => {
    const { client, stream } = createFakeClient();
    const term = createSsh2Terminal({
      connectionConfig: { host: "example.com" },
      clientFactory: () => client
    });
    const exits = [];
    term.onExit((event) => exits.push(event));

    client.emit("ready");
    stream.emit("exit", 7);
    stream.emit("close");
    client.emit("close");

    expect(exits).toEqual([{ exitCode: 7, reason: "remote-exit", retryable: false }]);
    expect(client.end).toHaveBeenCalled();
  });

  it("marks socket failures as retryable transport exits", () => {
    const { client } = createFakeClient();
    const term = createSsh2Terminal({
      connectionConfig: { host: "example.com" },
      clientFactory: () => client
    });
    const exits = [];
    term.onExit((event) => exits.push(event));
    const error = Object.assign(new Error("read ECONNRESET"), { level: "client-socket" });

    client.emit("error", error);

    expect(exits).toEqual([{
      exitCode: 1,
      reason: "connection-error",
      retryable: true,
      message: "read ECONNRESET"
    }]);
  });
});


describe("SSH environment injection", () => {
  it("uses exec with PTY and never types configuration into the shell", () => {
    const { client, stream } = createFakeClient();
    client.exec = vi.fn((_command, _options, callback) => callback(undefined, stream));
    const term = createSsh2Terminal({ environment: { FOO: "a b", EMPTY: "" }, connectionConfig: { host: "example.com" }, clientFactory: () => client });
    term.write("user input");
    client.emit("ready");
    expect(client.shell).not.toHaveBeenCalled();
    expect(client.exec).toHaveBeenCalledWith("exec /usr/bin/env 'FOO=a b' 'EMPTY=' /bin/bash -il", { pty: { term: "xterm-256color", cols: 100, rows: 30 } }, expect.any(Function));
    expect(stream.writes).toEqual(["user input"]);
    term.resize(120, 40);
    expect(stream.windows).toEqual([[40, 120, 0, 0]]);
  });
  it("quotes shell metacharacters as literal values", () => {
    const command = buildEnvironmentCommand({ FOO: "$(whoami); `id`\n'a'" });
    expect(command).toContain("'FOO=$(whoami); `id`\n");
    expect(command).toContain("'\\''a'\\''");
  });
});
