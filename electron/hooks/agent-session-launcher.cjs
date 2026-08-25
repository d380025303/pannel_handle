const { spawnSync: defaultSpawnSync } = require("node:child_process");
const os = require("node:os");

const AGENT_COMMANDS = Object.freeze({
  claude: "claude",
  codex: "codex",
  codebuddy: "codebuddy",
  opencode: "opencode",
  qoder: "qoder",
  copilot: "copilot",
  gemini: "gemini",
  grok: "grok"
});
const MIN_GEMINI_VERSION = "0.26.0";
const MIN_GROK_VERSION = "0.2.106";
const MIN_CODEBUDDY_BRIDGE_VERSION = "2.54.0";
const LOCAL_BRIDGE_PROVIDERS = new Set(["codex", "codebuddy", "opencode"]);
const OPENCODE_REMOTE_AGENT = "pannel-handle-remote";
const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";
const CODEBUDDY_REMOTE_INSTRUCTIONS_ENV = "PANNEL_HANDLE_REMOTE_AGENT_INSTRUCTIONS";
const OPTIONAL_SSH_COMMAND_CHECK_PROVIDERS = new Set(["claude", "codex"]);
const OPTIONAL_SSH_HOOK_PROVIDERS = new Set(["claude", "codex", "codebuddy", "qoder"]);
const AGENT_EXIT_MARKER_PREFIX = "__PANNEL_HANDLE_";
const AGENT_EXIT_MARKER_SUFFIX = "AGENT_EXIT__";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function getAgentCommand(provider) {
  const command = AGENT_COMMANDS[provider];
  if (!command) throw new Error(`Unsupported Agent provider: ${provider}.`);
  return command;
}

function getAgentInstallHint(provider) {
  if (provider === "copilot") {
    return " 请先安装 GitHub Copilot CLI：Windows 可运行 winget install GitHub.Copilot，WSL 可运行 npm install -g @github/copilot。";
  }
  if (provider === "gemini") {
    return " 请先运行 npm install -g @google/gemini-cli@latest。";
  }
  if (provider === "grok") {
    return " 请安装或升级 xAI 官方 Grok CLI：Windows 运行 irm https://x.ai/cli/install.ps1 | iex，WSL 运行 curl -fsSL https://x.ai/cli/install.sh | bash。";
  }
  return provider === "codebuddy"
    ? " 请先运行 npm install -g @tencent-ai/codebuddy-code。"
    : "";
}

function isPowerShell(shell) {
  const executable = String(shell || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
  return ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable);
}

