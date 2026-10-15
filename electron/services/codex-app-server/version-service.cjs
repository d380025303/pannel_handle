const { buildWslBashArgs } = require("../../core/wsl-command.cjs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { parseCliProbe } = require("../cli-version-probe.cjs");
const { sameInstallation } = require("../cli-version-installation.cjs");
const { createUpdateProgress } = require("../cli-version-progress.cjs");

const CHECK_TIMEOUT_MS = 15000;
const UPDATE_TIMEOUT_MS = 180000;
const CACHE_MS = 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/@openai%2fcodex/latest";
const INSTALL_SH = "https://chatgpt.com/codex/install.sh";
const INSTALL_PS1 = "https://chatgpt.com/codex/install.ps1";

const bashProbe = `command -v codex >/dev/null 2>&1 || { echo "Codex CLI 命令不存在。" >&2; exit 2; }
codex_path=$(command -v codex)
resolved_path=$(readlink -f "$codex_path" 2>/dev/null || printf '%s' "$codex_path")
version=$(codex --version) || { echo "Codex CLI 版本命令执行失败。" >&2; exit 3; }
npm_root=$(npm root -g 2>/dev/null || true)
install_dir=\${CODEX_INSTALL_DIR:-$HOME/.local/bin}
codex_home=\${CODEX_HOME:-$HOME/.codex}
if [ -n "$npm_root" ] && [ -d "$npm_root/@openai/codex" ]; then npm_owned=1; else npm_owned=0; fi
if [ -d "$codex_home/packages/standalone" ]; then standalone_owned=1; else standalone_owned=0; fi
printf '%s\\n' '__PANNEL_CODEX_PROBE_BEGIN__' '__PANNEL_CODEX_VERSION_BEGIN__' "$version" '__PANNEL_CODEX_VERSION_END__'
printf 'commandPath=%s\\nresolvedPath=%s\\nnpmRoot=%s\\ninstallDir=%s\\ncodexHome=%s\\nnpmOwned=%s\\nstandaloneOwned=%s\\n' "$codex_path" "$resolved_path" "$npm_root" "$install_dir" "$codex_home" "$npm_owned" "$standalone_owned"
printf '%s\\n' '__PANNEL_CODEX_PROBE_END__'`;
const powerShellProbe = `$ErrorActionPreference = 'Stop'
$command = Get-Command codex -ErrorAction Stop | Select-Object -First 1
$version = (& $command.Source --version) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0) { throw 'Codex CLI 版本命令执行失败。' }
$npmRoot = try { (& npm.cmd root -g 2>$null | Select-Object -First 1) } catch { '' }
$installDir = if ($env:CODEX_INSTALL_DIR) { $env:CODEX_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin' }
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$npmPackage = if ($npmRoot) { Join-Path $npmRoot '@openai\\codex' } else { '' }
$npmOwned = if ($npmPackage -and (Test-Path $npmPackage) -and (Select-String -LiteralPath $command.Source -Pattern '@openai/codex' -Quiet -ErrorAction SilentlyContinue)) { '1' } else { '0' }
$standaloneOwned = if (Test-Path (Join-Path $codexHome 'packages\\standalone')) { '1' } else { '0' }
@('__PANNEL_CODEX_PROBE_BEGIN__', '__PANNEL_CODEX_VERSION_BEGIN__', $version, '__PANNEL_CODEX_VERSION_END__', "commandPath=$($command.Source)", "resolvedPath=$($command.Source)", "npmRoot=$npmRoot", "installDir=$installDir", "codexHome=$codexHome", "npmOwned=$npmOwned", "standaloneOwned=$standaloneOwned", '__PANNEL_CODEX_PROBE_END__') -join [Environment]::NewLine`;

function quoteBash(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function parseVersion(value) {
  const match = String(value || "").match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
  return match ? { text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: Boolean(match[4]) } : null;
}
function parseProbe(output) {
  const [versionOutput, ...fields] = parseCliProbe(output, {
    marker: "CODEX",
    keys: ["commandPath", "resolvedPath", "npmRoot", "installDir", "codexHome", "npmOwned", "standaloneOwned"],
    nonempty: ["commandPath", "resolvedPath", "installDir"],
    incompleteMessage: "Codex 版本检测返回内容不完整。",
  });
  const versionLines = versionOutput.split("\n");
  const version = versionLines.find(line => /^codex-cli\s+v?\d+\.\d+\.\d+/.test(line))
    || versionLines.find(line => /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(line));
  if (!version) throw new Error("无法识别 Codex CLI 版本。");
  return [version, ...fields];
}

function isNewer(current, latest) {
  for (let index = 0; index < 3; index += 1) {
    if (latest.parts[index] !== current.parts[index]) return latest.parts[index] > current.parts[index];
  }
  return current.prerelease && !latest.prerelease;
}
function runProcess(executable, args, { timeoutMs = CHECK_TIMEOUT_MS, env = process.env, spawnProcess = spawn, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error("Codex 版本命令超时。")); }, timeoutMs);
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(0, 16000); onOutput?.(chunk); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(0, 4000); onOutput?.(chunk); });
    child.on("error", finish);
    child.on("close", code => finish(code === 0 ? null : new Error(stderr.trim() || `Codex 命令退出：${code}`), stdout.trim()));
  });
}

