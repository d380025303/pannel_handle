const fs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createCheckinError } = require("./checkin-error.cjs");

function getWorkBuddyInvocation({
  localAppData = process.env.LOCALAPPDATA,
  existsSync = fs.existsSync
} = {}) {
  if (!localAppData) {
    throw createCheckinError("WorkBuddy installation could not be located.", {
      code: "installation-missing",
      retryable: false
    });
  }
  const installRoot = path.join(localAppData, "Programs", "WorkBuddy");
  const command = path.join(installRoot, "WorkBuddy.exe");
  const cliScript = path.join(installRoot, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  if (!existsSync(command) || !existsSync(cliScript)) {
    throw createCheckinError("WorkBuddy is not installed in the current Windows account.", {
      code: "installation-missing",
      retryable: false
    });
  }
  return {
    command,
    args: [cliScript, "--acp"]
  };
}

function terminateProcessTree(child, spawnSync = defaultSpawnSync) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  try {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
  } catch {
    try { child.kill(); } catch { /* best effort */ }
  }
}

function createWorkBuddyAcpTransport({
  spawn = defaultSpawn,
  spawnSync = defaultSpawnSync,
  invocation = getWorkBuddyInvocation(),
  environment = process.env
} = {}) {
  const child = spawn(invocation.command, invocation.args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" }
  });
  const events = new EventEmitter();
  let closed = false;

  child.stdout?.on("data", data => events.emit("stdout", data));
  child.stderr?.on("data", data => events.emit("stderr", data));
  child.once("error", error => events.emit("error", error));
  child.once("exit", (code, signal) => events.emit("close", code, signal));

  return {
    on: (eventName, listener) => events.on(eventName, listener),
    write(data) {
      if (!closed && child.stdin?.writable) child.stdin.write(data);
    },
    close() {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(); } catch { /* best effort */ }
      terminateProcessTree(child, spawnSync);
    }
  };
}

module.exports = { getWorkBuddyInvocation, terminateProcessTree, createWorkBuddyAcpTransport };
