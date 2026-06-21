import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSsh2Terminal } = require("./ssh2-terminal.cjs");

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
  it("opens an interactive shell and forwards data, writes, and resizes", () => {
    const { client, stream } = createFakeClient();
    const term = createSsh2Terminal({
      connectionConfig: { host: "example.com" },
      cols: 120,
      rows: 40,
      clientFactory: () => client
    });
    const data = [];
    term.onData((chunk) => data.push(chunk));
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

    expect(exits).toEqual([{ exitCode: 7 }]);
    expect(client.end).toHaveBeenCalled();
  });
});