function installation(probe, platform) {
  const [, commandPath, resolvedPath, npmRoot, installDir, , npmOwned, standaloneOwned] = probe;
  const normalize = value => platform === "windows" ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
  const command = normalize(commandPath);
  const resolved = normalize(resolvedPath);
  const root = normalize(npmRoot || "/");
  if (npmRoot && npmOwned === "1" && (platform === "windows"
    ? command.startsWith(normalize(path.win32.dirname(npmRoot)) + "\\") && /^codex(?:\.cmd|\.ps1|\.exe)?$/i.test(path.win32.basename(commandPath))
    : resolved.startsWith(root + "/@openai/codex/"))) return "npm";
  const standaloneCommand = platform === "windows" ? path.win32.join(installDir, "codex.exe") : path.posix.join(installDir, "codex");
  if (command === normalize(standaloneCommand) && standaloneOwned === "1") return "standalone";
  return "unknown";
}

function createCodexVersionService({ terminalManager, sshAgentTransport, spawnProcess = spawn, fetchLatest = globalThis.fetch, executeCommand = null }) {
  const cache = new Map();
  const updating = new Set();
  const progress = new Map();
  const revisions = new Map();
  function target(id) {
    const session = terminalManager.getSession(String(id || ""));
    if (!session || session.runtimeMode !== "app-server" || (session.agentProvider && session.agentProvider !== "codex"))
      throw new Error("仅 Codex 图形会话支持版本更新。");
    if (session.type === "ssh" && session.agentLocation !== "local") return { key: `ssh:${session.id}`, platform: "linux", session };
    if (session.type === "wsl") return { key: `wsl:${session.wslDistro}`, platform: "linux", session };
    return { key: "windows", platform: "windows", session };
  }
  async function run(targetValue, script, timeoutMs, onOutput) {
    if (executeCommand) return executeCommand(targetValue, script, timeoutMs, onOutput);
    if (targetValue.session.type === "ssh" && targetValue.session.agentLocation !== "local")
      return sshAgentTransport.exec(targetValue.session.id, `bash -lic ${quoteBash(script)}`, { actionName: "Codex version update", timeoutMs, onStdout: onOutput, onStderr: onOutput });
    if (targetValue.platform === "linux") return runProcess("wsl.exe", buildWslBashArgs(targetValue.session.wslDistro, script), { timeoutMs, spawnProcess, onOutput });
    return runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs, spawnProcess, onOutput });
  }
  async function probe(targetValue) {
    const output = await run(targetValue, targetValue.platform === "windows" ? powerShellProbe : bashProbe, CHECK_TIMEOUT_MS);
    const lines = parseProbe(output);
    const current = parseVersion(lines[0]);
    if (!current) throw new Error("无法识别 Codex CLI 版本。");
    return { currentVersion: current.text, commandPath: lines[1], resolvedPath: lines[2], method: installation(lines, targetValue.platform) };
  }
  async function latestVersion() {
    const response = await fetchLatest(REGISTRY_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Codex 版本查询失败：HTTP ${response.status}`);
    const latest = parseVersion((await response.json()).version);
    if (!latest || latest.prerelease) throw new Error("无法识别 Codex 最新稳定版。");
    return latest.text;
  }
  function versionState(value, installed, newest) {
    return { status: isNewer(parseVersion(installed.currentVersion), parseVersion(newest)) ? "available" : "current",
      ...installed, latestVersion: newest, environment: value.key,
      guidance: installed.method === "unknown" ? "请使用该环境原有的安装方式手动更新 Codex。" : null };
  }
  async function check(id, force = false) {
    const value = target(id);
    if (updating.has(value.key)) return { ...(cache.get(value.key)?.state || {}), status: "updating", environment: value.key, progress: progress.get(value.key)?.snapshot() };
    const existing = cache.get(value.key);
    if (!force && existing && Date.now() - existing.at < CACHE_MS) return existing.state;
    const revision = revisions.get(value.key) || 0;
    try {
      const [installed, newest] = await Promise.all([probe(value), latestVersion()]);
      if (revision !== (revisions.get(value.key) || 0))
        return { ...(cache.get(value.key)?.state || {}), ...(updating.has(value.key) ? { status: "updating", progress: progress.get(value.key)?.snapshot() } : {}) };
      const state = versionState(value, installed, newest);
      cache.set(value.key, { at: Date.now(), state });
      return state;
    } catch (error) {
      if (revision !== (revisions.get(value.key) || 0))
        return { ...(cache.get(value.key)?.state || {}), ...(updating.has(value.key) ? { status: "updating", progress: progress.get(value.key)?.snapshot() } : {}) };
      const state = { status: "error", environment: value.key, error: error instanceof Error ? error.message : String(error) };
      cache.set(value.key, { at: Date.now(), state });
      return state;
    }
  }
  async function update(id) {
    const value = target(id);
    if (updating.has(value.key)) throw new Error("此环境中的 Codex 正在更新。");
    const cached = cache.get(value.key);
    if (cached?.state.status !== "available" || cached.state.method === "unknown") throw new Error("请先检测可更新的 Codex 安装。");
    updating.add(value.key);
    const updateProgress = createUpdateProgress();
    progress.set(value.key, updateProgress);
    revisions.set(value.key, (revisions.get(value.key) || 0) + 1);
    try {
      const before = await probe(value);
      if (!sameInstallation(before, cached.state, value.platform) || before.currentVersion !== cached.state.currentVersion) {
        const state = versionState(value, before, cached.state.latestVersion);
        cache.set(value.key, { at: Date.now(), state });
        return state;
      }
      const script = before.method === "npm" ? value.platform === "windows"
        ? "npm.cmd install -g @openai/codex@latest" : "npm install -g @openai/codex@latest"
        : value.platform === "windows"
          ? `$env:CODEX_NON_INTERACTIVE='1'; Invoke-RestMethod '${INSTALL_PS1}' | Invoke-Expression`
          : `set -o pipefail; curl -fsSL ${quoteBash(INSTALL_SH)} | CODEX_NON_INTERACTIVE=1 sh`;
      updateProgress.setStage("installing");
      await run(value, script, UPDATE_TIMEOUT_MS, updateProgress.append);
      updateProgress.setStage("verifying");
      const after = await probe(value);
      if (!sameInstallation(before, after, value.platform) || !isNewer(parseVersion(before.currentVersion), parseVersion(after.currentVersion)))
        throw new Error("安装命令已完成，但当前 Codex 命令未切换到新版本。");
      const state = { status: isNewer(parseVersion(after.currentVersion), parseVersion(cached.state.latestVersion)) ? "available" : "current",
        ...after, latestVersion: cached.state.latestVersion, environment: value.key, restartRequired: true };
      updateProgress.setStage("complete");
      const completed = { ...state, progress: updateProgress.snapshot() };
      cache.set(value.key, { at: Date.now(), state: completed });
      return completed;
    } catch (error) {
      updateProgress.setStage("failed");
      cache.set(value.key, { at: Date.now(), state: { ...cached.state, status: "error", error: error instanceof Error ? error.message : String(error), progress: updateProgress.snapshot() } });
      throw error;
    } finally { updating.delete(value.key); progress.delete(value.key); }
  }
  return { check, update };
}

module.exports = { createCodexVersionService, parseVersion, isNewer, installation, parseProbe };
