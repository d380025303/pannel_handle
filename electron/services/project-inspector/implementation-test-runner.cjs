const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { resolveCodexExecutable } = require("./reviewer-agent-runner.cjs");
const { inspectorInvocationArgs, assertInspectorConfiguration, resolveInspectorMcpServers } = require("./inspector-session-policy.cjs");
const { redact } = require("./project-profiler.cjs");

async function resolvePnpm() {
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "pnpm.cmd");
    try { await fs.access(candidate); return candidate; } catch { /* Next PATH entry. */ }
  }
  throw new Error("未找到 pnpm，无法执行实施验收。");
}
async function resolveNode() {
  for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "node.exe");
    try { await fs.access(candidate); return candidate; } catch { /* Next PATH entry. */ }
  }
  throw new Error("未找到 Node 原生程序，无法执行实施验收。");
}
function createImplementationTestRunner({ resolveExecutable = resolveCodexExecutable, resolvePackageManager = resolvePnpm, resolveNodeExecutable = resolveNode, spawnProcess = spawn, timeoutMs = 300000 } = {}) {
  return async function run({ cwd, signal }) {
    signal?.throwIfAborted();
    const manifestPath = path.join(cwd, "package.json");
    if ((await fs.stat(manifestPath)).size > 2 * 1024 * 1024) throw new Error("package.json 超过读取上限。");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (typeof manifest.scripts?.test !== "string" || !manifest.scripts.test.trim()) throw new Error("项目没有 test 脚本，请先补充可执行验收，不能直接标记测试通过。");
    const scripts = ["test", ...(typeof manifest.scripts.build === "string" && manifest.scripts.build.trim() ? ["build"] : [])];
    const executable = await resolveExecutable();
    const pnpm = await resolvePackageManager();
    const node = await resolveNodeExecutable();
    const invocationArgs = inspectorInvocationArgs(await resolveInspectorMcpServers(cwd), { inspectorStage: "implementation" });
    const toolingRoot = path.join(cwd, `.inspector-tools-${randomUUID()}`);
    const toolingPackage = path.join(toolingRoot, "pnpm");
    await fs.mkdir(toolingRoot);
    try { await fs.cp(path.join(path.dirname(pnpm), "node_modules", "pnpm"), toolingPackage, { recursive: true, dereference: true }); }
    catch (error) { await fs.rm(toolingRoot, { recursive: true }); throw new Error("无法准备受控 pnpm 工具副本：" + redact(error.message)); }
    const pnpmScript = path.join(toolingPackage, "bin", "pnpm.cjs");
    const child = spawnProcess(executable, invocationArgs, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    let nextId = 0, buffer = "", stopped = false, shutdown = Promise.resolve();
    const stop = () => {
      if (stopped) return shutdown; stopped = true;
      shutdown = new Promise(resolve => {
        if (process.platform === "win32" && child.pid) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { child.kill(); resolve(); });
        else { child.kill(); resolve(); }
      });
      child.stdout.destroy(); child.stderr.destroy();
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("实施验收进程已停止。")); }
      pending.clear();
      return shutdown;
    };
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {});
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { stop(); return; }
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        let message; try { message = JSON.parse(line); } catch { stop(); return; }
        const request = pending.get(message.id);
        if (request && (message.result !== undefined || message.error)) {
          pending.delete(message.id); clearTimeout(request.timer);
          if (message.error) request.reject(new Error(redact(message.error.message || "沙箱命令失败。")));
          else request.resolve(message.result);
        } else if (message.method && message.id !== undefined) {
          child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Verification does not authorize tools or escalations" } }) + "\n");
        }
      }
    });
    child.on("error", stop); child.on("exit", stop);
    function request(method, params, duration = 15000) {
      if (stopped || signal?.aborted) return Promise.reject(new Error("实施验收已取消或进程不可用。"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("实施验收超过时间限制。")); stop(); }, duration);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    }
    const results = [];
    try {
      await request("initialize", { clientInfo: { name: "pannel_inspector_verification", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      const configuration = await request("config/read", { cwd, includeLayers: false });
      assertInspectorConfiguration(configuration.config, { data: [] }, { inspectorStage: "implementation" });
      for (const script of scripts) {
        signal?.throwIfAborted();
        const startedAt = Date.now();
        const response = await request("command/exec", { command: [node, pnpmScript, "run", script], cwd,
          timeoutMs, sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }, timeoutMs + 10000);
        const output = String(response.stdout || "") + String(response.stderr || "");
        const result = { script, exitCode: response.exitCode, passed: response.exitCode === 0, timedOut: false,
          output: redact(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll(cwd, "[实施工作树]").slice(0, 65536), truncated: Buffer.byteLength(output) >= 65536, startedAt, durationMs: Date.now() - startedAt };
        results.push(result);
        if (!result.passed) break;
      }
      return { passed: results.length === scripts.length && results.every(result => result.passed), results, completedAt: Date.now(), sandbox: "workspace-write", networkAccess: false };
    } finally {
      signal?.removeEventListener("abort", abort); await stop();
      const canonicalCwd = await fs.realpath(cwd);
      const canonicalTools = await fs.realpath(toolingRoot);
      if (path.dirname(canonicalTools).toLowerCase() !== canonicalCwd.toLowerCase() || (await fs.lstat(toolingRoot)).isSymbolicLink()) throw new Error("测试工具目录被重定向，请人工检查；未自动删除。");
      await fs.rm(toolingRoot, { recursive: true });
    }

  };
}
module.exports = { createImplementationTestRunner };
