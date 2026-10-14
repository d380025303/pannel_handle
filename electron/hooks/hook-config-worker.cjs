const { parentPort, workerData } = require("node:worker_threads");
const { createHookConfigManager } = require("./hook-config-manager.cjs");

const manager = createHookConfigManager({ assetsDir: workerData.assetsDir });
parentPort.postMessage(manager[workerData.method](workerData.target, workerData.providers));
