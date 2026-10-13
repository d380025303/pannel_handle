const path = require("node:path");
const { normalizeWslPath, toWslHostPath } = require("./remote-file-service.cjs");

const WSL_UNC_PREFIX = "\\\\wsl.localhost\\";

function createFileWatchManager({ terminalManager, broadcast, chokidarLoader = () => import("chokidar") }) {
  const watchers = new Map();
  const operations = new Map();
  let chokidarPromise = null;

  function getChokidar() {
    chokidarPromise ||= Promise.resolve(chokidarLoader()).then((module) => module.default || module);
    return chokidarPromise;
  }

  function enqueue(sessionId, operation) {
    const previous = operations.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    operations.set(sessionId, next);
    void next.finally(() => {
      if (operations.get(sessionId) === next) operations.delete(sessionId);
    }).catch(() => undefined);
    return next;
  }

  async function closeWatcher(sessionId) {
    const state = watchers.get(sessionId);
    watchers.delete(sessionId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    await state.watcher.close();
  }

  function stop(sessionId) {
    return enqueue(sessionId, () => closeWatcher(sessionId));
  }

  function setDirectories(sessionId, directories) {
    return enqueue(sessionId, async () => {
      const session = terminalManager.getSession(sessionId);
      if (!session || session.type === "ssh") {
        await closeWatcher(sessionId);
        return false;
      }
      const displayPaths = Array.from(new Set((directories || []).filter((value) => typeof value === "string" && value.trim())));
      const paths = new Map(displayPaths.map((displayPath) => [session.type === "wsl"
        ? toWslHostPath(session.wslDistro, normalizeWslPath(displayPath))
        : path.resolve(displayPath), displayPath]));
      if (paths.size === 0) {
        await closeWatcher(sessionId);
        return true;
      }
      const usePolling = session.type === "wsl" && [...paths.keys()].some((hostPath) => hostPath.toLowerCase().startsWith(WSL_UNC_PREFIX));
      let state = watchers.get(sessionId);
      if (state && state.usePolling !== usePolling) {
        await closeWatcher(sessionId);
        state = undefined;
      }
      if (state) {
        const removed = [...state.paths.keys()].filter((hostPath) => !paths.has(hostPath));
        const added = [...paths.keys()].filter((hostPath) => !state.paths.has(hostPath));
        state.paths = paths;
        if (removed.length > 0) await state.watcher.unwatch(removed);
        if (added.length > 0) state.watcher.add(added);
        return true;
      }
      const chokidar = await getChokidar();
      const watchOptions = {
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 50 }
      };
      if (usePolling) {
        watchOptions.usePolling = true;
        watchOptions.interval = 250;
        watchOptions.binaryInterval = 500;
      }
      const watcher = chokidar.watch([...paths.keys()], watchOptions);
      state = { watcher, paths, usePolling, timer: null, changed: new Set(), changedFiles: new Set() };
      watcher.on("all", (_event, hostPath) => {
        const matching = [...state.paths.keys()]
          .filter((root) => hostPath === root || hostPath.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`))
          .sort((left, right) => right.length - left.length)[0];
        if (!matching) return;
        state.changed.add(state.paths.get(matching));
        const relativePath = path.relative(matching, hostPath);
        const displayRoot = state.paths.get(matching);
        state.changedFiles.add(session.type === "wsl"
          ? path.posix.join(normalizeWslPath(displayRoot), relativePath.split(path.sep).join("/"))
          : path.join(displayRoot, relativePath));
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          broadcast("remote-files:changed", { sessionId, paths: [...state.changed], changedFiles: [...state.changedFiles] });
          state.changed.clear();
          state.changedFiles.clear();
        }, 180);
      });
      watcher.on("error", (error) => broadcast("remote-files:watch-error", { sessionId, error: error instanceof Error ? error.message : String(error) }));
      watchers.set(sessionId, state);
      return true;
    });
  }

  async function shutdown() {
    await Promise.all([...operations.values()].map((operation) => operation.catch(() => undefined)));
    await Promise.all(Array.from(watchers.keys()).map(stop));
  }

  return { setDirectories, stop, shutdown };
}

module.exports = { createFileWatchManager };
