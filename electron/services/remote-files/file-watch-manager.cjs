const path = require("node:path");
const { normalizeWslPath, toWslHostPath } = require("./remote-file-service.cjs");

const WSL_UNC_PREFIX = "\\\\wsl.localhost\\";

function createFileWatchManager({ terminalManager, broadcast, chokidarLoader = () => import("chokidar") }) {
  const watchers = new Map();
  let chokidarPromise = null;

  function getChokidar() {
    chokidarPromise ||= Promise.resolve(chokidarLoader()).then((module) => module.default || module);
    return chokidarPromise;
  }

  async function stop(sessionId) {
    const watcher = watchers.get(sessionId);
    watchers.delete(sessionId);
    if (watcher) await watcher.close();
  }

  async function setDirectories(sessionId, directories) {
    await stop(sessionId);
    const session = terminalManager.getSession(sessionId);
    if (!session || session.type === "ssh") return false;
    const displayPaths = Array.from(new Set((directories || []).filter((value) => typeof value === "string" && value.trim())));
    if (displayPaths.length === 0) return true;
    const hostPaths = displayPaths.map((displayPath) => session.type === "wsl"
      ? toWslHostPath(session.wslDistro, normalizeWslPath(displayPath))
      : path.resolve(displayPath));
    const chokidar = await getChokidar();
    const watchOptions = {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 50 }
    };
    if (session.type === "wsl" && hostPaths.some((hostPath) => hostPath.toLowerCase().startsWith(WSL_UNC_PREFIX))) {
      watchOptions.usePolling = true;
      watchOptions.interval = 250;
      watchOptions.binaryInterval = 500;
    }
    const watcher = chokidar.watch(hostPaths, watchOptions);
    let timer = null;
    const changed = new Set();
    const flush = () => {
      timer = null;
      broadcast("remote-files:changed", { sessionId, paths: Array.from(changed) });
      changed.clear();
    };
    watcher.on("all", (_event, hostPath) => {
      const index = hostPaths.findIndex((root) => hostPath === root || hostPath.startsWith(`${root}${path.sep}`));
      changed.add(displayPaths[Math.max(0, index)]);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 180);
    });
    watcher.on("error", (error) => broadcast("remote-files:watch-error", { sessionId, error: error instanceof Error ? error.message : String(error) }));
    watchers.set(sessionId, watcher);
    return true;
  }

  async function shutdown() {
    await Promise.all(Array.from(watchers.keys()).map(stop));
  }

  return { setDirectories, stop, shutdown };
}

module.exports = { createFileWatchManager };
