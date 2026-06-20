const fs = require("node:fs");
const path = require("node:path");
const posix = path.posix;
const SftpClient = require("ssh2-sftp-client");
const {
  PROVIDER_CONFIG,
  buildConfig,
  isManagedCommand
} = require("./hook-config-manager.cjs");
const { createSshSessionRuntime } = require("./ssh-session-runtime.cjs");

const SSH_PROVIDERS = ["claude", "codex", "opencode", "qoder"];

function normalizeRemotePath(value) {
  const remotePath = String(value || "").trim().replace(/\\/g, "/");
  if (!remotePath || !remotePath.startsWith("/") || remotePath.includes("\0")) {
    throw new Error("SSH project path must be an absolute Linux path.");
  }
  return remotePath.replace(/\/+$/, "") || "/";
}

function normalizeProviders(providers) {
  const selected = Array.isArray(providers) ? providers.filter(provider => SSH_PROVIDERS.includes(provider)) : SSH_PROVIDERS;
  return [...new Set(selected)];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildRemoteHookCommand(provider, hookUrl, sessionId) {
  const definition = PROVIDER_CONFIG[provider];
  return [
    `PANNEL_HANDLE_HOOK_URL=${shellQuote(hookUrl)}`,
    `PANNEL_HANDLE_SESSION_ID=${shellQuote(sessionId)}`,
    definition.wslCommand
  ].join(" ");
}

function getProviderPaths(projectPath, provider) {
  const definition = PROVIDER_CONFIG[provider];
  return {
    configPath: definition.configPath ? posix.join(projectPath, ...definition.configPath) : undefined,
    scriptPath: posix.join(projectPath, ...(definition.scriptPath || definition.wslScriptPath)),
    assetPath: path.join(__dirname, "hook-assets", definition.asset || definition.wslAsset)
  };
}

async function readRemoteText(sftp, remotePath) {
  try {
    const data = await sftp.get(remotePath);
    return {
      exists: true,
      content: Buffer.isBuffer(data) ? data.toString("utf-8") : String(data)
    };
  } catch (err) {
    if (err.code === 2 || /no such file|not exist|not found/i.test(err.message || "")) {
      return { exists: false, content: "" };
    }
    throw err;
  }
}

function parseRemoteJson(remotePath, content) {
  if (!content.trim()) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in ${remotePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON in ${remotePath}: Root value must be an object.`);
  }
  return parsed;
}

async function ensureRemoteDir(sftp, remotePath) {
  await sftp.mkdir(remotePath, true);
}

async function writeRemoteText(sftp, remotePath, content, snapshots) {
  const previous = await readRemoteText(sftp, remotePath);
  snapshots.push({ remotePath, ...previous });
  await ensureRemoteDir(sftp, posix.dirname(remotePath));
  if (previous.exists) {
    await sftp.put(Buffer.from(previous.content, "utf-8"), `${remotePath}.pannel-handle.bak`);
  }
  const tempPath = `${remotePath}.pannel-handle.tmp`;
  await sftp.put(Buffer.from(content, "utf-8"), tempPath);
  if (typeof sftp.posixRename === "function") {
    await sftp.posixRename(tempPath, remotePath);
  } else {
    await sftp.rename(tempPath, remotePath);
  }
}

async function rollback(sftp, snapshots) {
  for (const snapshot of snapshots.reverse()) {
    try {
      if (snapshot.exists) {
        await sftp.put(Buffer.from(snapshot.content, "utf-8"), snapshot.remotePath);
      } else {
        await sftp.delete(snapshot.remotePath);
      }
    } catch (err) {
      console.error("Failed to roll back remote Hook installation:", err);
    }
  }
}

function createRemoteHookConfigService({
  terminalManager,
  sessionStore,
  knownHostStore,
  sshHookTunnelService,
  sshSessionRuntime,
  sftpFactory = () => new SftpClient()
}) {
  const sshRuntime = sshSessionRuntime || createSshSessionRuntime({
    terminalManager,
    sessionStore,
    knownHostStore,
    sftpFactory
  });

  function getSession(sessionId) {
    const session = terminalManager.getSession(sessionId);
    if (!session) throw new Error("Session is not running.");
    if (session.type !== "ssh") throw new Error("Remote Hook installation is only available for SSH sessions.");
    return session;
  }

  async function connect(sessionId) {
    getSession(sessionId);
    return sshRuntime.createSftpClient(sessionId);
  }

  async function inspectProvider(sftp, projectPath, provider, hookUrl, sessionId) {
    const paths = getProviderPaths(projectPath, provider);
    const expectedScript = fs.readFileSync(paths.assetPath, "utf-8");
    const script = await readRemoteText(sftp, paths.scriptPath);
    if (!paths.configPath) {
      return {
        status: script.exists && script.content === expectedScript ? "installed" : script.exists ? "needs_repair" : "not_installed",
        scriptPath: paths.scriptPath,
        managedHookCount: script.exists ? 1 : 0,
        expectedHookCount: 1
      };
    }
    const configFile = await readRemoteText(sftp, paths.configPath);
    const config = parseRemoteJson(paths.configPath, configFile.content);
    const expectedConfig = buildConfig(config, provider, "ssh", buildRemoteHookCommand(provider, hookUrl, sessionId));
    const managedCount = Object.values(config.hooks || {})
      .filter(Array.isArray)
      .flat()
      .flatMap(group => Array.isArray(group?.hooks) ? group.hooks : [])
      .filter(hook => isManagedCommand(hook?.command))
      .length;

    const configMatches = JSON.stringify(config) === JSON.stringify(expectedConfig);
    const scriptMatches = script.exists && script.content === expectedScript;
    return {
      status: configMatches && scriptMatches ? "installed" : managedCount > 0 || script.exists ? "needs_repair" : "not_installed",
      configPath: paths.configPath,
      scriptPath: paths.scriptPath,
      managedHookCount: managedCount,
      expectedHookCount: PROVIDER_CONFIG[provider].events.length
    };
  }

  async function inspect(target, providers = SSH_PROVIDERS) {
    const selected = normalizeProviders(providers);
    try {
      const sessionId = String(target?.sessionId || "");
      const projectPath = normalizeRemotePath(target?.path);
      const { hookUrl } = await sshHookTunnelService.ensureTunnel(sessionId);
      const sftp = await connect(sessionId);
      try {
        const stat = await sftp.stat(projectPath);
        if (!stat || stat.isDirectory === false) {
          throw new Error("Project path is not a directory.");
        }
        const result = {};
        for (const provider of selected) {
          result[provider] = await inspectProvider(sftp, projectPath, provider, hookUrl, sessionId);
        }
        return { ok: true, projectPath, providers: result };
      } finally {
        await sftp.end();
      }
    } catch (err) {
      return { ok: false, error: err.message, providers: {} };
    }
  }

  async function install(target, providers = SSH_PROVIDERS) {
    const selected = normalizeProviders(providers);
    if (selected.length === 0) {
      return { ok: false, error: "Select at least one supported SSH Hook provider.", providers: {} };
    }

    const snapshots = [];
    let sftp;
    try {
      const sessionId = String(target?.sessionId || "");
      const projectPath = normalizeRemotePath(target?.path);
      const { hookUrl } = await sshHookTunnelService.ensureTunnel(sessionId);
      sftp = await connect(sessionId);
      const stat = await sftp.stat(projectPath);
      if (!stat || stat.isDirectory === false) {
        throw new Error("Project path is not a directory.");
      }

      for (const provider of selected) {
        const paths = getProviderPaths(projectPath, provider);
        const expectedScript = fs.readFileSync(paths.assetPath, "utf-8");
        if (paths.configPath) {
          const configFile = await readRemoteText(sftp, paths.configPath);
          const config = parseRemoteJson(paths.configPath, configFile.content);
          const nextConfig = buildConfig(config, provider, "ssh", buildRemoteHookCommand(provider, hookUrl, sessionId));
          await writeRemoteText(sftp, paths.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, snapshots);
        }
        await writeRemoteText(sftp, paths.scriptPath, expectedScript, snapshots);
      }

      await sftp.end();
      return inspect(target, selected);
    } catch (err) {
      if (sftp) {
        await rollback(sftp, snapshots);
        await sftp.end();
      }
      return { ok: false, error: err.message, providers: {} };
    }
  }

  return {
    inspect,
    install,
    buildRemoteHookCommand
  };
}

module.exports = {
  SSH_PROVIDERS,
  buildRemoteHookCommand,
  createRemoteHookConfigService,
  normalizeRemotePath
};