function commandArg(session, value) {
  const text = String(value);
  if (session.type !== "windows") return shellQuote(text);
  if (isPowerShell(session.shell)) return `'${text.replace(/'/g, "''")}'`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildOpenRouterCodexCommand(session, config) {
  const overrides = [
    "model_provider=openrouter",
    "model_providers.openrouter.name=OpenRouter",
    `model_providers.openrouter.base_url=${config.baseUrl}`,
    `model_providers.openrouter.env_key=${config.apiKeyEnv}`,
    "model_providers.openrouter.wire_api=responses",
    `model_catalog_json=${config.catalogPath}`
  ];
  const args = ["codex"];
  for (const override of overrides) args.push("-c", commandArg(session, override));
  args.push("-m", commandArg(session, config.model));
  return args.join(" ");
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(value => Number.parseInt(value, 10) || 0);
  const b = String(right).split(".").map(value => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function readGeminiVersion(session, spawnSync) {
  const options = { encoding: "utf-8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 };
  const result = session.type === "wsl"
    ? spawnSync("wsl.exe", ["-d", session.wslDistro, "--", "sh", "-lc", "resolved=$(command -v gemini) || exit 127; case \"$resolved\" in /mnt/*) echo WINDOWS_SHIM >&2; exit 126;; esac; gemini --version"], options)
    : spawnSync("cmd.exe", ["/d", "/s", "/c", "gemini --version"], options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || "").includes("WINDOWS_SHIM")
      ? "WSL 中检测到的是 Windows Gemini shim，请在该 WSL 发行版内安装原生 Gemini CLI。"
      : `无法读取 Gemini CLI 版本。${getAgentInstallHint("gemini")}`;
    throw new Error(detail);
  }
  const match = String(result.stdout || result.stderr || "").match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
  if (!match) throw new Error(`无法识别 Gemini CLI 版本。${getAgentInstallHint("gemini")}`);
  if (compareVersions(match[1], MIN_GEMINI_VERSION) < 0) {
    throw new Error(`Gemini CLI 版本过低（当前 ${match[1]}，最低 ${MIN_GEMINI_VERSION}）。${getAgentInstallHint("gemini")}`);
  }
  return match[1];
}

function readGrokVersion(session, spawnSync) {
  const options = { encoding: "utf-8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 };
  const result = session.type === "wsl"
    ? spawnSync("wsl.exe", ["-d", session.wslDistro, "--", "sh", "-lc", "resolved=$(command -v grok) || exit 127; case \"$resolved\" in /mnt/*) echo WINDOWS_SHIM >&2; exit 126;; esac; grok --version"], options)
    : spawnSync("cmd.exe", ["/d", "/s", "/c", "grok --version"], options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || "").includes("WINDOWS_SHIM")
      ? "WSL 中检测到的是 Windows Grok shim，请在该 WSL 发行版内安装原生 Grok CLI。"
      : `无法读取 Grok CLI 版本。${getAgentInstallHint("grok")}`;
    throw new Error(detail);
  }
  const match = String(result.stdout || result.stderr || "").match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
  if (!match) throw new Error(`无法识别 Grok CLI 版本。${getAgentInstallHint("grok")}`);
  if (compareVersions(match[1], MIN_GROK_VERSION) < 0) {
    throw new Error(`Grok CLI 版本过低（当前 ${match[1]}，最低 ${MIN_GROK_VERSION}）。${getAgentInstallHint("grok")}`);
  }
  return match[1];
}

function buildAgentStartCommand(session, runtime = {}) {
  const command = getAgentCommand(session.agentProvider);
  const preCommand = String(session.initialCommand || "").trim();
  let agentCommand = session.agentProvider === "codex" && runtime.openRouter
    ? buildOpenRouterCodexCommand(session, runtime.openRouter)
    : command;

  if (session.type === "ssh" && session.agentProvider === "opencode") {
    if (!runtime.hookUrl || !runtime.sessionId) {
      throw new Error("OpenCode SSH notification environment is unavailable.");
    }
    agentCommand = `PANNEL_HANDLE_HOOK_URL=${shellQuote(runtime.hookUrl)} PANNEL_HANDLE_SESSION_ID=${shellQuote(runtime.sessionId)} ${command}`;
  }

  if (!preCommand) return agentCommand;
  if (session.type === "windows" && isPowerShell(session.shell)) {
    return `& { ${preCommand} }; if ($?) { ${agentCommand} }`;
  }
  return `${preCommand} && ${agentCommand}`;
}

function wrapAgentStartCommand(session, command) {
  if (session.type === "windows" && isPowerShell(session.shell)) {
    return `& { ${command} }; Write-Output ''; Write-Output ('${AGENT_EXIT_MARKER_PREFIX}' + '${AGENT_EXIT_MARKER_SUFFIX}')`;
  }
  if (session.type === "windows") {
    return `${command} & echo. & echo ${AGENT_EXIT_MARKER_PREFIX}AGENT^_EXIT__`;
  }
  return `${command}; printf '\\n%s%s\\n' '${AGENT_EXIT_MARKER_PREFIX}' '${AGENT_EXIT_MARKER_SUFFIX}'`;
}

function buildSshHookWarningCommand(provider, error) {
  const message = String(error?.message || error || "unknown error").trim() || "unknown error";
  return `printf '%s\\n' ${shellQuote(`[Pannel Handle] Remote ${provider} notification Hook is unavailable: ${message}. Starting without status notifications.`)} >&2`;
}

function buildSshCommandCheckWarningCommand(provider, error) {
  const message = String(error?.message || error || "unknown error").trim() || "unknown error";
  return `printf '%s\\n' ${shellQuote(`[Pannel Handle] Remote ${provider} command check failed: ${message}. Starting anyway.`)} >&2`;
}

function buildLocalCodexStartCommand(binding) {
  const powerShellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const args = [
    "codex",
    "-C",
    powerShellQuote(binding.workspacePath),
    "-s",
    "read-only",
    "-a",
    "on-request",
    "-c",
    powerShellQuote(`mcp_servers.pannel_handle_remote.url=${JSON.stringify(binding.url)}`),
    "-c",
    powerShellQuote(`mcp_servers.pannel_handle_remote.bearer_token_env_var=${JSON.stringify(binding.tokenEnv)}`)
  ];
  if (binding.developerInstructions) {
    args.push("-c", powerShellQuote(`developer_instructions=${JSON.stringify(binding.developerInstructions)}`));
  }
  return args.join(" ");
}

function readCodeBuddyVersion(spawnSync) {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "codebuddy --version"], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`无法读取 CodeBuddy CLI 版本。${getAgentInstallHint("codebuddy")}`);
  }
  const match = String(result.stdout || result.stderr || "").match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
  if (!match) throw new Error(`无法识别 CodeBuddy CLI 版本。${getAgentInstallHint("codebuddy")}`);
  if (compareVersions(match[1], MIN_CODEBUDDY_BRIDGE_VERSION) < 0) {
    throw new Error(`CodeBuddy CLI 版本过低（当前 ${match[1]}，本地桥接最低 ${MIN_CODEBUDDY_BRIDGE_VERSION}）。请升级 CodeBuddy CLI。`);
  }
  return match[1];
}

