import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createKnownHostStore } = require("../stores/known-host-store.cjs");
const {
  answerKeyboardInteractive,
  createSshSessionRuntime
} = require("./ssh-session-runtime.cjs");

function createClient() {
  const client = new EventEmitter();
  client.connect = vi.fn(() => queueMicrotask(() => client.emit("ready")));
  client.end = vi.fn();
  client.exec = vi.fn((_command, callback) => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    callback(undefined, stream);
    queueMicrotask(() => {
      stream.emit("data", Buffer.from("ok", "utf-8"));
      stream.emit("close", 0);
    });
  });
  return client;
}

function createRuntime(session, overrides = {}) {
  return createSshSessionRuntime({
    terminalManager: { getSession: vi.fn(() => session) },
    sessionStore: { decryptSecret: vi.fn(() => "plain-secret") },
    ...overrides
  });
}

function createKnownHostStoreForTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-runtime-hosts-"));
  const store = createKnownHostStore({
    knownHostsFile: path.join(dir, "known-hosts.json")
  });
  store.loadKnownHosts();
  return store;
}

describe("ssh-session-runtime", () => {
  it("builds password, private-key passphrase, and no-secret configs", () => {
    const keyPath = path.join(os.tmpdir(), `pannel-runtime-key-${Date.now()}`);
    fs.writeFileSync(keyPath, "private-key", "utf-8");
    try {
      const passwordRuntime = createRuntime({
        type: "ssh",
        sshConfig: { host: "example.com", username: "deploy", encryptedSecret: "ciphertext" }
      });
      expect(passwordRuntime.buildConnectionConfig(passwordRuntime.getRunningSshSession("run-1"))).toMatchObject({
        host: "example.com",
        username: "deploy",
        password: "plain-secret",
        tryKeyboard: true
      });

      const keyRuntime = createRuntime({
        type: "ssh",
        sshConfig: { host: "example.com", identityFile: keyPath, encryptedSecret: "ciphertext" }
      });
      const keyConfig = keyRuntime.buildConnectionConfig(keyRuntime.getRunningSshSession("run-1"));
      expect(keyConfig.privateKey.toString("utf-8")).toBe("private-key");
      expect(keyConfig.passphrase).toBe("plain-secret");
      expect(keyConfig.password).toBeUndefined();

      const noSecretRuntime = createRuntime({
        type: "ssh",
        sshConfig: { host: "example.com" }
      }, {
        sessionStore: {}
      });
      expect(noSecretRuntime.buildConnectionConfig(noSecretRuntime.getRunningSshSession("run-1"))).toMatchObject({
        host: "example.com",
        tryKeyboard: false
      });
    } finally {
      fs.rmSync(keyPath, { force: true });
    }
  });

  it("answers keyboard-interactive prompts without echoing secrets", () => {
    expect(answerKeyboardInteractive({ password: "secret" }, [
      { prompt: "Password:", echo: false },
      { prompt: "Code:", echo: true }
    ])).toEqual(["secret", ""]);
  });

  it("connects clients, executes commands, and closes after exec", async () => {
    const client = createClient();
    const runtime = createRuntime({
      id: "run-1",
      type: "ssh",
      sshConfig: { host: "example.com" }
    }, {
      clientFactory: () => client
    });

    await expect(runtime.connectClient("run-1")).resolves.toBe(client);
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ host: "example.com" }));

    await expect(runtime.exec("run-1", "echo ok")).resolves.toBe("ok");
    expect(client.exec).toHaveBeenCalledWith("echo ok", expect.any(Function));
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("streams SSH output and supports cancellation", async () => {
    const client = createClient();
    let stream;
    client.exec = vi.fn((_command, callback) => {
      stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.end = vi.fn();
      stream.signal = vi.fn();
      stream.close = vi.fn();
      callback(undefined, stream);
    });
    const runtime = createRuntime({ id: "run-1", type: "ssh", sshConfig: { host: "example.com" } }, { clientFactory: () => client });
    const stdout = vi.fn();
    const handle = await runtime.execStreaming("run-1", "qoder --print", { stdin: "review", onStdout: stdout });
    stream.emit("data", Buffer.from("partial"));
    expect(stdout).toHaveBeenCalledWith("partial");
    expect(stream.end).toHaveBeenCalledWith("review");
    handle.cancel();
    await expect(handle.promise).resolves.toMatchObject({ exitCode: -1, signal: "TERM" });
    expect(stream.signal).toHaveBeenCalledWith("TERM");
    expect(client.end).toHaveBeenCalled();
  });

  it("rejects missing and non-SSH sessions", async () => {
    const missingRuntime = createSshSessionRuntime({
      terminalManager: { getSession: () => undefined },
      sessionStore: {}
    });
    expect(() => missingRuntime.getRunningSshSession("run-1")).toThrow("Session is not running.");

    const windowsRuntime = createSshSessionRuntime({
      terminalManager: { getSession: () => ({ type: "windows" }) },
      sessionStore: {}
    });
    expect(() => windowsRuntime.getRunningSshSession("run-1")).toThrow("SSH operations are only available for SSH sessions.");
  });

  it("rejects connection errors and closes timed-out clients", async () => {
    const errorClient = createClient();
    errorClient.connect = vi.fn(() => queueMicrotask(() => errorClient.emit("error", new Error("denied"))));
    const errorRuntime = createRuntime({
      type: "ssh",
      sshConfig: { host: "example.com" }
    }, {
      clientFactory: () => errorClient
    });
    await expect(errorRuntime.connectClient("run-1")).rejects.toThrow("denied");

    const timeoutClient = createClient();
    timeoutClient.connect = vi.fn();
    const timeoutRuntime = createRuntime({
      type: "ssh",
      sshConfig: { host: "example.com" }
    }, {
      clientFactory: () => timeoutClient,
      timeoutMs: 1
    });
    await expect(timeoutRuntime.connectClient("run-1")).rejects.toThrow("timed out");
    expect(timeoutClient.end).toHaveBeenCalledTimes(1);
  });

  it("uses the known-host store for host key verification", () => {
    const knownHostStore = createKnownHostStoreForTest();
    const runtime = createRuntime({
      type: "ssh",
      sshConfig: { host: "example.com", port: 22 }
    }, {
      knownHostStore
    });
    const session = runtime.getRunningSshSession("run-1");

    const firstConfig = runtime.buildConnectionConfig(session);
    expect(firstConfig.hostVerifier(Buffer.from("host-key-a"))).toBe(true);

    const secondConfig = runtime.buildConnectionConfig(session);
    expect(secondConfig.hostVerifier(Buffer.from("host-key-a"))).toBe(true);
    expect(secondConfig.hostVerifier(Buffer.from("host-key-b"))).toBe(false);
  });
});
