import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createAsyncHookConfigManager } = require("./hook-config-worker-client.cjs");
const { registerIpcHandlers } = require("../core/ipc-handlers.cjs");
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function fixture(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-worker-test-"));
  dirs.push(dir);
  const workerPath = path.join(dir, "worker.cjs");
  fs.writeFileSync(workerPath, source);
  return workerPath;
}

it("keeps timers and other IPC responsive during five delayed WSL process calls", async () => {
  const workerPath = fixture(`
    require('node:child_process').spawnSync = (_command, args) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      if (args[3] === 'test') return { status: args[4] === '-d' ? 0 : 1 };
      return { status: 1, stderr: 'No such file or directory' };
    };
    require(${JSON.stringify(path.join(import.meta.dirname, "hook-config-worker.cjs"))});
  `);
  const manager = createAsyncHookConfigManager({ workerPath });
  const handlers = new Map();
  registerIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: vi.fn() },
    terminalManager: { listSessions: () => [{ id: "responsive" }] },
    hookConfigManager: manager
  });
  let finished = false;
  const timer = new Promise(resolve => setTimeout(resolve, 0));
  const checking = handlers.get("hooks:inspect")({}, {
    target: { type: "wsl", path: "/project", wslDistro: "Ubuntu" }, providers: ["codex"]
  }).then(result => { finished = true; return result; });
  await timer;
  expect(finished).toBe(false);
  expect(await handlers.get("sessions:list")({})).toEqual([{ id: "responsive" }]);
  expect(finished).toBe(false);
  const result = await checking;
  expect(result.ok).toBe(true);
  expect(result.providers.codex.status).toBe("not_installed");
});

it("orders WSL operations and preserves install results", async () => {
  const workerPath = fixture(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const marker = workerData.target.path;
    if (workerData.method === 'install') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      fs.writeFileSync(marker, 'installed');
    }
    parentPort.postMessage({ ok: true, providers: { codex: { status: fs.readFileSync(marker, 'utf8') } } });
  `);
  const manager = createAsyncHookConfigManager({ workerPath });
  const target = { type: "wsl", path: path.join(path.dirname(workerPath), "marker"), wslDistro: "Ubuntu" };
  const installing = manager.install(target, ["codex"]);
  const checking = manager.inspect(target, ["codex"]);
  expect(await installing).toEqual(await checking);
});

it.each(["throw new Error('worker failed');", "process.exit(0);", "process.exit(2);"])("returns structured errors for worker failures: %s", async source => {
  const manager = createAsyncHookConfigManager({ workerPath: fixture(source) });
  const target = { type: "wsl", path: "/project", wslDistro: "Ubuntu" };
  expect(await manager.inspect(target)).toMatchObject({ ok: false, error: expect.any(String), providers: {} });
  expect(await manager.install(target)).toMatchObject({ ok: false, error: expect.any(String), providers: {} });
});

it("retains local synchronous behavior", () => {
  const workerPath = fixture("throw new Error('should not start');");
  const manager = createAsyncHookConfigManager({ workerPath });
  const result = manager.install({ type: "windows", path: path.dirname(workerPath) }, ["codex"]);
  expect(result.ok).toBe(true);
  expect(manager.inspect({ type: "windows", path: path.dirname(workerPath) }, ["codex"])).toEqual(result);
});
