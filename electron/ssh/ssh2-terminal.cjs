const { EventEmitter } = require("node:events");
const { Client } = require("ssh2");
const { answerKeyboardInteractive } = require("./ssh-session-runtime.cjs");

function buildEnvironmentCommand(environment) {
  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  return `exec /usr/bin/env ${Object.entries(environment).map(([name, value]) => quote(`${name}=${value}`)).join(" ")} /bin/bash -il`;
}

function createSsh2Terminal({ environment = {}, connectionConfig, cols = 100, rows = 30, clientFactory = () => new Client() }) {
  const emitter = new EventEmitter();
  const client = clientFactory();
  let stream = null;
  let closed = false;
  let exitCode = 0;
  let connected = false;
  let killed = false;
  let shellExited = false;
  const pendingWrites = [];

  function emitData(data) {
    emitter.emit("data", Buffer.isBuffer(data) ? data.toString("utf-8") : String(data || ""));
  }

  function emitStatus(status) {
    emitter.emit("status", { status });
  }

  function emitExit(code, details = {}) {
    if (closed) return;
    closed = true;
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
    const onShell = (err, nextStream) => {
      if (err) {
        exitCode = 1;
        emitData(`\r\nSSH shell error: ${err.message}\r\n`);
        client.end();
        emitExit(1, { reason: "shell-error", retryable: false, message: err.message });
        return;
      }

      stream = nextStream;
      stream.on("data", emitData);
      stream.stderr?.on("data", emitData);
      stream.on("error", (err) => {
        exitCode = 1;
        emitData(`\r\nSSH stream error: ${err.message}\r\n`);
        client.end();
        emitExit(1, { reason: "transport-error", retryable: true, message: err.message });
      });
      stream.stderr?.on("error", (err) => {
        emitData(`\r\nSSH stderr stream error: ${err.message}\r\n`);
      });
      stream.on("exit", (code) => {
        shellExited = true;
        if (Number.isInteger(code)) {
          exitCode = code;
        }
      });
      stream.on("close", (code) => {
        if (Number.isInteger(code)) {
          exitCode = code;
        }
        client.end();
        emitExit(exitCode, killed
          ? { reason: "killed", retryable: false }
          : shellExited
            ? { reason: "remote-exit", retryable: false }
            : { reason: "connection-close", retryable: true });
      });

      for (const data of pendingWrites.splice(0)) {
        stream.write(data);
      }
    };
    const window = { term: "xterm-256color", cols, rows };
    if (Object.keys(environment).length) client.exec(buildEnvironmentCommand(environment), { pty: window }, onShell);
    else client.shell(window, onShell);
  }

  client.on("keyboard-interactive", (_name, _instructions, _instructionsLang, prompts, finish) => {
    finish(answerKeyboardInteractive(connectionConfig, prompts));
  });

  client.on("ready", () => {
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
      if (stream) {
        stream.write(data);
      } else {
        pendingWrites.push(data);
      }
    },
    resize(nextCols, nextRows) {
      if (stream && typeof stream.setWindow === "function") {
        stream.setWindow(nextRows, nextCols, 0, 0);
      }
    },
    kill() {
      killed = true;
      if (stream) {
        stream.end();
      }
      client.end();
    }
  };
}

module.exports = {
  createSsh2Terminal,
  buildEnvironmentCommand
};
