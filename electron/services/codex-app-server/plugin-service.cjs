const { spawn } = require("node:child_process");
const { parse: parseToml, stringify: stringifyToml } = require("smol-toml");

const MAX_OUTPUT = 16 * 1024 * 1024;
const TIMEOUT_MS = 120000;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function bashQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function isPowerShell(shell) { return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(String(shell || "")); }
function requiredName(value, label) {
  if (typeof value !== "string" || !NAME.test(value)) throw new Error(`${label}无效。`);
  return value;
}
function requiredSource(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("-") || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error("插件来源无效。");
  return value.trim();
}
function publicOverrides(settings) {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value && typeof value === "object")
    .map(([key, value]) => [key, typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}]));
}
function runProcess(executable, args, options, spawnProcess = spawn, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { ...options, windowsHide: true, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let finished = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error("Codex 插件命令超时。")); }, TIMEOUT_MS);
    function finish(error, output) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    }
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > MAX_OUTPUT) { child.kill(); finish(new Error("Codex 插件输出过大。")); } });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on("error", finish);
    child.on("close", code => finish(code === 0 ? null : new Error(stderr.trim() || `Codex 插件命令退出：${code}`), stdout.trim()));
    if (input !== null) {
      child.stdin.on("error", finish);
      child.stdin.end(input);
    }
  });
}

