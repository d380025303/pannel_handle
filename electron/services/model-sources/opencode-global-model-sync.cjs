const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { parse, modify, applyEdits } = require("jsonc-parser");

const SOURCES = {
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  nararouter: { name: "NaraRouter", baseUrl: "https://router.bynara.id/v1", apiKeyEnv: "NARAROUTER_API_KEY" },
  minimax: { name: "MiniMax", baseUrl: "https://api.minimaxi.com/v1", apiKeyEnv: "MINIMAX_API_KEY" }
};

function readDocument(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return "{}\n"; throw error; }
}

function jsonObject(text, file) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`OpenCode 配置格式无效：${file}`);
  return value;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.pannel-handle-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

function editJsonc(text, changes) {
  let output = text;
  for (const [keys, value] of changes) {
    const edits = modify(output, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
    output = applyEdits(output, edits);
  }
  return output;
}

function pathsForHome(home, xdgConfigHome, xdgDataHome) {
  const configDirectory = path.join(xdgConfigHome || path.join(home, ".config"), "opencode");
  return {
    config: path.join(configDirectory, fs.existsSync(path.join(configDirectory, "opencode.jsonc")) ? "opencode.jsonc" : "opencode.json"),
    auth: path.join(xdgDataHome || path.join(home, ".local", "share"), "opencode", "auth.json")
  };
}

function createOpenCodeGlobalModelSync({ userDataDir, stores, home = os.homedir(), xdgConfigHome = process.env.XDG_CONFIG_HOME,
  xdgDataHome = process.env.XDG_DATA_HOME, wslCommand = execFile }) {
  const manifestFile = path.join(userDataDir, "opencode-managed-models.json");
  const localPaths = pathsForHome(home, xdgConfigHome, xdgDataHome);

  function desired() {
    return Object.fromEntries(Object.entries(stores).map(([id, store]) => {
      const verified = store.getAgentModelVerifications?.("opencode") || {};
      const models = store.getCachedModels().filter(model => verified[model.id]?.status === "passed");
      return [id, { models, key: models.length ? store.getApiKey() : "" }];
    }));
  }

  function syncAt(target, scope) {
    const manifest = jsonObject(readDocument(manifestFile), manifestFile);
    const previous = manifest[scope] || {};
    const sourceModels = desired();
    const originalConfig = readDocument(target.config);
    const originalAuth = readDocument(target.auth);
    let configText = originalConfig;
    let authText = originalAuth;
    const config = jsonObject(configText, target.config);
    const auth = jsonObject(authText, target.auth);
    const next = {};
    const configChanges = [];
    const authChanges = [];
    for (const [id, source] of Object.entries(sourceModels)) {
      const oldEntry = previous[id] || {};
      const oldIds = Array.isArray(oldEntry) ? oldEntry : Array.isArray(oldEntry.models) ? oldEntry.models : [];
      // Older manifests tracked custom provider ownership only through their model IDs.
      const providerOwned = oldEntry.providerOwned === true || (oldEntry.providerOwned === undefined && id !== "openrouter" && oldIds.length > 0);
      const authOwned = oldEntry.authOwned === true;
      const wanted = source.key ? source.models : [];
      const wantedIds = wanted.map(model => model.id);
      const provider = config.providers?.[id];
      if (wanted.length && provider && !providerOwned && id !== "openrouter")
        throw new Error(`OpenCode 已有 ${id} 用户配置，无法自动覆盖。`);
      for (const oldId of oldIds) if (!wantedIds.includes(oldId)) configChanges.push([["providers", id, "models", oldId], undefined]);
      if (wanted.length) {
        if (id !== "openrouter") {
          configChanges.push([["providers", id, "name"], SOURCES[id].name]);
          configChanges.push([["providers", id, "env"], [SOURCES[id].apiKeyEnv]]);
          configChanges.push([["providers", id, "package"], "@opencode/ai/providers/openai-compatible"]);
          configChanges.push([["providers", id, "settings", "baseURL"], SOURCES[id].baseUrl]);
        }
        for (const model of wanted) {
          if (provider?.models?.[model.id] && !oldIds.includes(model.id))
            throw new Error(`OpenCode 已有用户模型 ${id}/${model.id}，无法自动覆盖。`);
          configChanges.push([["providers", id, "models", model.id, "name"], model.name || model.id]);
          if (Number.isFinite(model.contextLength) && model.contextLength >= 1) {
            configChanges.push([["providers", id, "models", model.id, "limit", "context"], Math.trunc(model.contextLength)]);
          }
        }
      }
      if (authOwned && auth[id]?.type === "api" && auth[id].key === source.key) authChanges.push([[id], undefined]);
      next[id] = { models: wantedIds, providerOwned: providerOwned || (!provider && wanted.length > 0), authOwned: false };
    }
    configText = editJsonc(configText, configChanges);
    authText = editJsonc(authText, authChanges);
    if (readDocument(target.config) !== originalConfig || readDocument(target.auth) !== originalAuth)
      throw new Error("OpenCode 配置在同步时被其他程序修改，请重试。");
    if (authText !== originalAuth) atomicWrite(target.auth, authText);
    if (configText !== originalConfig) atomicWrite(target.config, configText);
    manifest[scope] = next;
    atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    return next;
  }

  function syncWindows() { return syncAt(localPaths, "windows"); }

  async function syncWsl(distro) {
    if (!/^[\w .-]+$/.test(String(distro || ""))) throw new Error("无效的 WSL 发行版名称。");
    const stdout = await new Promise((resolve, reject) => {
      wslCommand("wsl.exe", ["-d", distro, "--", "sh", "-lc", "printf '%s\\n%s' \"${XDG_CONFIG_HOME:-$HOME/.config}\" \"${XDG_DATA_HOME:-$HOME/.local/share}\""],
        { encoding: "utf8", windowsHide: true, timeout: 10000 }, (error, output) => {
          if (error) reject(new Error(`无法读取 WSL ${distro} 的 OpenCode 配置目录。`));
          else resolve(output);
        });
    });
    const [configBase, dataBase] = String(stdout || "").split(/\r?\n/).map(value => value.trim());
    if (!configBase?.startsWith("/") || !dataBase?.startsWith("/")) throw new Error(`WSL ${distro} 的 OpenCode 配置目录无效。`);
    const unc = linuxPath => `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;
    const configDirectory = unc(`${configBase}/opencode`);
    return syncAt({ config: path.join(configDirectory, fs.existsSync(path.join(configDirectory, "opencode.jsonc")) ? "opencode.jsonc" : "opencode.json"),
      auth: unc(`${dataBase}/opencode/auth.json`) }, `wsl:${distro}`);
  }

  return { syncWindows, syncWsl };
}

module.exports = { createOpenCodeGlobalModelSync, pathsForHome };
