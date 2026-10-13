const { spawn } = require("node:child_process");

function stopAgentChild(child, provider, { platform = process.platform, spawnKiller = spawn, onError = console.error } = {}) {
  if (child.exitCode != null || child.signalCode != null) return;
  const usesProcessTree = ["codebuddy", "opencode", "claude", "qoder", "gemini", "grok"].includes(provider);
  if (!usesProcessTree || platform !== "win32" || !Number.isInteger(child.pid)) {
    child.kill();
    return;
  }
  let failed = false;
  const fallback = error => {
    if (failed) return;
    failed = true;
    onError(`Failed to stop ${provider} process tree ${child.pid}:`, error);
    try { child.kill(); }
    catch (killError) { onError(`Failed to stop ${provider} process ${child.pid}:`, killError); }
  };
  try {
    const killer = spawnKiller("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", fallback);
    killer.once("exit", code => { if (code !== 0 && child.exitCode == null) fallback(new Error(`taskkill exited with code ${code}`)); });
  } catch (error) { fallback(error); }
}

module.exports = { stopAgentChild };
