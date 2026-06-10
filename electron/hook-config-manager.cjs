const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = ["claude", "codex"];
const PROVIDER_CONFIG = {
  claude: {
    configPath: [".claude", "settings.local.json"],
    windowsScriptPath: [".claude", "pannel-handle-hook.ps1"],
    wslScriptPath: [".claude", "pannel-handle-hook.sh"],
    windowsAsset: "pannel-handle-hook.ps1",
    wslAsset: "pannel-handle-hook.sh",
    windowsCommand: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/pannel-handle-hook.ps1",
    wslCommand: "bash .claude/pannel-handle-hook.sh",
    events: [
      ["UserPromptSubmit", ""],
      ["PreToolUse", ""],
      ["PostToolUse", ""],
      ["Notification", "permission_prompt"],
      ["Notification", "idle_prompt"],
      ["PermissionRequest", ""],
      ["Stop", ""],
      ["StopFailure", ""],
      ["SessionEnd", ""]
    ]
  },
  codex: {
    configPath: [".codex", "hooks.json"],
    windowsScriptPath: [".codex", "pannel-handle-hook.ps1"],
    wslScriptPath: [".codex", "pannel-handle-hook.sh"],
    windowsAsset: "pannel-handle-codex-hook.ps1",
    wslAsset: "pannel-handle-codex-hook.sh",
    windowsCommand: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .codex/pannel-handle-hook.ps1",
    wslCommand: "bash .codex/pannel-handle-hook.sh",
    events: [
      ["SessionStart", "*"],
      ["UserPromptSubmit", "*"],
      ["PreToolUse", "*"],
      ["PermissionRequest", "*"],
      ["PostToolUse", "*"],
      ["Stop", "*"]
    ]
  }
};

function isManagedCommand(command) {
  return typeof command === "string" && /pannel-handle-(?:codex-)?hook\.(?:ps1|sh)/i.test(command);
}

function normalizeProviders(providers) {
  const selected = Array.isArray(providers) ? providers.filter(provider => PROVIDERS.includes(provider)) : PROVIDERS;
  return [...new Set(selected)];
}

function getProjectPath(target) {
  if (!target || !["windows", "wsl"].includes(target.type)) {
    throw new Error("Hook target type must be windows or wsl.");
  }
  if (typeof target.path !== "string" || !target.path.trim()) {
    throw new Error("Project path is required.");
  }
  if (target.type === "windows") {
    return path.resolve(target.path.trim());
  }
  if (typeof target.wslDistro !== "string" || !/^[\w.-]+$/.test(target.wslDistro)) {
    throw new Error("A valid WSL distro is required.");
  }
  const linuxPath = target.path.trim();
  if (!linuxPath.startsWith("/") || linuxPath.includes("\0")) {
    throw new Error("WSL project path must be an absolute Linux path.");
  }
  return path.win32.join(`\\\\wsl.localhost\\${target.wslDistro}`, ...linuxPath.split("/").filter(Boolean));
}

function removeManagedHooks(config) {
  const hooks = config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? config.hooks : {};
  const cleaned = {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      cleaned[eventName] = groups;
      continue;
    }
    cleaned[eventName] = groups
      .map(group => {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return group;
        return { ...group, hooks: group.hooks.filter(hook => !isManagedCommand(hook?.command)) };
      })
      .filter(group => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
  }
  return { ...config, hooks: cleaned };
}

function buildConfig(config, provider, platform) {
  const definition = PROVIDER_CONFIG[provider];
  const command = platform === "wsl" ? definition.wslCommand : definition.windowsCommand;
  const next = removeManagedHooks(config);
  for (const [eventName, matcher] of definition.events) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    groups.push({
      matcher,
      hooks: [{ type: "command", command }]
    });
    next.hooks[eventName] = groups;
  }
  return next;
}

