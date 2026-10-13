const { spawn } = require("node:child_process");
const path = require("node:path");
const { parseCliProbe } = require("../cli-version-probe.cjs");
const { parseVersion } = require("../codex-app-server/version-service.cjs");
const { createCliVersionService } = require("../cli-version-service.cjs");

const PACKAGE = "@tencent-ai/codebuddy-code";
const REGISTRY_URL = "https://registry.npmjs.org/@tencent-ai%2fcodebuddy-code/latest";
const CHECK_TIMEOUT_MS = 15000;
const UPDATE_TIMEOUT_MS = 180000;

const bashProbe = `command -v codebuddy >/dev/null 2>&1 || exit 2
command_path=$(command -v codebuddy)
resolved_path=$(readlink -f "$command_path" 2>/dev/null || printf '%s' "$command_path")
version=$(codebuddy --version) || exit 3
npm_root=$(npm root -g 2>/dev/null || true)
if [ -n "$npm_root" ] && [ -d "$npm_root/@tencent-ai/codebuddy-code" ]; then npm_owned=1; else npm_owned=0; fi
printf '%s\\n' '__PANNEL_CODEBUDDY_PROBE_BEGIN__' '__PANNEL_CODEBUDDY_VERSION_BEGIN__' "$version" '__PANNEL_CODEBUDDY_VERSION_END__'
printf 'commandPath=%s\\nresolvedPath=%s\\nnpmRoot=%s\\nnpmOwned=%s\\n' "$command_path" "$resolved_path" "$npm_root" "$npm_owned"
printf '%s\\n' '__PANNEL_CODEBUDDY_PROBE_END__'`;
const powerShellProbe = `$ErrorActionPreference = 'Stop'
$command = Get-Command codebuddy -ErrorAction Stop | Select-Object -First 1
$version = (& $command.Source --version) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy CLI 版本命令执行失败。' }
$npmRoot = try { (& npm.cmd root -g 2>$null | Select-Object -First 1) } catch { '' }
$npmPackage = if ($npmRoot) { Join-Path $npmRoot '@tencent-ai\\codebuddy-code' } else { '' }
$npmOwned = if ($npmPackage -and (Test-Path $npmPackage) -and (Select-String -LiteralPath $command.Source -Pattern '@tencent-ai/codebuddy-code' -Quiet -ErrorAction SilentlyContinue)) { '1' } else { '0' }
@('__PANNEL_CODEBUDDY_PROBE_BEGIN__', '__PANNEL_CODEBUDDY_VERSION_BEGIN__', $version, '__PANNEL_CODEBUDDY_VERSION_END__', "commandPath=$($command.Source)", "resolvedPath=$($command.Source)", "npmRoot=$npmRoot", "npmOwned=$npmOwned", '__PANNEL_CODEBUDDY_PROBE_END__') -join [Environment]::NewLine`;

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

function runProcess(executable, args, { timeoutMs, spawnProcess, onOutput }) {
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
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(0, 16000); onOutput?.(chunk); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(0, 4000); onOutput?.(chunk); });
    child.on("error", finish);
    child.on("close", code => finish(code === 0 ? null : new Error(stderr.trim() || `CodeBuddy 命令退出：${code}`), stdout.trim()));
  });
}

function createCodeBuddyVersionService({ terminalManager, sshAgentTransport, spawnProcess = spawn, fetchLatest = globalThis.fetch, executeCommand = null }) {
  function target(id) {
    const session = terminalManager.getSession(String(id || ""));
    if (!session || session.runtimeMode !== "app-server" || session.agentProvider !== "codebuddy")
      throw new Error("仅 CodeBuddy 图形会话支持版本更新。");
    if (session.type === "ssh" && session.agentLocation !== "local") return { key: `ssh:${session.id}`, platform: "linux", session };
    if (session.type === "wsl") return { key: `wsl:${session.wslDistro}`, platform: "linux", session };
    return { key: "windows", platform: "windows", session };
  }
  async function run(value, script, timeoutMs, onOutput) {
    if (executeCommand) return executeCommand(value, script, timeoutMs, onOutput);
    if (value.session.type === "ssh" && value.session.agentLocation !== "local")
      return sshAgentTransport.exec(value.session.id, `bash -lic ${quoteBash(script)}`, { actionName: "CodeBuddy version update", timeoutMs, onStdout: onOutput, onStderr: onOutput });
    if (value.platform === "linux") return runProcess("wsl.exe", ["-d", value.session.wslDistro, "--", "bash", "-lic", script], { timeoutMs, spawnProcess, onOutput });
    return runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs, spawnProcess, onOutput });
  }
  async function probe(value) {
    const output = await run(value, value.platform === "windows" ? powerShellProbe : bashProbe, CHECK_TIMEOUT_MS);
    const lines = parseCliProbe(output, {
      marker: "CODEBUDDY", keys: ["commandPath", "resolvedPath", "npmRoot", "npmOwned"],
      incompleteMessage: "CodeBuddy 版本检测返回内容不完整。",
    });
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
  return createCliVersionService({
    target, probe, latestVersion,
    install: (value, onOutput) => run(value, value.platform === "windows" ? `npm.cmd install -g ${PACKAGE}@latest` : `npm install -g ${PACKAGE}@latest`, UPDATE_TIMEOUT_MS, onOutput),
    messages: {
      manualUpdate: "请使用该环境原有的安装方式手动更新 CodeBuddy。",
      updating: "此环境中的 CodeBuddy 正在更新。",
      checkFirst: "请先检测可更新的 CodeBuddy npm 安装。",
      installationChanged: "CodeBuddy 安装已变化，请重新检查更新。",
      verificationFailed: "安装命令已完成，但当前 CodeBuddy 命令未切换到新版本。",
    },
  });
}

module.exports = { createCodeBuddyVersionService, installation };
