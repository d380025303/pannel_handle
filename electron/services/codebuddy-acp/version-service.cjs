const { spawn } = require("node:child_process");
const path = require("node:path");
const { parseVersion, isNewer } = require("../codex-app-server/version-service.cjs");

const PACKAGE = "@tencent-ai/codebuddy-code";
const REGISTRY_URL = "https://registry.npmjs.org/@tencent-ai%2fcodebuddy-code/latest";
const CHECK_TIMEOUT_MS = 15000;
const UPDATE_TIMEOUT_MS = 180000;
const CACHE_MS = 60 * 60 * 1000;

const bashProbe = `command -v codebuddy >/dev/null 2>&1 || exit 2
command_path=$(command -v codebuddy)
resolved_path=$(readlink -f "$command_path" 2>/dev/null || printf '%s' "$command_path")
version=$(codebuddy --version) || exit 3
npm_root=$(npm root -g 2>/dev/null || true)
if [ -n "$npm_root" ] && [ -d "$npm_root/@tencent-ai/codebuddy-code" ]; then npm_owned=1; else npm_owned=0; fi
printf '%s\\n' "$version" "$command_path" "$resolved_path" "$npm_root" "$npm_owned"`;
const powerShellProbe = `$ErrorActionPreference = 'Stop'
$command = Get-Command codebuddy -ErrorAction Stop | Select-Object -First 1
$version = & $command.Source --version
$npmRoot = try { (& npm.cmd root -g 2>$null | Select-Object -First 1) } catch { '' }
$npmPackage = if ($npmRoot) { Join-Path $npmRoot '@tencent-ai\\codebuddy-code' } else { '' }
$npmOwned = if ($npmPackage -and (Test-Path $npmPackage) -and (Select-String -LiteralPath $command.Source -Pattern '@tencent-ai/codebuddy-code' -Quiet -ErrorAction SilentlyContinue)) { '1' } else { '0' }
@($version, $command.Source, $command.Source, $npmRoot, $npmOwned) -join [Environment]::NewLine`;

function quoteBash(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function installation(probe, platform) {
  const [, commandPath, resolvedPath, npmRoot, npmOwned] = probe;
  if (!npmRoot || npmOwned !== "1" || !commandPath || !resolvedPath) return "unknown";
  if (platform === "windows") {
    const command = path.win32.normalize(commandPath).toLowerCase();
    const shimDir = path.win32.normalize(path.win32.dirname(npmRoot)).toLowerCase();
    return command.startsWith(`${shimDir}\\`) && /^codebuddy(?:\.cmd|\.ps1)?$/i.test(path.win32.basename(commandPath)) ? "npm" : "unknown";
  }
  const resolved = path.posix.normalize(resolvedPath);
  const packageDir = path.posix.join(path.posix.normalize(npmRoot), PACKAGE);
  return resolved.startsWith(`${packageDir}/`) ? "npm" : "unknown";
}

function runProcess(executable, args, { timeoutMs, spawnProcess }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error("CodeBuddy 版本命令超时。")); }, timeoutMs);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(0, 16000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(0, 4000); });
    child.on("error", finish);
    child.on("close", code => finish(code === 0 ? null : new Error(stderr.trim() || `CodeBuddy 命令退出：${code}`), stdout.trim()));
  });
}

