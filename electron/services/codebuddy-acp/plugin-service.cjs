const { spawn } = require("node:child_process");
const { sanitizeDiagnostic } = require("./http-transport.cjs");

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SCOPES = new Set(["user", "project", "local"]);
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const TIMEOUT_MS = 120000;
const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;

function requiredName(value, label) {
  if (typeof value !== "string" || !NAME.test(value)) throw new Error(`${label}无效。`);
  return value;
}
function requiredScope(value) {
  if (!SCOPES.has(value)) throw new Error("插件安装范围无效。");
  return value;
}
function requiredSource(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value))
    throw new Error("插件市场来源无效。");
  return value.trim();
}
function dataOf(value) { return value?.data ?? value; }
function arrayOf(value, key) {
  const data = dataOf(value);
  return Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : [];
}
function identity(name, marketplace) {
  return `${requiredName(name, "插件名")}@${requiredName(marketplace, "市场名")}`;
}

function runCli(runtime, args, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const powershell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(String(runtime.shell || "powershell.exe"));
    const command = `Set-Location -LiteralPath ${psQuote(runtime.cwd)}; ${runtime.before && powershell
      ? `& { ${runtime.before} } 1>&2; if (-not $?) { exit 1 }; ` : ""}& codebuddy ${args.map(psQuote).join(" ")}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const executable = runtime.before && !powershell ? "cmd.exe" : powershell ? runtime.shell || "powershell.exe" : "powershell.exe";
    const parameters = executable === "cmd.exe"
      ? ["/d", "/s", "/c", `(${runtime.before}) 1>&2 && powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`]
      : ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    const child = spawnProcess(executable, parameters, { cwd: runtime.cwd, env: { ...process.env, ...runtime.environment }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errorOutput = ""; let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error("CodeBuddy 插件命令超时。")); }, TIMEOUT_MS);
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(output.trim());
    }
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.length > OUTPUT_LIMIT) { child.kill(); finish(new Error("CodeBuddy 插件输出过大。")); }
    });
    child.stderr.on("data", chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4096); });
    child.on("error", finish);
    child.on("close", code => {
      const secrets = Object.entries(runtime.environment).filter(([name]) => /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name)).map(([, value]) => value);
      finish(code === 0 ? null : new Error(sanitizeDiagnostic(errorOutput.trim(), secrets) || `CodeBuddy 插件命令退出：${code}`));
    });
  });
}

function createCodeBuddyPluginService({ terminalManager, graphicalService, spawnProcess = spawn }) {
  const mutations = new Set();
  function target(id) {
    const session = terminalManager.getSession(String(id || ""));
    if (!session || session.runtimeMode !== "app-server" || session.agentProvider !== "codebuddy"
      || session.type !== "windows") throw new Error("仅 Windows CodeBuddy 图形会话支持插件管理。");
    return graphicalService.pluginRuntime(session.id);
  }
  function api(id, method, route, body) {
    target(id);
    return graphicalService.pluginRequest(id, method, route, body);
  }
  async function installed(id) {
    const output = await runCli(target(id), ["plugin", "list", "--json"], spawnProcess);
    try {
      const items = JSON.parse(output);
      if (!Array.isArray(items)) throw new Error();
      return items.filter(item => typeof item?.id === "string" && (SCOPES.has(item.scope) || item.scope === "managed"))
        .map(item => ({ id: item.id, name: item.id.split("@")[0], marketplaceName: item.id.split("@").slice(1).join("@"),
          scope: item.scope, enabled: item.enabled === true, version: item.version || "",
          dependencyErrors: Array.isArray(item.dependencyErrors) ? item.dependencyErrors.map(String) : [] }));
    } catch { throw new Error("CodeBuddy 插件列表格式无效。"); }
  }
  async function list(id) {
    target(id);
    const [plugins, marketplacesResult] = await Promise.all([installed(id), api(id, "GET", "/api/v1/plugins/marketplaces")]);
    const marketplaces = arrayOf(marketplacesResult, "marketplaces");
    const errors = [];
    const browsed = await Promise.all(marketplaces.map(async marketplace => {
      const name = marketplace?.name;
      if (typeof name !== "string" || !NAME.test(name)) return [];
      try {
        return arrayOf(await api(id, "POST", "/api/v1/plugins/marketplaces/browse", { marketplace: name }), "plugins")
          .filter(item => item && typeof item.name === "string")
          .map(item => ({ ...item, marketplaceName: name }));
      } catch (error) { errors.push(`${name}：${error.message}`); return []; }
    }));
    return { installed: plugins, available: browsed.flat(),
      marketplaces, errors, environment: "Windows" };
  }
  async function reload(id) {
    await api(id, "POST", "/api/v1/plugins/reload", {});
    return list(id);
  }
  async function mutation(id, action, { reloadAfter = true } = {}) {
    target(id);
    if (mutations.has(id)) throw new Error("插件操作正在进行，请稍后重试。");
    mutations.add(id);
    try {
      await action();
      let reloadError;
      if (reloadAfter) {
        try { await api(id, "POST", "/api/v1/plugins/reload", {}); }
        catch (error) { reloadError = error.message; }
      }
      try { return { ...await list(id), ...(reloadError ? { reloadError } : {}) }; }
      catch (error) { throw new Error(`插件变更已保存，但刷新列表失败：${error.message}${reloadError ? `；重载失败：${reloadError}` : ""}`); }
    } finally { mutations.delete(id); }
  }
  const cliAction = (id, verb, name, marketplace, scope) => mutation(id, () =>
    runCli(target(id), ["plugin", verb, identity(name, marketplace), "--scope", requiredScope(scope)], spawnProcess));
  async function market(id, name, removable = false) {
    const found = arrayOf(await api(id, "GET", "/api/v1/plugins/marketplaces"), "marketplaces")
      .find(item => item?.name === requiredName(name, "市场名"));
    if (!found) throw new Error("插件市场已不存在，请刷新列表。");
    if (removable && found.isBuiltIn === true) throw new Error("内置插件市场不可删除。");
    return found;
  }
  return {
    list, reload,
    install: (id, name, marketplace, scope) => cliAction(id, "install", name, marketplace, scope),
    uninstall: (id, name, marketplace, scope) => cliAction(id, "uninstall", name, marketplace, scope),
    enable: (id, name, marketplace, scope) => cliAction(id, "enable", name, marketplace, scope),
    disable: (id, name, marketplace, scope) => cliAction(id, "disable", name, marketplace, scope),
    update: (id, name, marketplace, scope) => cliAction(id, "update", name, marketplace, scope),
    addMarketplace: (id, source, name, autoUpdate) => mutation(id, () => api(id, "POST", "/api/v1/plugins/marketplaces",
      { source: requiredSource(source), name: requiredName(name, "市场名"), autoUpdate: autoUpdate === true }), { reloadAfter: false }),
    refreshMarketplace: (id, name) => mutation(id, async () => {
      await market(id, name);
      await api(id, "POST", "/api/v1/plugins/marketplaces/update", { marketplace: name });
    }),
    removeMarketplace: (id, name) => mutation(id, async () => {
      await market(id, name, true);
      await api(id, "DELETE", `/api/v1/plugins/marketplaces/${encodeURIComponent(name)}`);
    }),
    setAutoUpdate: (id, name, enabled) => mutation(id, async () => {
      await market(id, name);
      if (typeof enabled !== "boolean") throw new Error("自动更新状态无效。");
      await api(id, "POST", "/api/v1/plugins/marketplaces/auto-update", { marketplace: name, autoUpdate: enabled });
    }, { reloadAfter: false })
  };
}

module.exports = { createCodeBuddyPluginService, runCli };
