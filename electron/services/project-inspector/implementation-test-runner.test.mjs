import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createImplementationTestRunner } = require("./implementation-test-runner.cjs");
const { DISABLED_FEATURES } = require("./reviewer-agent-runner.cjs");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture({ code = 0, hold = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-validation-")); roots.push(root);
  const cwd = path.join(root, "worktree"); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "test fixture", build: "build fixture" } }));
  const packageRoot = path.join(root, "tools", "node_modules", "pnpm", "bin"); fs.mkdirSync(packageRoot, { recursive: true }); fs.writeFileSync(path.join(packageRoot, "pnpm.cjs"), "// trusted tool fixture");
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
  const requests = []; let buffer = "";
  child.stdin.on("data", chunk => {
    buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line); requests.push(message); if (message.id === undefined) continue;
      const config = { sandbox_mode: "workspace-write", approval_policy: "never", web_search: "disabled", sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true }, features: { ...Object.fromEntries(DISABLED_FEATURES.map(name => [name, false])), shell_tool: true, unified_exec: true, code_mode: true, code_mode_host: true, skip_host_skill_discovery: true } };
      if (hold && message.method === "command/exec") continue;
      const result = message.method === "config/read" ? { config } : message.method === "command/exec" ? { exitCode: code, stdout: "actual output\napi_key=abcdefghijklmno", stderr: "" } : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }
  });
  const spawnProcess = vi.fn(() => child);
  const run = createImplementationTestRunner({ resolveExecutable: async () => "codex.exe", resolvePackageManager: async () => path.join(root, "tools", "pnpm.cmd"), resolveNodeExecutable: async () => "C:/trusted/node.exe", spawnProcess, timeoutMs: 1000 });
  return { run, cwd, requests, child, spawnProcess };
}
it("records actual exit codes for test and build with explicit no-network workspace policies", async () => {
  const f = fixture(); const result = await f.run({ cwd: f.cwd });
  expect(result.passed).toBe(true); expect(result.results.map(item => item.script)).toEqual(["test", "build"]);
  expect(result.results[0].output).not.toContain("abcdefghijklmno");
  const commands = f.requests.filter(item => item.method === "command/exec");
  expect(commands).toHaveLength(2);
  expect(commands[0].params.command).toEqual(["C:/trusted/node.exe", expect.stringContaining("pnpm.cjs"), "run", "test"]);
  expect(commands[0].params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [f.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  expect(fs.readdirSync(f.cwd)).toEqual(["package.json"]);
});
it("never reports a failed command as passing and skips build after test failure", async () => {
  const f = fixture({ code: 3 }); const result = await f.run({ cwd: f.cwd });
  expect(result.passed).toBe(false); expect(result.results).toHaveLength(1); expect(result.results[0].exitCode).toBe(3);
});
it("rejects a project without tests rather than silently passing", async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.cwd, "package.json"), JSON.stringify({ scripts: { build: "only build" } }));
  await expect(f.run({ cwd: f.cwd })).rejects.toThrow("没有 test 脚本"); expect(f.spawnProcess).not.toHaveBeenCalled();
});
it("cancels a live command, closes the native process and removes only its temporary tools", async () => {
  const f = fixture({ hold: true }); const controller = new AbortController();
  const operation = f.run({ cwd: f.cwd, signal: controller.signal });
  const rejection = expect(operation).rejects.toThrow("停止");
  await vi.waitFor(() => expect(f.requests.some(item => item.method === "command/exec")).toBe(true));
  controller.abort(); await rejection;
  expect(f.child.kill).toHaveBeenCalled(); expect(fs.readdirSync(f.cwd)).toEqual(["package.json"]);
});