function readJsonFile(fsApi, filePath) {
  try {
    const value = fsApi.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Root value must be an object.");
    }
    return { exists: true, raw: value, value: parsed };
  } catch (err) {
    if (err.code === "ENOENT") return { exists: false, raw: undefined, value: {} };
    if (err instanceof SyntaxError || err.message === "Root value must be an object.") {
      throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

function countManagedCommands(config) {
  let count = 0;
  for (const groups of Object.values(config.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      count += group.hooks.filter(hook => isManagedCommand(hook?.command)).length;
    }
  }
  return count;
}

function atomicWrite(fsApi, filePath, content) {
  fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fsApi.existsSync(filePath)) {
    fsApi.copyFileSync(filePath, `${filePath}.pannel-handle.bak`);
  }
  const tempPath = `${filePath}.pannel-handle.tmp`;
  fsApi.writeFileSync(tempPath, content, "utf-8");
  fsApi.renameSync(tempPath, filePath);
}

function createHookConfigManager({ assetsDir = path.join(__dirname, "hook-assets"), fsApi = fs } = {}) {
  function getProviderPaths(projectPath, target, provider) {
    const definition = PROVIDER_CONFIG[provider];
    const isWsl = target.type === "wsl";
    return {
      configPath: path.join(projectPath, ...definition.configPath),
      scriptPath: path.join(projectPath, ...(isWsl ? definition.wslScriptPath : definition.windowsScriptPath)),
      assetPath: path.join(assetsDir, isWsl ? definition.wslAsset : definition.windowsAsset)
    };
  }

  function inspect(target, providers = PROVIDERS) {
    const selected = normalizeProviders(providers);
    try {
      const projectPath = getProjectPath(target);
      if (!fsApi.statSync(projectPath).isDirectory()) {
        throw new Error("Project path is not a directory.");
      }
      const result = {};
      for (const provider of selected) {
        const paths = getProviderPaths(projectPath, target, provider);
        const config = readJsonFile(fsApi, paths.configPath);
        const expectedConfig = buildConfig(config.value, provider, target.type);
        const expectedScript = fsApi.readFileSync(paths.assetPath, "utf-8");
        const scriptMatches = fsApi.existsSync(paths.scriptPath) && fsApi.readFileSync(paths.scriptPath, "utf-8") === expectedScript;
        const managedCount = countManagedCommands(config.value);
        const expectedCount = PROVIDER_CONFIG[provider].events.length;
        const configMatches = JSON.stringify(config.value) === JSON.stringify(expectedConfig);
        result[provider] = {
          status: configMatches && scriptMatches ? "installed" : managedCount > 0 || fsApi.existsSync(paths.scriptPath) ? "needs_repair" : "not_installed",
          configPath: paths.configPath,
          scriptPath: paths.scriptPath,
          managedHookCount: managedCount,
          expectedHookCount: expectedCount
        };
      }
      return { ok: true, projectPath, providers: result };
    } catch (err) {
      return { ok: false, error: err.message, providers: {} };
    }
  }

  function install(target, providers = PROVIDERS) {
    const selected = normalizeProviders(providers);
    if (selected.length === 0) {
      return { ok: false, error: "Select at least one Hook provider.", providers: {} };
    }
    const snapshots = [];
    try {
      const projectPath = getProjectPath(target);
      if (!fsApi.statSync(projectPath).isDirectory()) {
        throw new Error("Project path is not a directory.");
      }
      const writes = [];
      for (const provider of selected) {
        const paths = getProviderPaths(projectPath, target, provider);
        const config = readJsonFile(fsApi, paths.configPath);
        const script = fsApi.readFileSync(paths.assetPath, "utf-8");
        writes.push([paths.configPath, `${JSON.stringify(buildConfig(config.value, provider, target.type), null, 2)}\n`]);
        writes.push([paths.scriptPath, script]);
      }
      for (const [filePath, content] of writes) {
        snapshots.push({
          filePath,
          exists: fsApi.existsSync(filePath),
          content: fsApi.existsSync(filePath) ? fsApi.readFileSync(filePath, "utf-8") : undefined
        });
        atomicWrite(fsApi, filePath, content);
      }
      return inspect(target, selected);
    } catch (err) {
      for (const snapshot of snapshots.reverse()) {
        try {
          if (snapshot.exists) {
            atomicWrite(fsApi, snapshot.filePath, snapshot.content);
          } else if (fsApi.existsSync(snapshot.filePath)) {
            fsApi.unlinkSync(snapshot.filePath);
          }
        } catch (rollbackError) {
          console.error("Failed to roll back Hook installation:", rollbackError);
        }
      }
      return { ok: false, error: err.message, providers: {} };
    }
  }

  return { inspect, install };
}

module.exports = {
  PROVIDER_CONFIG,
  buildConfig,
  createHookConfigManager,
  getProjectPath,
  isManagedCommand
};