function createCodexPluginService({ terminalManager, graphicalService, environmentService, sshAgentTransport, spawnProcess = spawn }) {
  function target(id) {
    const session = terminalManager.getSession(String(id || ""));
    if (!session || session.runtimeMode !== "app-server" || (session.agentProvider && session.agentProvider !== "codex"))
      throw new Error("仅 Codex 图形会话支持插件管理。");
    const cwd = graphicalService.getWorkspaceCwd(session.id);
    if (!cwd) throw new Error("Codex 项目目录不可用。");
    return { session, cwd, remote: session.type === "ssh" && session.agentLocation !== "local",
      linux: session.type === "wsl" || (session.type === "ssh" && session.agentLocation !== "local") };
  }
  async function run(value, args) {
    const environment = environmentService.resolve(value.session);
    const before = String(value.session.initialCommand || "").trim();
    if (value.linux) {
      const script = [
        ...Object.entries(environment).map(([key, val]) => {
          if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) throw new Error("环境变量名无效。");
          return `export ${key}=${bashQuote(val)}`;
        }),
        `cd ${bashQuote(value.cwd)}`,
        ...(before ? [`{ ${before}; } 1>&2`] : []),
        `codex ${args.map(bashQuote).join(" ")}`
      ].join(" && ");
      if (value.remote) return sshAgentTransport.exec(value.session.id, `bash -lic ${bashQuote(script)}`,
        { actionName: "Codex plugin management", timeoutMs: TIMEOUT_MS });
      return runProcess("wsl.exe", ["-d", value.session.wslDistro, "--", "bash", "-lic", script],
        { env: process.env }, spawnProcess);
    }
    const script = `Set-Location -LiteralPath ${psQuote(value.cwd)}; & codex ${args.map(psQuote).join(" ")}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    return runWindows(value, script, environment);
  }
  function runWindows(value, script, environment, input = null) {
    const before = String(value.session.initialCommand || "").trim();
    const env = { ...process.env, ...environment };
    if (before && !isPowerShell(value.session.shell)) {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      return runProcess("cmd.exe", ["/d", "/s", "/c",
        `(${before}) 1>&2 && powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`],
      { cwd: value.cwd, env }, spawnProcess, input);
    }
    const command = `Set-Location -LiteralPath ${psQuote(value.cwd)}; ${before ? `& { ${before} } 1>&2; if (-not $?) { exit 1 }; ` : ""}${script}`;
    return runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { env }, spawnProcess, input);
  }
  async function json(value, args) {
    const output = await run(value, [...args, "--json"]);
    if (output.length > MAX_OUTPUT) throw new Error("Codex 插件输出过大。");
    try { return JSON.parse(output); } catch { throw new Error("Codex 插件命令返回了无法解析的数据。"); }
  }
  async function list(id) {
    const value = target(id);
    if (typeof graphicalService.listPlugins === "function") {
      const response = await graphicalService.listPlugins(id);
      const plugins = response.marketplaces.flatMap(marketplace => marketplace.plugins || []);
      return { installed: plugins.filter(plugin => plugin.installed), available: plugins.filter(plugin => !plugin.installed),
        marketplaces: response.marketplaces.map(({ name, path }) => ({ name, path })), errors: response.errors,
        environment: value.remote ? `SSH: ${value.session.title || value.session.id}` : value.linux ? `WSL: ${value.session.wslDistro}` : "Windows" };
    }
    const [plugins, sources] = await Promise.all([
      json(value, ["plugin", "list", "--available"]), json(value, ["plugin", "marketplace", "list"])
    ]);
    const marketplaces = sources.marketplaces || [];
    const known = new Set(marketplaces.map(item => item.name));
    return { installed: plugins.installed || [],
      available: (plugins.available || []).filter(item => known.has(item.marketplaceName)), marketplaces,
      environment: value.remote ? `SSH: ${value.session.title || value.session.id}` : value.linux ? `WSL: ${value.session.wslDistro}` : "Windows" };
  }
  async function install(id, plugin, marketplace) {
    const value = target(id);
    if (typeof graphicalService.installPlugin === "function") {
      const catalog = await list(id);
      const selected = catalog.available.find(item => item.name === plugin && item.marketplaceName === marketplace);
      if (!selected) throw new Error("插件不在当前账号的可安装目录中，请刷新列表。");
      const installed = await graphicalService.installPlugin(id, selected);
      return { ...await list(id), setupRequired: installed?.setupRequired || [] };
    }
    await json(value, ["plugin", "add", `${requiredName(plugin, "插件名")}@${requiredName(marketplace, "来源名")}`]);
    return list(id);
  }
  async function uninstall(id, plugin, marketplace) {
    const value = target(id);
    if (typeof graphicalService.uninstallPlugin === "function") {
      const catalog = await list(id);
      const selected = catalog.installed.find(item => item.name === plugin && item.marketplaceName === marketplace);
      if (!selected?.id) throw new Error("插件不在当前账号的已安装目录中，请刷新列表。");
      await graphicalService.uninstallPlugin(id, selected.id);
      return list(id);
    }
    await json(value, ["plugin", "remove", `${requiredName(plugin, "插件名")}@${requiredName(marketplace, "来源名")}`]);
    return list(id);
  }
  async function addMarketplace(id, source) {
    const value = target(id);
    if (typeof graphicalService.addPluginMarketplace === "function") {
      await graphicalService.addPluginMarketplace(id, requiredSource(source));
      return list(id);
    }
    await json(value, ["plugin", "marketplace", "add", requiredSource(source)]);
    return list(id);
  }
  async function refreshMarketplace(id, name) {
    const value = target(id);
    if (typeof graphicalService.refreshPluginMarketplace === "function") {
      await graphicalService.refreshPluginMarketplace(id, requiredName(name, "来源名"));
      return list(id);
    }
    await json(value, ["plugin", "marketplace", "upgrade", requiredName(name, "来源名")]);
    return list(id);
  }
  async function removeMarketplace(id, name) {
    const value = target(id);
    if (typeof graphicalService.removePluginMarketplace === "function") {
      await graphicalService.removePluginMarketplace(id, requiredName(name, "来源名"));
      return list(id);
    }
    await json(value, ["plugin", "marketplace", "remove", requiredName(name, "来源名")]);
    return list(id);
  }
  async function config(id, scope, input = null) {
    const value = target(id);
    if (scope !== "project" && scope !== "user") throw new Error("插件配置范围无效。");
    const file = scope === "project" ? `${value.cwd.replace(/[\\/]$/, "")}/.codex/config.toml` : null;
    const location = value.linux ? (file || '${CODEX_HOME:-$HOME/.codex}/config.toml') : file;
    const readScript = value.linux
      ? `target=${file ? bashQuote(location) : '"${CODEX_HOME:-$HOME/.codex}/config.toml"'}; if [ -f "$target" ]; then base64 < "$target" | tr -d '\\n'; fi`
      : `$target = ${file ? psQuote(location) : "if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'config.toml' } else { Join-Path $env:USERPROFILE '.codex/config.toml' }"}; if (Test-Path -LiteralPath $target) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) }`;
    const environment = environmentService.resolve(value.session);
    const exports = Object.entries(environment).map(([key, val]) => {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)) throw new Error("环境变量名无效。");
      return `export ${key}=${bashQuote(val)}`;
    });
    const before = String(value.session.initialCommand || "").trim();
    const linuxCommand = script => [...exports, `cd ${bashQuote(value.cwd)}`, ...(before ? [`{ ${before}; } 1>&2`] : []), script].join(" && ");
    const shell = async (script, input = null) => value.remote
      ? sshAgentTransport.exec(value.session.id, `bash -lic ${bashQuote(linuxCommand(script))}`, { actionName: "Codex plugin configuration", timeoutMs: TIMEOUT_MS, ...(input === null ? {} : { stdin: input }) })
      : value.linux
        ? runProcess("wsl.exe", ["-d", value.session.wslDistro, "--", "bash", "-lic", linuxCommand(script)], { env: process.env }, spawnProcess, input)
        : runWindows(value, script, environment, input);
    const encoded = (await shell(readScript)).trim();
    const original = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
    let document;
    try { document = original.trim() ? parseToml(original) : {}; } catch (error) { throw new Error(`Codex 配置无法解析：${error.message}`); }
    const settings = document.plugins || {};
    if (!input) return { overrides: publicOverrides(settings) };
    const key = `${requiredName(input.plugin, "插件名")}@${requiredName(input.marketplace, "来源名")}`;
    if (typeof input.enabled !== "boolean") throw new Error("插件启停状态无效。");
    document.plugins = { ...settings, [key]: { ...(settings[key] || {}), enabled: input.enabled } };
    const next = stringifyToml(document);
    const nextEncoded = Buffer.from(next, "utf8").toString("base64");
    const expected = Buffer.from(original, "utf8").toString("base64");
    const writeScript = value.linux
      ? `IFS= read -r expected && IFS= read -r next || exit 1; target=${file ? bashQuote(location) : '"${CODEX_HOME:-$HOME/.codex}/config.toml"'}; current=$(if [ -f "$target" ]; then base64 < "$target" | tr -d '\\n'; fi); [ "$current" = "$expected" ] || { echo 'Codex 配置已变化，请刷新后重试。' >&2; exit 3; }; mkdir -p "$(dirname "$target")" && tmp="${'${target}'}.pannel-handle.tmp" && printf %s "$next" | base64 -d > "$tmp" && mv "$tmp" "$target"`
      : `$expected = [Console]::In.ReadLine(); $next = [Console]::In.ReadLine(); $target = ${file ? psQuote(location) : "if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'config.toml' } else { Join-Path $env:USERPROFILE '.codex/config.toml' }"}; $current = if (Test-Path -LiteralPath $target) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) } else { '' }; if ($current -ne $expected) { throw 'Codex 配置已变化，请刷新后重试。' }; [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null; $tmp = "${'${target}'}.pannel-handle.tmp"; [IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String($next)); Move-Item -LiteralPath $tmp -Destination $target -Force`;
    await shell(writeScript, `${expected}\n${nextEncoded}\n`);
    return { overrides: publicOverrides(document.plugins) };
  }
  return { list, install, uninstall, addMarketplace, refreshMarketplace, removeMarketplace, readConfig: (id, scope) => config(id, scope), setEnabled: (id, scope, input) => config(id, scope, input) };
}

module.exports = { createCodexPluginService };
