const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { createHookConfigManager } = require("./hook-config-manager.cjs");

function createAsyncHookConfigManager({ assetsDir, workerPath = path.join(__dirname, "hook-config-worker.cjs") } = {}) {
  const localManager = createHookConfigManager({ assetsDir });
  let pending = Promise.resolve();

  function run(method, target, providers) {
    if (target?.type !== "wsl") return localManager[method](target, providers);
    // Keep installs and inspections ordered so snapshots cannot overlap another install.
    const result = pending.then(() => new Promise(resolve => {
      let worker;
      let response;
      let received = false;
      const fail = error => resolve({ ok: false, error: error.message, providers: {} });
      try {
        worker = new Worker(workerPath, { workerData: { method, target, providers, assetsDir } });
      } catch (error) {
        fail(error);
        return;
      }
      worker.once("message", value => { response = value; received = true; });
      worker.once("error", fail);
      worker.once("exit", code => {
        if (code === 0 && received) resolve(response);
        else fail(new Error(`Hook worker exited without a result (code ${code}).`));
      });
    }));
    pending = result.then(() => undefined);
    return result;
  }

  return {
    inspect: (target, providers) => run("inspect", target, providers),
    install: (target, providers) => run("install", target, providers)
  };
}

module.exports = { createAsyncHookConfigManager };
