const { mergeWslEnv } = require("../core/wsl-env.cjs");
const os = require("node:os");
const nodePty = require("node-pty");
const { mergeEnvironment } = require("../services/environment/index.cjs");
const { buildSsh2ConnectionConfig } = require("../ssh/ssh2-connection.cjs");
const { createSsh2Terminal } = require("../ssh/ssh2-terminal.cjs");
const { getWslShell } = require("./terminal-manager.cjs");

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

// Keep parser state across callbacks; replay must start outside an escape sequence.
function scanHistory(data, initialState, maxBytes = Infinity) {
  let state = initialState;
  let remaining = Buffer.byteLength(data, "utf8");
  let start = state === "ground" && remaining <= maxBytes ? 0 : -1;
  let offset = 0;
  for (const char of data) {
    const code = char.codePointAt(0);
    if (code === 0x18 || code === 0x1a) state = "ground";
    else if (state === "string" || state === "stringEscape") {
      if (code === 0x9c || code === 7 || (state === "stringEscape" && char === "\\")) state = "ground";
      else state = code === 0x1b ? "stringEscape" : "string";
    } else if (code === 0x1b) state = "escape";
    else if (code === 0x9b) state = "csi";
    else if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) state = "string";
    else if (state === "escape") {
      if (char === "[") state = "csi";
      else if (char === "]" || char === "P" || char === "X" || char === "^" || char === "_") state = "string";
      else if (code >= 0x30 && code <= 0x7e) state = "ground";
    } else if (state === "csi" && code >= 0x40 && code <= 0x7e) state = "ground";
    offset += char.length;
    remaining -= code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
    if (start < 0 && state === "ground" && remaining <= maxBytes) start = offset;
  }
  return { state, start };
}

function appendHistory(shell, data) {
  const wasEmpty = shell.buffer.length === 0;
  const initialState = shell.historyState;
  const bytes = Buffer.byteLength(data, "utf8");
  const scanned = scanHistory(data, initialState, MAX_HISTORY_BYTES);
  shell.historyState = scanned.state;
  const oversized = bytes > MAX_HISTORY_BYTES;
  // Copy trimmed strings: V8 slices can otherwise retain the oversized backing string.
  const retained = oversized ? (scanned.start < 0 ? "" : Buffer.from(data.slice(scanned.start), "utf8").toString("utf8")) : data;
  if (retained) {
    const retainedBytes = oversized ? Buffer.byteLength(retained, "utf8") : bytes;
    shell.buffer.push({ data: retained, bytes: retainedBytes, state: oversized ? "ground" : initialState });
    shell.historyBytes += retainedBytes;
  }
  let evicted = oversized || wasEmpty;
  if (oversized) {
    // An oversized control string may leave no safe suffix at all.
    while (shell.buffer.length > (retained ? 1 : 0)) shell.historyBytes -= shell.buffer.shift().bytes;
  }
  while (shell.buffer.length > 1000 || shell.historyBytes > MAX_HISTORY_BYTES) {
    shell.historyBytes -= shell.buffer.shift().bytes;
    evicted = true;
  }
  while (evicted && shell.buffer.length && shell.buffer[0].state !== "ground") {
    const first = shell.buffer[0];
    const { start } = scanHistory(first.data, first.state);
    shell.historyBytes -= first.bytes;
    if (start < 0 || start === first.data.length) shell.buffer.shift();
    else {
      first.data = Buffer.from(first.data.slice(start), "utf8").toString("utf8");
      first.bytes = Buffer.byteLength(first.data, "utf8");
      first.state = "ground";
      shell.historyBytes += first.bytes;
    }
  }
}

function quoteRemotePath(value, windows) {
  const path = String(value);
  if (windows) return `"${path.replace(/"/g, '""')}"`;
  // Expand only the home prefix; keep the rest literal, including shell syntax.
  const homeRelative = path.startsWith("~/");
  const quoted = `'${(homeRelative ? path.slice(2) : path).replace(/'/g, "'\\''")}'`;
  return homeRelative ? `"$HOME"/${quoted}` : quoted;
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
      return { generation: shell.generation, history: shell.buffer.map(chunk => chunk.data).join(""), seq: shell.seq };
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
        env.WSLENV = mergeWslEnv(env.WSLENV, Object.keys(configuredEnv));
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

    shell = { generation, term, buffer: [], historyBytes: 0, historyState: "ground", seq: 0, exited: false, owners: new Set([ownerToken]) };
    shells.set(id, shell);
    term.onData(data => {
      if (shells.get(id) !== shell) return;
      appendHistory(shell, String(data));
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
      const command = `cd ${windows ? "" : "-- "}${quoteRemotePath(session.cwd, windows)}\r`;
      let sent = false;
      const sendCwd = () => {
        if (sent || shells.get(id) !== shell) return;
        sent = true;
        term.write(command);
      };
      term.onStatus?.(({ status }) => { if (status === "connected") sendCwd(); });
      const disposable = term.onData(() => { disposable.dispose(); sendCwd(); });
    }
    return { generation, history: shell.buffer.map(chunk => chunk.data).join(""), seq: shell.seq };
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
