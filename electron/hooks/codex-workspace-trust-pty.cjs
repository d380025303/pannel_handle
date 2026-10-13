const { fork } = require("node:child_process");
const path = require("node:path");

// Isolate node-pty's ConPTY handles and workers from Electron. The bundled DLL
// avoids AttachConsole's shutdown race, but may retain handles after kill().
function spawn(file, args, options) {
  const child = fork(path.join(__dirname, "codex-workspace-trust-pty-child.cjs"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  const dataListeners = new Set();
  const exitListeners = new Set();
  let closing = false;
  let exited = false;
  let shutdownTimer;
  const send = value => {
    if (child.connected) child.send(value, () => {});
  };
  const notifyExit = exitCode => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ exitCode });
  };
  child.on("message", message => {
    if (message.type === "data" && !closing) {
      for (const listener of dataListeners) listener(message.data);
    } else if (message.type === "exit") notifyExit(message.exitCode);
  });
  child.stderr.on("data", () => {});
  child.on("error", error => {
    if (!closing) for (const listener of dataListeners) listener(`\r\n${error.message}\r\n`);
    notifyExit(1);
  });
  child.on("exit", code => { clearTimeout(shutdownTimer); notifyExit(code ?? 1); });
  const subscribe = (listeners, listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  send({ type: "spawn", file, args, options });
  return {
    onData: listener => subscribe(dataListeners, listener),
    onExit: listener => subscribe(exitListeners, listener),
    write: data => { if (!closing && !exited) send({ type: "write", data }); },
    resize: (cols, rows) => { if (!closing && !exited) send({ type: "resize", cols, rows }); },
    kill: () => {
      if (closing) return;
      closing = true;
      send({ type: "kill" });
      shutdownTimer = setTimeout(() => child.kill(), 3000);
      shutdownTimer.unref();
    }
  };
}

module.exports = { spawn };
