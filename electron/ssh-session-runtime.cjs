const { Client } = require("ssh2");
const SftpClient = require("ssh2-sftp-client");
const { buildSsh2ConnectionConfig } = require("./ssh2-connection.cjs");

const DEFAULT_SSH_TIMEOUT_MS = 15000;

function answerKeyboardInteractive(connectionConfig, prompts) {
  const secret = connectionConfig.password || connectionConfig.passphrase;
  return Array.isArray(prompts)
    ? prompts.map((prompt) => prompt?.echo ? "" : String(secret || ""))
    : [];
}

function createSshSessionRuntime({
  terminalManager,
  sessionStore,
  knownHostStore,
  clientFactory = () => new Client(),
  sftpFactory = () => new SftpClient(),
  timeoutMs = DEFAULT_SSH_TIMEOUT_MS
}) {
  function getRunningSshSession(sessionId) {
    const session = terminalManager?.getSession(sessionId);
    if (!session) {
      throw new Error("Session is not running.");
    }
    if (session.type !== "ssh") {
      throw new Error("SSH operations are only available for SSH sessions.");
    }
    return session;
  }

  function getSecret(sshConfig) {
    if (!sshConfig?.encryptedSecret || typeof sessionStore?.decryptSecret !== "function") {
      return undefined;
    }
    return sessionStore.decryptSecret(sshConfig.encryptedSecret);
  }

  function buildConnectionConfig(session, options = {}) {
    return buildSsh2ConnectionConfig({
      sshConfig: session.sshConfig || {},
      secret: getSecret(session.sshConfig),
      knownHostStore,
      onHostVerification: options.onHostVerification
    });
  }

  function attachKeyboardInteractive(client, connectionConfig) {
    client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
      finish(answerKeyboardInteractive(connectionConfig, prompts));
    });
  }

  function connectClient(sessionId, options = {}) {
    const session = getRunningSshSession(sessionId);
    const connectionConfig = buildConnectionConfig(session, options);
    const client = options.client || clientFactory();
    const actionName = options.actionName || "SSH connection";
    const connectTimeoutMs = options.timeoutMs || timeoutMs;

    attachKeyboardInteractive(client, connectionConfig);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          // Ignore close failures after timeout.
        }
        reject(new Error(`${actionName} timed out.`));
      }, connectTimeoutMs);

      function fail(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }

      client.once("ready", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(client);
      });
      client.on("error", fail);
      client.on("close", () => {
        fail(new Error(`${actionName} closed before it was ready.`));
      });
      client.connect(connectionConfig);
    });
  }

  async function createSftpClient(sessionId, options = {}) {
    const session = getRunningSshSession(sessionId);
    const sftp = options.sftp || sftpFactory();
    await sftp.connect(buildConnectionConfig(session, options));
    return sftp;
  }

  async function exec(sessionId, command, options = {}) {
    const client = await connectClient(sessionId, {
      actionName: options.actionName,
      timeoutMs: options.timeoutMs,
      client: options.client,
      onHostVerification: options.onHostVerification
    });
    const allowExitCodes = options.allowExitCodes || [0];
    const actionName = options.actionName || "SSH command";
    const commandTimeoutMs = options.timeoutMs || timeoutMs;

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          // Ignore close failures after timeout.
        }
        reject(new Error(`${actionName} timed out.`));
      }, commandTimeoutMs);

      function finish(err, output) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          client.end();
        } catch {
          // Ignore close failures after command completion.
        }
        if (err) {
          reject(err);
        } else {
          resolve(output);
        }
      }

      client.exec(command, (err, stream) => {
        if (err) {
          finish(err);
          return;
        }
        stream.on("data", (data) => {
          stdout += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        });
        stream.stderr?.on("data", (data) => {
          stderr += Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        });
        stream.on("close", (code) => {
          if (Number.isInteger(code) && !allowExitCodes.includes(code)) {
            finish(new Error(stderr.trim() || `${actionName} failed with exit code ${code}.`));
            return;
          }
          finish(undefined, stdout);
        });
      });
    });
  }

  async function execStreaming(sessionId, command, options = {}) {
    const client = await connectClient(sessionId, {
      actionName: options.actionName,
      timeoutMs: options.connectTimeoutMs,
      onHostVerification: options.onHostVerification
    });
    let stream;
    let canceled = false;
    let settle;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      settle = (err, result) => {
        if (settled) return;
        settled = true;
        try { client.end(); } catch { /* best effort */ }
        if (err) reject(err); else resolve(result);
      };
      client.exec(command, (err, remoteStream) => {
        if (err) {
          settle(err);
          return;
        }
        stream = remoteStream;
        remoteStream.on("data", data => options.onStdout?.(String(data)));
        remoteStream.stderr?.on("data", data => options.onStderr?.(String(data)));
        remoteStream.once("error", error => settle(error));
        remoteStream.once("close", (code, signal) => {
          settle(undefined, { exitCode: Number.isInteger(code) ? code : canceled ? -1 : 0, signal });
        });
        if (options.stdin) remoteStream.end(options.stdin); else remoteStream.end();
      });
    });
    return {
      promise,
      cancel() {
        canceled = true;
        try { stream?.signal("TERM"); } catch { /* best effort */ }
        try { stream?.close(); } catch { /* best effort */ }
        settle(undefined, { exitCode: -1, signal: "TERM" });
      }
    };
  }

  return {
    attachKeyboardInteractive,
    buildConnectionConfig,
    connectClient,
    createSftpClient,
    exec,
    execStreaming,
    getRunningSshSession,
    getSecret
  };
}

module.exports = {
  DEFAULT_SSH_TIMEOUT_MS,
  answerKeyboardInteractive,
  createSshSessionRuntime
};
