const fs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const PROVIDERS = ["claude", "codex", "opencode", "qoder"];
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
  },
  qoder: {
    configPath: [".qoder", "settings.json"],
    windowsScriptPath: [".qoder", "pannel-handle-hook.ps1"],
    wslScriptPath: [".qoder", "pannel-handle-hook.sh"],
    windowsAsset: "pannel-handle-qoder-hook.ps1",
    wslAsset: "pannel-handle-qoder-hook.sh",
    windowsCommand: "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .qoder/pannel-handle-hook.ps1",
    wslCommand: "bash .qoder/pannel-handle-hook.sh",
    events: [
      ["SessionStart", "*"],
      ["UserPromptSubmit", "*"],
      ["PreToolUse", "*"],
      ["PermissionRequest", "*"],
      ["PostToolUse", "*"],
      ["PostToolUseFailure", "*"],
      ["Notification", "permission_prompt"],
      ["Notification", "idle_prompt"],
      ["Stop", "*"],
      ["SessionEnd", "*"]
    ]
  },
  opencode: {
    scriptPath: [".opencode", "plugins", "pannel-handle-notification.js"],
    asset: "pannel-handle-opencode-plugin.js"
  }
};

function isManagedCommand(command) {
  return typeof command === "string" && /pannel-handle-(?:codex-|qoder-)?hook\.(?:ps1|sh)/i.test(command);
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

function getWslProjectPath(target) {
  if (typeof target.wslDistro !== "string" || !/^[\w.-]+$/.test(target.wslDistro)) {
    throw new Error("A valid WSL distro is required.");
  }
  const linuxPath = target.path.trim();
  if (!linuxPath.startsWith("/") || linuxPath.includes("\0")) {
    throw new Error("WSL project path must be an absolute Linux path.");
  }
  return linuxPath.replace(/\/+$/, "") || "/";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function createWslFsApi(distro, spawnSync = defaultSpawnSync) {
  function runBash(script, options = {}) {
    const result = spawnSync("wsl.exe", ["-d", distro, "--", "bash", "-lc", script], {
      input: options.input,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const message = String(result.stderr || result.stdout || `WSL command failed with exit code ${result.status}.`).trim();
      const error = new Error(message);
      if (/no such file|cannot access/i.test(message)) {
        error.code = "ENOENT";
      } else if (/not a directory/i.test(message)) {
        error.code = "ENOTDIR";
      }
      throw error;
    }
    return result.stdout || "";
  }

  function isWslPath(filePath) {
    return typeof filePath === "string" && filePath.startsWith("/");
  }

  return {
    existsSync(filePath) {
      if (!isWslPath(filePath)) return fs.existsSync(filePath);
      const result = spawnSync("wsl.exe", ["-d", distro, "--", "test", "-e", filePath], {
        encoding: "utf-8",
        windowsHide: true
      });
      return result.status === 0;
    },
    statSync(filePath) {
      if (!isWslPath(filePath)) return fs.statSync(filePath);
      const result = spawnSync("wsl.exe", ["-d", distro, "--", "test", "-d", filePath], {
        encoding: "utf-8",
        windowsHide: true
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return { isDirectory: () => true };
    },
    mkdirSync(dirPath, options) {
      if (!isWslPath(dirPath)) return fs.mkdirSync(dirPath, options);
      runBash(`${options?.recursive ? "mkdir -p" : "mkdir"} ${shellQuote(dirPath)}`);
      return undefined;
    },
    readFileSync(filePath, encoding) {
      if (!isWslPath(filePath)) return fs.readFileSync(filePath, encoding);
      return runBash(`cat ${shellQuote(filePath)}`);
    },
    writeFileSync(filePath, content) {
      if (!isWslPath(filePath)) return fs.writeFileSync(filePath, content, "utf-8");
      runBash(`cat > ${shellQuote(filePath)}`, { input: content });
      return undefined;
    },
    copyFileSync(sourcePath, destinationPath) {
      if (!isWslPath(sourcePath) || !isWslPath(destinationPath)) return fs.copyFileSync(sourcePath, destinationPath);
      runBash(`cp -f ${shellQuote(sourcePath)} ${shellQuote(destinationPath)}`);
      return undefined;
    },
    renameSync(sourcePath, destinationPath) {
      if (!isWslPath(sourcePath) || !isWslPath(destinationPath)) return fs.renameSync(sourcePath, destinationPath);
      runBash(`mv -f ${shellQuote(sourcePath)} ${shellQuote(destinationPath)}`);
      return undefined;
    },
    unlinkSync(filePath) {
      if (!isWslPath(filePath)) return fs.unlinkSync(filePath);
      runBash(`rm -f ${shellQuote(filePath)}`);
      return undefined;
    }
  };
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

function buildConfig(config, provider, platform, commandOverride) {
  const definition = PROVIDER_CONFIG[provider];
  if (!definition.configPath) {
    return config;
  }
  const command = commandOverride || (platform === "wsl" || platform === "ssh" ? definition.wslCommand : definition.windowsCommand);
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
    assertDirectory(fsApi, path.dirname(filePath));
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

function assertDirectory(fsApi, dirPath) {
  if (!fsApi.existsSync(dirPath)) {
    return;
  }
  try {
    if (fsApi.statSync(dirPath).isDirectory()) {
      return;
    }
  } catch {
    // Fall through to a clearer hook installer error below.
  }
  throw new Error(`Hook path exists but is not a directory: ${dirPath}`);
}

function ensureDir(fsApi, dirPath) {
  assertDirectory(fsApi, dirPath);
  try {
    fsApi.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  if (fsApi.existsSync(dirPath)) {
    return;
  }

  const pathApi = dirPath.includes("\\") || /^[A-Za-z]:/.test(dirPath) ? path.win32 : path.posix;
  const parsed = pathApi.parse(dirPath);
  const parts = dirPath.slice(parsed.root.length).split(pathApi.sep).filter(Boolean);
  let current = parsed.root || (pathApi === path.win32 ? "" : pathApi.sep);
  for (const part of parts) {
    current = current ? pathApi.join(current, part) : part;
    if (fsApi.existsSync(current)) continue;
    try {
      fsApi.mkdirSync(current);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

function atomicWrite(fsApi, filePath, content) {
  ensureDir(fsApi, path.dirname(filePath));
  if (fsApi.existsSync(filePath)) {
    fsApi.copyFileSync(filePath, `${filePath}.pannel-handle.bak`);
  }
  const tempPath = `${filePath}.pannel-handle.tmp`;
  try {
    fsApi.writeFileSync(tempPath, content, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    ensureDir(fsApi, path.dirname(filePath));
    fsApi.writeFileSync(tempPath, content, "utf-8");
  }
  fsApi.renameSync(tempPath, filePath);
}

function createHookConfigManager({ assetsDir = path.join(__dirname, "hook-assets"), fsApi = fs, spawnSync = defaultSpawnSync } = {}) {
  function getProviderPaths(projectPath, target, provider) {
    const definition = PROVIDER_CONFIG[provider];
    const isWsl = target.type === "wsl";
    const projectPathApi = isWsl ? path.posix : path;
    return {
      configPath: definition.configPath ? projectPathApi.join(projectPath, ...definition.configPath) : undefined,
      scriptPath: projectPathApi.join(projectPath, ...(definition.scriptPath || (isWsl ? definition.wslScriptPath : definition.windowsScriptPath))),
      assetPath: path.join(assetsDir, definition.asset || (isWsl ? definition.wslAsset : definition.windowsAsset))
    };
  }

  function inspect(target, providers = PROVIDERS) {
    const selected = normalizeProviders(providers);
    try {
      const projectPath = target?.type === "wsl" ? getWslProjectPath(target) : getProjectPath(target);
      const targetFsApi = target?.type === "wsl" ? createWslFsApi(target.wslDistro, spawnSync) : fsApi;
      if (!targetFsApi.statSync(projectPath).isDirectory()) {
        throw new Error("Project path is not a directory.");
      }
      const result = {};
      for (const provider of selected) {
        const paths = getProviderPaths(projectPath, target, provider);
        const expectedScript = targetFsApi.readFileSync(paths.assetPath, "utf-8");
        const scriptMatches = targetFsApi.existsSync(paths.scriptPath) && targetFsApi.readFileSync(paths.scriptPath, "utf-8") === expectedScript;
        const config = paths.configPath ? readJsonFile(targetFsApi, paths.configPath) : undefined;
        const expectedConfig = config ? buildConfig(config.value, provider, target.type) : undefined;
        const managedCount = config ? countManagedCommands(config.value) : (targetFsApi.existsSync(paths.scriptPath) ? 1 : 0);
        const expectedCount = PROVIDER_CONFIG[provider].events?.length || 1;
        const configMatches = config ? JSON.stringify(config.value) === JSON.stringify(expectedConfig) : true;
        result[provider] = {
          status: configMatches && scriptMatches ? "installed" : managedCount > 0 || targetFsApi.existsSync(paths.scriptPath) ? "needs_repair" : "not_installed",
          ...(paths.configPath ? { configPath: paths.configPath } : {}),
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
      const projectPath = target?.type === "wsl" ? getWslProjectPath(target) : getProjectPath(target);
      const targetFsApi = target?.type === "wsl" ? createWslFsApi(target.wslDistro, spawnSync) : fsApi;
      if (!targetFsApi.statSync(projectPath).isDirectory()) {
        throw new Error("Project path is not a directory.");
      }
      const writes = [];
      for (const provider of selected) {
        const paths = getProviderPaths(projectPath, target, provider);
        const script = targetFsApi.readFileSync(paths.assetPath, "utf-8");
        if (paths.configPath) {
          const config = readJsonFile(targetFsApi, paths.configPath);
          writes.push([paths.configPath, `${JSON.stringify(buildConfig(config.value, provider, target.type), null, 2)}\n`]);
        }
        writes.push([paths.scriptPath, script]);
      }
      for (const [filePath, content] of writes) {
        snapshots.push({
          filePath,
          exists: targetFsApi.existsSync(filePath),
          content: targetFsApi.existsSync(filePath) ? targetFsApi.readFileSync(filePath, "utf-8") : undefined
        });
        atomicWrite(targetFsApi, filePath, content);
      }
      return inspect(target, selected);
    } catch (err) {
      for (const snapshot of snapshots.reverse()) {
        try {
          if (snapshot.exists) {
            const targetFsApi = target?.type === "wsl" ? createWslFsApi(target.wslDistro, spawnSync) : fsApi;
            atomicWrite(targetFsApi, snapshot.filePath, snapshot.content);
          } else {
            const targetFsApi = target?.type === "wsl" ? createWslFsApi(target.wslDistro, spawnSync) : fsApi;
            if (targetFsApi.existsSync(snapshot.filePath)) {
              targetFsApi.unlinkSync(snapshot.filePath);
            }
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
