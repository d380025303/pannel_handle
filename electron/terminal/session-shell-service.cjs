const os = require("node:os");
const nodePty = require("node-pty");
const { mergeEnvironment } = require("../services/environment/index.cjs");
const { buildSsh2ConnectionConfig } = require("../ssh/ssh2-connection.cjs");
const { createSsh2Terminal } = require("../ssh/ssh2-terminal.cjs");
const { getWslShell } = require("./terminal-manager.cjs");

function quoteRemotePath(value, windows) {
  return windows
    ? `"${String(value).replace(/"/g, '""')}"`
    : `'${String(value).replace(/'/g, "'\\''")}'`;
}

function createSessionShellService({ terminalManager, environmentService, sessionStore, knownHostStore,
  broadcast, pty = nodePty, sshTerminalFactory = createSsh2Terminal }) {
  const shells = new Map();
  let nextGeneration = 0;

  function currentGraphicalSession(id) {
    const session = terminalManager.getSession(id);
    if (!session || session.runtimeMode !== "app-server") throw new Error("图形会话已关闭。");
    return session;
  }

  function close(id, ownerToken) {
    const shell = shells.get(id);
    if (!shell) return;
    if (ownerToken) {
      shell.owners.delete(ownerToken);
      if (shell.owners.size > 0) return;
    }
    shells.delete(id);
    shell.term.kill();
  }

  function open(id, ownerToken) {
    const session = currentGraphicalSession(id);
    let shell = shells.get(id);
    if (shell?.exited) {
      close(id);
      shell = undefined;
    }
    if (shell) {
      shell.owners.add(ownerToken);
      return { generation: shell.generation, history: shell.buffer.join(""), seq: shell.seq };
    }

    const generation = ++nextGeneration;
    const configuredEnv = environmentService?.resolve(session) || {};
    let term;
    if (session.type === "ssh") {
      if (Object.keys(configuredEnv).length && session.sshConfig?.remotePlatform === "windows") {
        throw new Error("SSH 环境变量注入仅支持 Linux / Bash。");
      }
      const secret = session.sshConfig?.encryptedSecret && sessionStore?.decryptSecret?.(session.sshConfig.encryptedSecret);
      term = sshTerminalFactory({
        environment: configuredEnv,
        connectionConfig: buildSsh2ConnectionConfig({ sshConfig: session.sshConfig, secret, knownHostStore }),
        cols: 100, rows: 30
      });
    } else {
      const isWsl = session.type === "wsl";
      const env = mergeEnvironment([process.env, configuredEnv], !isWsl);
      if (isWsl && Object.keys(configuredEnv).length) {
        const existing = String(env.WSLENV || "").split(":").filter(Boolean);
        const names = new Set(existing.map(entry => entry.split("/")[0]));
        for (const name of Object.keys(configuredEnv)) {
          if (!names.has(name)) existing.push(`${name}/u`);
        }
        env.WSLENV = existing.join(":");
      }
      const args = isWsl ? [
        ...(session.wslDistro ? ["-d", session.wslDistro] : []),
        ...(session.cwd && session.cwd !== "~" ? ["--cd", session.cwd] : [])
      ] : [];
      term = pty.spawn(isWsl ? getWslShell() : session.shell, args, {
        name: "xterm-256color", cols: 100, rows: 30,
        cwd: isWsl ? os.homedir() : session.cwd, env
      });
    }

    shell = { generation, term, buffer: [], seq: 0, exited: false, owners: new Set([ownerToken]) };
    shells.set(id, shell);
    term.onData(data => {
      if (shells.get(id) !== shell) return;
      shell.buffer.push(String(data));
      if (shell.buffer.length > 1000) shell.buffer.shift();
      shell.seq += 1;
      broadcast("session-shell:data", { id, generation, seq: shell.seq, data: String(data) });
    });
    term.onExit(({ exitCode }) => {
      if (shells.get(id) !== shell) return;
      shell.exited = true;
      broadcast("session-shell:exit", { id, generation, exitCode });
    });
    if (session.type === "ssh" && session.cwd && session.cwd !== "~") {
      const windows = session.sshConfig?.remotePlatform === "windows";
      const command = `cd ${quoteRemotePath(session.cwd, windows)}\r`;
      let sent = false;
      const sendCwd = () => {
        if (sent || shells.get(id) !== shell) return;
        sent = true;
        term.write(command);
      };
      term.onStatus?.(({ status }) => { if (status === "connected") sendCwd(); });
      const disposable = term.onData(() => { disposable.dispose(); sendCwd(); });
    }
    return { generation, history: shell.buffer.join(""), seq: shell.seq };
  }

  function write(id, generation, data) {
    const shell = shells.get(id);
    if (shell?.generation === generation && !shell.exited && typeof data === "string") shell.term.write(data);
  }

  function resize(id, generation, cols, rows) {
    const shell = shells.get(id);
    if (shell?.generation === generation && !shell.exited && Number.isInteger(cols) && Number.isInteger(rows)
      && cols > 0 && rows > 0) shell.term.resize(cols, rows);
  }

  function shutdown() {
    for (const id of shells.keys()) close(id);
  }

  return { open, close, write, resize, shutdown };
}

module.exports = { createSessionShellService };
