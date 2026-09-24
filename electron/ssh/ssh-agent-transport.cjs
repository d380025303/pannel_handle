const { EventEmitter } = require("node:events");

function createSshAgentTransport({ sshSessionRuntime }) {
  if (!sshSessionRuntime) throw new Error("SSH runtime is unavailable.");

  async function exec(sessionId, command, options = {}) {
    if (typeof sshSessionRuntime.exec === "function") {
      return sshSessionRuntime.exec(sessionId, command, options);
    }
    const client = createReusableCommandClient(sessionId, options);
    try {
      return await client.exec(command);
    } finally {
      client.close();
    }
  }

  async function createStdioTransport(sessionId, options = {}) {
    const command = options.command || "bash -lic 'exec codex app-server --stdio'";
    const client = await sshSessionRuntime.connectClient(sessionId, {
      actionName: options.actionName || "Codex usage connection",
      timeoutMs: options.timeoutMs
    });

    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          try { client.end(); } catch { /* best effort */ }
          reject(error);
          return;
        }

        const events = new EventEmitter();
        let closed = false;
        let finished = false;
        const finish = (code, signal) => {
          if (finished) return;
          finished = true;
          events.emit("close", code, signal);
          if (!closed) try { client.end(); } catch { /* best effort */ }
        };
        stream.on("data", data => events.emit("stdout", data));
        stream.stderr?.on("data", data => events.emit("stderr", data));
        stream.once("error", streamError => events.emit("error", streamError));
        stream.once("close", finish);
        client.once?.("close", () => finish(null, null));
        client.once?.("error", connectionError => events.emit("error", connectionError));

        resolve({
          invocation: command === "bash -lic 'exec codex app-server --stdio'"
            ? { command: "ssh", args: ["bash", "-lic", "exec codex app-server --stdio"] }
            : { command: "ssh", args: [command] },
          on: (eventName, listener) => events.on(eventName, listener),
          write(data) {
            if (!closed && stream.writable) stream.write(data);
          },
          close() {
            if (closed) return;
            closed = true;
            try { stream.end(); } catch { /* best effort */ }
            try { stream.signal?.("TERM"); } catch { /* best effort */ }
            try { client.end(); } catch { /* best effort */ }
            finish(null, null);
          }
        });
      });
    });
  }

  function createReusableCommandClient(sessionId, options = {}) {
    let client = null;
    let clientPromise = null;
    let closed = false;

    function closeClient() {
      const current = client;
      const pending = clientPromise;
      client = null;
      clientPromise = null;
      try { current?.end?.(); } catch { /* best effort */ }
      if (!current && pending) {
        void pending.then(connected => {
          try { connected?.end?.(); } catch { /* best effort */ }
        }).catch(() => undefined);
      }
    }

    async function getClient() {
      if (closed) throw new Error(options.closedMessage || "SSH command client is closed.");
      if (client) return client;
      if (!clientPromise) {
        const request = sshSessionRuntime.connectClient(sessionId, {
          actionName: options.actionName || "SSH command connection",
          timeoutMs: options.timeoutMs
        }).then(connected => {
          if (closed || clientPromise !== request) {
            try { connected.end?.(); } catch { /* best effort */ }
            throw new Error(options.closedMessage || "SSH command client is closed.");
          }
          client = connected;
          connected.on?.("close", () => {
            if (client === connected) client = null;
          });
          return connected;
        }).finally(() => {
          if (clientPromise === request) clientPromise = null;
        });
        clientPromise = request;
      }
      return clientPromise;
    }

    async function run(command) {
      const connected = await getClient();
      try {
        return await new Promise((resolve, reject) => {
          connected.exec(command, (error, stream) => {
            if (error) { reject(error); return; }
            let stdout = "";
            let stderr = "";
            let settled = false;
            const finish = (error, value) => {
              if (settled) return;
              settled = true;
              if (error) reject(error); else resolve(value);
            };
            stream.on("data", chunk => {
              stdout += chunk.toString("utf-8");
              if (options.maxOutputBytes && Buffer.byteLength(stdout, "utf-8") > options.maxOutputBytes) {
                stream.close?.();
                finish(new Error(options.outputLimitMessage || "Remote command output exceeds the size limit."));
              }
            });
            stream.stderr?.on("data", chunk => { stderr += chunk.toString("utf-8"); });
            stream.once("error", finish);
            stream.once("close", code => {
              if (code === 0) finish(undefined, stdout);
              else finish(new Error(stderr.trim() || `${options.commandName || "Remote command"} exited with code ${code}.`));
            });
          });
        });
      } catch (error) {
        if (client === connected) closeClient();
        throw error;
      }
    }

    return {
      exec: run,
      close() {
        closed = true;
        closeClient();
      }
    };
  }

  return { exec, createStdioTransport, createReusableCommandClient };
}

module.exports = { createSshAgentTransport };