function buildLocalOpenCodeConfig(binding) {
  const agent = {
    mode: "primary",
    description: "Operate the scoped SSH workspace through Pannel Handle.",
    permission: {
      edit: "deny",
      bash: "deny",
      task: "deny",
      "pannel_handle_remote_*": "allow"
    }
  };
  if (binding.developerInstructions) agent.prompt = binding.developerInstructions;
  return JSON.stringify({
    mcp: {
      pannel_handle_remote: {
        type: "remote",
        url: binding.url,
        enabled: true,
        oauth: false,
        headers: {
          Authorization: `Bearer {env:${binding.tokenEnv}}`
        }
      }
    },
    agent: {
      [OPENCODE_REMOTE_AGENT]: agent
    }
  });
}

function buildLocalOpenCodeStartCommand(binding) {
  const powerShellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  return [
    "opencode",
    powerShellQuote(binding.workspacePath),
    "--agent",
    OPENCODE_REMOTE_AGENT
  ].join(" ");
}

function buildLocalCodeBuddyConfig(binding) {
  return JSON.stringify({
    mcpServers: {
      pannel_handle_remote: {
        type: "http",
        url: binding.url,
        headers: {
          Authorization: `Bearer \${${binding.tokenEnv}}`
        }
      }
    }
  });
}

function buildLocalCodeBuddyStartCommand(binding) {
  const powerShellQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const instructions = binding.runtimeInstructions || binding.developerInstructions;
  const args = [
    "codebuddy",
    "--mcp-config",
    powerShellQuote(buildLocalCodeBuddyConfig(binding)),
    "--strict-mcp-config",
    "--tools",
    powerShellQuote("Read,Glob,Grep")
  ];
  if (instructions) args.push("--append-system-prompt", `"$env:${CODEBUDDY_REMOTE_INSTRUCTIONS_ENV}"`);
  return args.join(" ");
}

