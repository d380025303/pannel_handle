const { EventEmitter } = require("node:events");
const { StringDecoder } = require("node:string_decoder");
const { Client } = require("ssh2");
const { answerKeyboardInteractive } = require("./ssh-session-runtime.cjs");

function buildEnvironmentCommand(environment) {
  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  return `exec /usr/bin/env ${Object.entries(environment).map(([name, value]) => quote(`${name}=${value}`)).join(" ")} /bin/bash -il`;
}

const MAX_PENDING_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_WRITES_PER_TURN = 256;

function createSsh2Terminal({ environment = {}, connectionConfig, cols = 100, rows = 30, clientFactory = () => new Client() }) {
  const emitter = new EventEmitter();
  const client = clientFactory();
  let stream = null;
  let latestCols = cols;
  let latestRows = rows;
  let closed = false;
  let exitCode = 0;
  let connected = false;
  let killed = false;
  let shellExited = false;
  const pendingWrites = [];
  let pendingHead = 0;
  let pendingBytes = 0;
  let waitingForDrain = false;
  let flushImmediate = null;

  function clearPendingWrites() {
    pendingWrites.length = 0;
    pendingHead = 0;
    pendingBytes = 0;
    waitingForDrain = false;
    if (flushImmediate !== null) clearImmediate(flushImmediate);
    flushImmediate = null;
    stream?.off("drain", onDrain);
  }

  function flushPendingWrites() {
    // New input must not bypass the yield scheduled for an existing backlog.
    if (flushImmediate !== null) return;
    let writes = 0;
    while (stream && !closed && !killed && !waitingForDrain && pendingHead < pendingWrites.length && writes < MAX_WRITES_PER_TURN) {
      const data = pendingWrites[pendingHead];
      pendingWrites[pendingHead++] = undefined;
      pendingBytes -= Buffer.byteLength(data);
      writes++;
      waitingForDrain = stream.write(data) === false;
    }
    if (pendingHead === pendingWrites.length) {
      pendingWrites.length = 0;
      pendingHead = 0;
    } else if (stream && !closed && !killed && !waitingForDrain) {
      flushImmediate = setImmediate(() => {
        flushImmediate = null;
        flushPendingWrites();
      });
    }
  }

  function onDrain() {
    waitingForDrain = false;
    flushPendingWrites();
  }
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  function emitData(data) {
    const text = String(data || "");
    if (text) emitter.emit("data", text);
  }

  function decodeData(decoder, data) {
    emitData(Buffer.isBuffer(data) ? decoder.write(data) : data);
  }

  function flushDecoder(decoder) {
    emitData(decoder.end());
  }

  function emitStatus(status) {
    emitter.emit("status", { status });
  }

  function emitExit(code, details = {}) {
    if (closed) return;
    flushDecoder(stdoutDecoder);
    flushDecoder(stderrDecoder);
    closed = true;
    clearPendingWrites();
    emitter.emit("exit", {
      exitCode: Number.isInteger(code) ? code : exitCode,
      reason: details.reason || "remote-exit",
      retryable: details.retryable === true,
      ...(details.message ? { message: details.message } : {})
    });
  }

  function isRetryableConnectionError(err) {
    const level = String(err?.level || "").toLowerCase();
    if (level === "client-authentication" || level === "handshake") return false;
    if (level === "client-timeout" || level === "client-socket") return true;
    return /timeout|timed out|socket|econn|enet|ehost|connection (?:closed|lost|reset)|network/i.test(String(err?.message || err || ""));
  }

  function openShell() {
    const window = { term: "xterm-256color", cols: latestCols, rows: latestRows };
    const onShell = (err, nextStream) => {
      if (err) {
        exitCode = 1;
        emitData(`\r\nSSH shell error: ${err.message}\r\n`);
        client.end();
        emitExit(1, { reason: "shell-error", retryable: false, message: err.message });
        return;
      }

      if (closed || killed) {
        nextStream.end();
        return;
      }
      stream = nextStream;
      stream.on("drain", onDrain);
      stream.on("data", (data) => decodeData(stdoutDecoder, data));
      stream.stderr?.on("data", (data) => decodeData(stderrDecoder, data));
      stream.on("end", () => flushDecoder(stdoutDecoder));
      stream.stderr?.on("end", () => flushDecoder(stderrDecoder));
      stream.stderr?.on("close", () => flushDecoder(stderrDecoder));
      stream.on("error", (err) => {
        exitCode = 1;
        emitData(`\r\nSSH stream error: ${err.message}\r\n`);
        client.end();
        emitExit(1, { reason: "transport-error", retryable: true, message: err.message });
      });
      stream.stderr?.on("error", (err) => {
        emitData(`\r\nSSH stderr stream error: ${err.message}\r\n`);
      });
      stream.on("exit", (code, signal) => {
        shellExited = true;
        if (signal) {
          exitCode = -1;
        } else if (Number.isInteger(code)) {
          exitCode = code;
        }
      });
      stream.on("close", (code, signal) => {
        if (signal) {
          exitCode = -1;
        } else if (Number.isInteger(code)) {
          exitCode = code;
        }
        client.end();
        emitExit(exitCode, killed
          ? { reason: "killed", retryable: false }
          : shellExited
            ? { reason: "remote-exit", retryable: false }
            : { reason: "connection-close", retryable: true });
      });

      if ((latestCols !== window.cols || latestRows !== window.rows) && typeof stream.setWindow === "function") {
        stream.setWindow(latestRows, latestCols, 0, 0);
      }
      flushPendingWrites();
    };
    if (Object.keys(environment).length) client.exec(buildEnvironmentCommand(environment), { pty: window }, onShell);
    else client.shell(window, onShell);
  }

  client.on("keyboard-interactive", (_name, _instructions, _instructionsLang, prompts, finish) => {
    finish(answerKeyboardInteractive(connectionConfig, prompts));
  });

  client.on("ready", () => {
    if (closed || killed) return;
    connected = true;
    emitStatus("connected");
    openShell();
  });
  client.on("error", (err) => {
    if (!closed) {
      exitCode = 1;
      emitData(`\r\nSSH connection error: ${err.message}\r\n`);
      client.end();
      emitExit(1, {
        reason: "connection-error",
        retryable: isRetryableConnectionError(err),
        message: err.message
      });
    }
  });
  client.on("close", () => {
    emitExit(exitCode, killed
      ? { reason: "killed", retryable: false }
      : shellExited
        ? { reason: "remote-exit", retryable: false }
        : { reason: connected ? "connection-close" : "connection-error", retryable: true });
  });

  client.connect(connectionConfig);

  return {
    onData(callback) {
      emitter.on("data", callback);
      return {
        dispose() {
          emitter.off("data", callback);
        }
      };
    },
    onExit(callback) {
      emitter.on("exit", callback);
      return {
        dispose() {
          emitter.off("exit", callback);
        }
      };
    },
    onStatus(callback) {
      emitter.on("status", callback);
      return {
        dispose() {
          emitter.off("status", callback);
        }
      };
    },
    write(data) {
      if (closed || killed) {
        return { ok: false, code: "SSH_INPUT_CLOSED", error: "SSH 连接已关闭，无法发送输入。" };
      }
      const bytes = Buffer.byteLength(data);
      // Include ssh2's Writable buffer: highWaterMark alone is not a hard limit.
      if (bytes + pendingBytes + (stream?.writableLength || 0) > MAX_PENDING_INPUT_BYTES) {
        const error = "SSH 待发送输入已达到 4 MiB 上限，本次输入未发送，请等待远端读取后重试。";
        emitData(`\r\n${error}\r\n`);
        return { ok: false, code: "SSH_INPUT_LIMIT", error };
      }
      if (bytes) {
        // Own queued buffers so the caller cannot change accepted input later.
        pendingWrites.push(Buffer.isBuffer(data) ? Buffer.from(data) : data);
        pendingBytes += bytes;
        flushPendingWrites();
      }
      return { ok: true };
    },
    resize(nextCols, nextRows) {
      latestCols = nextCols;
      latestRows = nextRows;
      if (stream && typeof stream.setWindow === "function") {
        stream.setWindow(nextRows, nextCols, 0, 0);
      }
    },
    kill() {
      killed = true;
      clearPendingWrites();
      if (stream) {
        stream.end();
      }
      client.end();
    }
  };
}

module.exports = {
  MAX_PENDING_INPUT_BYTES,
  createSsh2Terminal,
  buildEnvironmentCommand
};
