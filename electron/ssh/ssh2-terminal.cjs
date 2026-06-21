const { EventEmitter } = require("node:events");
const { Client } = require("ssh2");
const { answerKeyboardInteractive } = require("./ssh-session-runtime.cjs");

function createSsh2Terminal({ connectionConfig, cols = 100, rows = 30, clientFactory = () => new Client() }) {
  const emitter = new EventEmitter();
  const client = clientFactory();
  let stream = null;
  let closed = false;
  let exitCode = 0;
  const pendingWrites = [];

  function emitData(data) {
    emitter.emit("data", Buffer.isBuffer(data) ? data.toString("utf-8") : String(data || ""));
  }

  function emitExit(code) {
    if (closed) return;
    closed = true;
    emitter.emit("exit", { exitCode: Number.isInteger(code) ? code : exitCode });
  }

  function openShell() {
    client.shell({
      term: "xterm-256color",
      cols,
      rows
    }, (err, nextStream) => {
      if (err) {
        exitCode = 1;
        emitData(`\r\nSSH shell error: ${err.message}\r\n`);
        client.end();
        emitExit(1);
        return;
      }

      stream = nextStream;
      stream.on("data", emitData);
      stream.stderr?.on("data", emitData);
      stream.on("exit", (code) => {
        if (Number.isInteger(code)) {
          exitCode = code;
        }
      });
      stream.on("close", (code) => {
        if (Number.isInteger(code)) {
          exitCode = code;
        }
        client.end();
        emitExit(exitCode);
      });

      for (const data of pendingWrites.splice(0)) {
        stream.write(data);
      }
    });
  }

  client.on("keyboard-interactive", (_name, _instructions, _instructionsLang, prompts, finish) => {
    finish(answerKeyboardInteractive(connectionConfig, prompts));
  });

  client.on("ready", openShell);
  client.on("error", (err) => {
    exitCode = 1;
    emitData(`\r\nSSH connection error: ${err.message}\r\n`);
  });
  client.on("close", () => {
    emitExit(exitCode);
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
      if (stream) {
        stream.end();
      }
      client.end();
    }
  };
}

module.exports = {
  createSsh2Terminal
};