function createCodeBuddyVersionService({ terminalManager, sshAgentTransport, spawnProcess = spawn, fetchLatest = globalThis.fetch, executeCommand = null }) {
  const cache = new Map();
  const updating = new Set();
  function target(id) {
    const session = terminalManager.getSession(String(id || ""));
    if (!session || session.runtimeMode !== "app-server" || session.agentProvider !== "codebuddy")
      throw new Error("仅 CodeBuddy 图形会话支持版本更新。");
    if (session.type === "ssh" && session.agentLocation !== "local") return { key: `ssh:${session.id}`, platform: "linux", session };
    if (session.type === "wsl") return { key: `wsl:${session.wslDistro}`, platform: "linux", session };
    return { key: "windows", platform: "windows", session };
  }
  async function run(value, script, timeoutMs) {
    if (executeCommand) return executeCommand(value, script, timeoutMs);
    if (value.session.type === "ssh" && value.session.agentLocation !== "local")
      return sshAgentTransport.exec(value.session.id, `bash -lic ${quoteBash(script)}`, { actionName: "CodeBuddy version update", timeoutMs });
    if (value.platform === "linux") return runProcess("wsl.exe", ["-d", value.session.wslDistro, "--", "bash", "-lic", script], { timeoutMs, spawnProcess });
    return runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs, spawnProcess });
  }
  async function probe(value) {
    const output = await run(value, value.platform === "windows" ? powerShellProbe : bashProbe, CHECK_TIMEOUT_MS);
    const lines = String(output).trim().split(/\r?\n/).map(line => line.trim());
    if (lines.length < 5) throw new Error("CodeBuddy 版本检测返回内容不完整。");
    const current = parseVersion(lines[0]);
    if (!current) throw new Error("无法识别 CodeBuddy CLI 版本。");
    return { currentVersion: current.text, commandPath: lines[1], method: installation(lines, value.platform) };
  }
  async function latestVersion() {
    const response = await fetchLatest(REGISTRY_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`CodeBuddy 版本查询失败：HTTP ${response.status}`);
    const latest = parseVersion((await response.json()).version);
    if (!latest || latest.prerelease) throw new Error("无法识别 CodeBuddy 最新稳定版。");
    return latest.text;
  }
  async function check(id, force = false) {
    const value = target(id);
    if (updating.has(value.key)) return { ...cache.get(value.key)?.state, status: "updating", environment: value.key };
    const existing = cache.get(value.key);
    if (!force && existing && Date.now() - existing.at < CACHE_MS) return existing.state;
    try {
      const [installed, newest] = await Promise.all([probe(value), latestVersion()]);
      const state = { status: isNewer(parseVersion(installed.currentVersion), parseVersion(newest)) ? "available" : "current",
        ...installed, latestVersion: newest, environment: value.key,
        guidance: installed.method === "unknown" ? "请使用该环境原有的安装方式手动更新 CodeBuddy。" : null };
      cache.set(value.key, { at: Date.now(), state });
      return state;
    } catch (error) {
      const state = { status: "error", environment: value.key, error: error instanceof Error ? error.message : String(error) };
      cache.set(value.key, { at: Date.now(), state });
      return state;
    }
  }
  async function update(id) {
    const value = target(id);
    if (updating.has(value.key)) throw new Error("此环境中的 CodeBuddy 正在更新。");
    const cached = cache.get(value.key);
    if (cached?.state.status !== "available" || cached.state.method !== "npm") throw new Error("请先检测可更新的 CodeBuddy npm 安装。");
    updating.add(value.key);
    try {
      const before = await probe(value);
      if (before.commandPath !== cached.state.commandPath || before.currentVersion !== cached.state.currentVersion || before.method !== cached.state.method)
        throw new Error("CodeBuddy 安装已变化，请重新检查更新。");
      await run(value, value.platform === "windows" ? `npm.cmd install -g ${PACKAGE}@latest` : `npm install -g ${PACKAGE}@latest`, UPDATE_TIMEOUT_MS);
      const after = await probe(value);
      if (after.commandPath !== before.commandPath || after.method !== "npm" || !isNewer(parseVersion(before.currentVersion), parseVersion(after.currentVersion)))
        throw new Error("安装命令已完成，但当前 CodeBuddy 命令未切换到新版本。");
      const state = { status: isNewer(parseVersion(after.currentVersion), parseVersion(cached.state.latestVersion)) ? "available" : "current",
        ...after, latestVersion: cached.state.latestVersion, environment: value.key, restartRequired: true };
      cache.set(value.key, { at: Date.now(), state });
      return state;
    } finally { updating.delete(value.key); }
  }
  return { check, update };
}

module.exports = { createCodeBuddyVersionService, installation };
