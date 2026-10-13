const { EventEmitter } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const { StringDecoder } = require("node:string_decoder");

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

  async function createInteractiveTransport(sessionId, { command, actionName, signal }) {
    const client = await sshSessionRuntime.connectClient(sessionId, { actionName });
    if (signal?.aborted) { client.end(); throw new Error("登录已取消。"); }
    return new Promise((resolve, reject) => {
      const abort = () => { client.end(); reject(new Error("登录已取消。")); };
      signal?.addEventListener("abort", abort, { once: true });
      client.exec(command, { pty: { term: "xterm-256color", cols: 100, rows: 24 } }, (error, stream) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) { stream?.end(); client.end(); reject(new Error("登录已取消。")); return; }
        if (error) { client.end(); reject(error); return; }
        const events = new EventEmitter();
        let closed = false;
        let exitCode = null;
        let exitSignal = null;
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        const emitData = text => { if (text) events.emit("data", text); };
        const finish = reason => {
          if (closed) return;
          closed = true;
          emitData(stdoutDecoder.end());
          emitData(stderrDecoder.end());
          events.emit("exit", { exitCode, signal: exitSignal, reason });
          client.end();
        };
        stream.on("data", data => {
          if (!closed) emitData(Buffer.isBuffer(data) ? stdoutDecoder.write(data) : String(data));
        });
        stream.stderr?.on("data", data => {
          if (!closed) emitData(Buffer.isBuffer(data) ? stderrDecoder.write(data) : String(data));
        });
        stream.on("exit", (code, signal) => { exitCode = Number.isInteger(code) ? code : null; exitSignal = signal; });
        stream.on("close", () => finish("remote-exit"));
        stream.on("error", () => finish("transport-error"));
        client.on("error", () => finish("transport-error"));
        client.on("close", () => finish("connection-close"));
        resolve({
          onData(callback) { events.on("data", callback); return { dispose: () => events.off("data", callback) }; },
          onExit(callback) { events.on("exit", callback); return { dispose: () => events.off("exit", callback) }; },
          write(data) { if (!closed) stream.write(data); },
          resize(cols, rows) { if (!closed) stream.setWindow(rows, cols, 0, 0); },
          kill() {
            if (closed) return;
            closed = true;
            stream.signal?.("TERM"); stream.end(); client.end();
          }
        });
      });
    });
  }

  async function createHttpForwarder(sessionId, remotePort) {
    const client = await sshSessionRuntime.connectClient(sessionId, { actionName: "CodeBuddy ACP HTTP connection" });
    // SSH channels are Duplex streams, without TCP socket keep-alive/ref methods.
    // Reuse the SSH connection, but close each completed HTTP request's channel.
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      client.forwardOut("127.0.0.1", 0, "127.0.0.1", remotePort, callback);
    };
    return {
      agent,
      close() { agent.destroy(); client.end(); }
    };
  }

  async function createReverseHttpForwarder(sessionId, localPort) {
    const client = await sshSessionRuntime.connectClient(sessionId, { actionName: "OpenCode question connection" });
    let closed = false;
    client.on("tcp connection", (_details, accept) => {
      const remote = accept();
      const local = net.connect(localPort, "127.0.0.1");
      remote.on("error", () => local.destroy());
      local.on("error", () => remote.destroy());
      remote.pipe(local).pipe(remote);
    });
    try {
      const remotePort = await new Promise((resolve, reject) =>
        client.forwardIn("127.0.0.1", 0, (error, port) => error ? reject(error) : resolve(port)));
      return { url: `http://127.0.0.1:${remotePort}`, close() {
        if (closed) return;
        closed = true;
        client.unforwardIn("127.0.0.1", remotePort, () => client.end());
      } };
    } catch (error) {
      client.end();
      throw error;
    }
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
            let stdoutBytes = 0;
            let stderr = "";
            const stdoutDecoder = new StringDecoder("utf8");
            const stderrDecoder = new StringDecoder("utf8");
            let settled = false;
            const finish = (error, value) => {
              if (settled) return;
              settled = true;
              if (error) reject(error); else resolve(value);
            };
            const appendStdout = chunk => {
              if (settled) return;
              stdout += chunk;
              if (options.maxOutputBytes) stdoutBytes += Buffer.byteLength(chunk, "utf-8");
              if (options.maxOutputBytes && stdoutBytes > options.maxOutputBytes) {
                finish(new Error(options.outputLimitMessage || "Remote command output exceeds the size limit."));
                stream.close?.();
              }
            };
            stream.on("data", chunk => appendStdout(Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk)));
            stream.stderr?.on("data", chunk => { stderr += Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : String(chunk); });
            stream.once("error", finish);
            stream.once("close", code => {
              appendStdout(stdoutDecoder.end());
              stderr += stderrDecoder.end();
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

  return { exec, createStdioTransport, createInteractiveTransport, createHttpForwarder, createReverseHttpForwarder, createReusableCommandClient };
}

module.exports = { createSshAgentTransport };