function createAgentSessionLauncher({
  terminalManager,
  hookConfigManager,
  remoteHookConfigService,
  sshSessionRuntime,
  sshHookTunnelService,
  remoteAgentBridgeService,
  openRouterService,
  onTemplateLaunched = () => {},
  spawnSync = defaultSpawnSync,
  getDefaultShell = () => process.env.ComSpec || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  getLocalBridgeShell = () => "powershell.exe",
  getHomeDirectory = () => os.homedir()
}) {
  const switchingSessions = new Map();
  function resolveDefaultWorkingDirectory(session) {
    if (session.type !== "windows" || String(session.cwd || "").trim()) return session;
    return { ...session, cwd: getHomeDirectory() };
  }

  function resolveLocalShell(session) {
    if (session.type !== "windows" || session.shell) return session;
    return { ...session, shell: getDefaultShell() };
  }

  function validateAgentSession(session) {
    if (!session.agentProvider) return;
    getAgentCommand(session.agentProvider);
    if (session.type === "ssh" && session.agentProvider === "copilot") {
      throw new Error("GitHub Copilot CLI 首期仅支持 Windows 和 WSL 会话。");
    }
    if (session.type === "ssh" && session.agentProvider === "gemini") {
      throw new Error("Gemini CLI 首期仅支持 Windows 和 WSL 会话。");
    }
    if (session.type === "ssh" && session.agentProvider === "grok") {
      throw new Error("Grok CLI 首期仅支持 Windows 和 WSL 会话。");
    }
    const cwd = String(session.cwd || "").trim();
    if (!cwd || cwd === "~") {
      throw new Error("选择 Agent CLI 时必须填写明确的项目工作目录。");
    }
    const localSshBridge = session.type === "ssh" && session.agentLocation === "local";
    if ((session.type === "wsl" || (session.type === "ssh" && !localSshBridge)) && !cwd.startsWith("/")) {
      throw new Error("WSL/SSH Agent 项目目录必须是绝对 Linux 路径。");
    }
    if (session.type === "ssh" && session.agentLocation === "local" && !LOCAL_BRIDGE_PROVIDERS.has(session.agentProvider)) {
      throw new Error("SSH 本地桥接仅支持 Codex、CodeBuddy 和 OpenCode。");
    }
    if (session.type === "ssh" && session.agentProvider === "codex" && session.codexBackend === "openrouter") {
      throw new Error("OpenRouter Codex 首期仅支持 Windows 和 WSL 会话。");
    }
  }

  function assertLocalCommand(session) {
    const command = getAgentCommand(session.agentProvider);
    const result = session.type === "wsl"
      ? spawnSync("wsl.exe", ["-d", session.wslDistro, "--", "sh", "-lc", `command -v ${shellQuote(command)}`], { encoding: "utf-8", windowsHide: true })
      : spawnSync("where.exe", [command], { encoding: "utf-8", windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`未在${session.type === "wsl" ? ` WSL ${session.wslDistro}` : " Windows"}环境中找到命令：${command}。${getAgentInstallHint(session.agentProvider)}`);
    }
    if (session.agentProvider === "gemini") readGeminiVersion(session, spawnSync);
    if (session.agentProvider === "grok") readGrokVersion(session, spawnSync);
    if (session.agentProvider === "codebuddy" && session.agentLocation === "local") readCodeBuddyVersion(spawnSync);
    if (session.type === "windows" && session.agentProvider === "copilot") {
      const powerShell = spawnSync("where.exe", ["pwsh"], { encoding: "utf-8", windowsHide: true });
      if (powerShell.error || powerShell.status !== 0) {
        throw new Error("GitHub Copilot CLI 在 Windows 上需要 PowerShell 6 或更高版本，请先安装 Microsoft.PowerShell。");
      }
    }
  }

  async function assertSshCommand(sessionId, session) {
    const command = getAgentCommand(session.agentProvider);
    try {
      await sshSessionRuntime.exec(sessionId, `bash -lic ${shellQuote(`command -v ${command} >/dev/null 2>&1`)}`, {
        actionName: `检测远程命令 ${command}`
      });
    } catch {
      throw new Error(`未在远程 SSH 环境中找到命令：${command}。${getAgentInstallHint(session.agentProvider)}`);
    }
  }

  async function ensureLocalHook(session) {
    const target = session.type === "wsl"
      ? { type: "wsl", path: session.cwd, wslDistro: session.wslDistro }
      : { type: "windows", path: session.cwd };
    const inspection = hookConfigManager.inspect(target, [session.agentProvider]);
    if (!inspection.ok) throw new Error(`检测通知 Hook 失败：${inspection.error}`);
    if (inspection.providers[session.agentProvider]?.status === "installed") return;
    const installed = hookConfigManager.install(target, [session.agentProvider]);
    if (!installed.ok || installed.providers[session.agentProvider]?.status !== "installed") {
      throw new Error(`安装通知 Hook 失败：${installed.error || "安装后校验未通过"}`);
    }
  }

  async function ensureLocalHookAt(projectPath, provider) {
    const target = { type: "windows", path: projectPath };
    const inspection = hookConfigManager.inspect(target, [provider]);
    if (!inspection.ok) throw new Error(`检测通知 Hook 失败：${inspection.error}`);
    if (inspection.providers[provider]?.status === "installed") return;
    const installed = hookConfigManager.install(target, [provider]);
    if (!installed.ok || installed.providers[provider]?.status !== "installed") {
      throw new Error(`安装通知 Hook 失败：${installed.error || "安装后校验未通过"}`);
    }
  }

  async function ensureSshHook(sessionId, session) {
    const target = { type: "ssh", sessionId, path: session.cwd };
    const inspection = await remoteHookConfigService.inspect(target, [session.agentProvider]);
    if (!inspection.ok) throw new Error(`检测远程通知 Hook 失败：${inspection.error}`);
    if (inspection.providers[session.agentProvider]?.status !== "installed") {
      const installed = await remoteHookConfigService.install(target, [session.agentProvider]);
      if (!installed.ok || installed.providers[session.agentProvider]?.status !== "installed") {
        throw new Error(`安装远程通知 Hook 失败：${installed.error || "安装后校验未通过"}`);
      }
    }
    return session.agentProvider === "opencode"
      ? sshHookTunnelService.ensureTunnel(sessionId)
      : undefined;
  }

  async function prepareSshHook(sessionId, session) {
    try {
      return { tunnel: await ensureSshHook(sessionId, session), warningCommand: "" };
    } catch (err) {
      if (!OPTIONAL_SSH_HOOK_PROVIDERS.has(session.agentProvider)) {
        throw err;
      }
      if (typeof terminalManager.broadcastAgentHookDebug === "function") {
        terminalManager.broadcastAgentHookDebug({
          provider: session.agentProvider,
          eventName: "SshHookSetupFailed",
          matchedSessionId: sessionId,
          handled: false,
          payload: { message: err?.message || String(err) }
        });
      }
      return { tunnel: undefined, warningCommand: buildSshHookWarningCommand(session.agentProvider, err) };
    }
  }

  async function prepareSshCommand(sessionId, session) {
    try {
      await assertSshCommand(sessionId, session);
      return "";
    } catch (err) {
      if (!OPTIONAL_SSH_COMMAND_CHECK_PROVIDERS.has(session.agentProvider)) {
        throw err;
      }
      if (typeof terminalManager.broadcastAgentHookDebug === "function") {
        terminalManager.broadcastAgentHookDebug({
          provider: session.agentProvider,
          eventName: "SshCommandCheckFailed",
          matchedSessionId: sessionId,
          handled: false,
          payload: { message: err?.message || String(err) }
        });
      }
      return buildSshCommandCheckWarningCommand(session.agentProvider, err);
    }
  }

  async function prepareLocal(session) {
    validateAgentSession(session);
    assertLocalCommand(session);
    await ensureLocalHook(session);
    const openRouter = await openRouterService?.getLaunchConfig(session);
    return {
      runtimeInitialCommand: wrapAgentStartCommand(session, buildAgentStartCommand(session, { openRouter })),
      runtimeEnv: openRouter ? { [openRouter.apiKeyEnv]: openRouter.apiKey } : undefined,
      runtimeWslEnvKeys: openRouter ? [openRouter.apiKeyEnv] : undefined
    };
  }

  async function finishLocalSsh(session) {
    let binding;
    try {
      validateAgentSession(session);
      assertLocalCommand({ ...session, type: "windows", shell: getLocalBridgeShell() });
      if (!remoteAgentBridgeService) throw new Error("远程 Agent 桥接服务不可用。");
      binding = await remoteAgentBridgeService.createBinding(session.id);
      const preCommand = String(session.initialCommand || "").trim();
      if (preCommand) {
        await remoteAgentBridgeService.runConfiguredCommand(session.id, preCommand);
      }
      await ensureLocalHookAt(binding.workspacePath, session.agentProvider);
      const openCodeConfig = session.agentProvider === "opencode"
        ? buildLocalOpenCodeConfig(binding)
        : undefined;
      const codeBuddyInstructions = session.agentProvider === "codebuddy"
        ? binding.runtimeInstructions || binding.developerInstructions
        : undefined;
      const startCommand = session.agentProvider === "opencode"
        ? buildLocalOpenCodeStartCommand(binding)
        : session.agentProvider === "codebuddy"
          ? buildLocalCodeBuddyStartCommand(binding)
          : buildLocalCodexStartCommand(binding);
      return terminalManager.startDeferredSession(session.id, {
        terminalTransport: "local-agent",
        runtimeShell: getLocalBridgeShell(),
        runtimeCwd: binding.workspacePath,
        runtimeEnv: {
          [binding.tokenEnv]: binding.token,
          ...(openCodeConfig ? { [OPENCODE_CONFIG_ENV]: openCodeConfig } : {}),
          ...(codeBuddyInstructions ? { [CODEBUDDY_REMOTE_INSTRUCTIONS_ENV]: codeBuddyInstructions } : {})
        },
        runtimeInitialCommand: wrapAgentStartCommand(
          { type: "windows", shell: getLocalBridgeShell() },
          startCommand
        )
      });
    } catch (err) {
      if (binding) await remoteAgentBridgeService.closeBinding(session.id);
      terminalManager.closeSession(session.id);
      throw err;
    }
  }

  async function finishSsh(session) {
    try {
      validateAgentSession(session);
      const commandWarning = await prepareSshCommand(session.id, session);
      const { tunnel, warningCommand } = await prepareSshHook(session.id, session);
      const command = buildAgentStartCommand(session, {
        hookUrl: tunnel?.hookUrl,
        sessionId: session.id
      });
      const launchCommand = `cd ${shellQuote(session.cwd)} && ${command}`;
      const prefixCommands = [commandWarning, warningCommand].filter(Boolean);
      terminalManager.write(session.id, `${wrapAgentStartCommand(
        session,
        `${prefixCommands.length ? `${prefixCommands.join("; ")}; ` : ""}${launchCommand}`
      )}\r`);
      return session;
    } catch (err) {
      terminalManager.closeSession(session.id);
      throw err;
    }
  }

  async function createSession(options = {}) {
    let request = { ...options, type: options.type || "windows" };
    if (!request.agentProvider) return terminalManager.createSession(request);
    request = resolveLocalShell(resolveDefaultWorkingDirectory(request));
    validateAgentSession(request);
    if (request.type === "ssh") {
      const localBridge = request.agentLocation === "local";
      const session = terminalManager.createSession({
        ...request,
        ...(localBridge ? { deferTerminalStart: true } : { runtimeInitialCommand: "" })
      });
      try {
        return localBridge ? await finishLocalSsh(session) : await finishSsh(session);
      } catch (err) {
        if (session.templateId) terminalManager.deleteSavedSession(session.templateId);
        throw err;
      }
    }
    const runtime = await prepareLocal(request);
    return terminalManager.createSession({ ...request, ...runtime });
  }

  async function launchSession(template, options = {}) {
    const { recordUsage = false, ...launchOptions } = options;
    const launchTemplate = template.agentProvider ? resolveLocalShell(template) : template;
    let session;
    if (!launchTemplate.agentProvider) {
      session = terminalManager.launchSession(launchTemplate, launchOptions);
    } else {
      validateAgentSession(launchTemplate);
      if (launchTemplate.type === "ssh") {
        const localBridge = launchTemplate.agentLocation === "local";
        const pendingSession = terminalManager.launchSession(launchTemplate, {
          ...launchOptions,
          ...(localBridge ? { deferTerminalStart: true } : { runtimeInitialCommand: "" })
        });
        session = localBridge ? await finishLocalSsh(pendingSession) : await finishSsh(pendingSession);
      } else {
        const runtime = await prepareLocal(launchTemplate);
        session = terminalManager.launchSession(launchTemplate, { ...launchOptions, ...runtime });
      }
    }
    if (recordUsage) onTemplateLaunched(launchTemplate.id);
    return session;
  }

  async function launchSessions(templates, options = {}) {
    for (const template of templates) {
      await launchSession(template, options);
    }
    return terminalManager.listSessions();
  }

  function createReplacementTemplate(session, provider) {
    return {
      id: session.templateId || session.id,
      title: session.title,
      shell: session.shell,
      cwd: session.cwd,
      fileSort: session.fileSort,
      preferredDiskMountPoint: session.preferredDiskMountPoint,
      initialCommand: session.initialCommand,
      agentProvider: provider,
      agentLocation: session.agentLocation,
      localAgentCwd: session.localAgentCwd,
      codexBackend: provider === "codex" ? session.codexBackend : undefined,
      codexModel: provider === "codex" ? session.codexModel : undefined,
      type: session.type,
      wslDistro: session.wslDistro,
      sshConfig: session.sshConfig,
      quickCommands: session.quickCommands || [],
      tags: session.tags || []
    };
  }

  async function switchAgent(sessionId, provider) {
    if (switchingSessions.has(sessionId)) return switchingSessions.get(sessionId);
    const operation = (async () => {
      const session = terminalManager.getSession(sessionId);
      if (!session) throw new Error("Session is not running.");
      if (!session.agentProvider) throw new Error("Only Agent sessions can switch Agent.");
      if (session.agentProvider === provider) {
        const current = terminalManager.listSessions().find(entry => entry.id === sessionId);
        if (!current) throw new Error("Session is not running.");
        return current;
      }
      if (session.type === "ssh" && session.agentLocation === "local") {
        if (!LOCAL_BRIDGE_PROVIDERS.has(provider)) {
          throw new Error("Local SSH bridge sessions can only switch between Codex, CodeBuddy, and OpenCode.");
        }
        const target = createReplacementTemplate(session, provider);
        validateAgentSession(target);
        assertLocalCommand({ ...target, type: "windows", shell: getLocalBridgeShell() });

        terminalManager.closeSession(sessionId);
        const replacement = terminalManager.launchSession(target, {
          useProvidedTemplate: true,
          templateId: session.templateId,
          deferTerminalStart: true
        });
        return await finishLocalSsh(replacement);
      }

      const target = createReplacementTemplate(session, provider);
      validateAgentSession(target);
      const runtime = target.type === "ssh" ? { runtimeInitialCommand: "" } : await prepareLocal(target);

      terminalManager.closeSession(sessionId);
      const replacement = terminalManager.launchSession(target, {
        useProvidedTemplate: true,
        templateId: session.templateId,
        ...runtime
      });
      return target.type === "ssh" ? await finishSsh(replacement) : replacement;
    })();
    switchingSessions.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      switchingSessions.delete(sessionId);
    }
  }

  return { createSession, launchSession, launchSessions, switchAgent };
}

module.exports = {
  AGENT_COMMANDS,
  buildAgentStartCommand,
  buildLocalCodeBuddyConfig,
  buildLocalCodeBuddyStartCommand,
  buildLocalOpenCodeConfig,
  buildLocalOpenCodeStartCommand,
  buildOpenRouterCodexCommand,
  wrapAgentStartCommand,
  buildLocalCodexStartCommand,
  createAgentSessionLauncher,
  getAgentCommand,
  compareVersions,
  readCodeBuddyVersion,
  readGeminiVersion,
  readGrokVersion
};
