const { spawnSync: defaultSpawnSync } = require("node:child_process");

const AGENT_COMMANDS = Object.freeze({
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  qoder: "qoderclicn"
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function getAgentCommand(provider) {
  const command = AGENT_COMMANDS[provider];
  if (!command) throw new Error(`Unsupported Agent provider: ${provider}.`);
  return command;
}

function buildAgentStartCommand(session, runtime = {}) {
  const command = getAgentCommand(session.agentProvider);
  const preCommand = String(session.initialCommand || "").trim();
  let agentCommand = command;

  if (session.type === "ssh" && session.agentProvider === "opencode") {
    if (!runtime.hookUrl || !runtime.sessionId) {
      throw new Error("OpenCode SSH notification environment is unavailable.");
    }
    agentCommand = `PANNEL_HANDLE_HOOK_URL=${shellQuote(runtime.hookUrl)} PANNEL_HANDLE_SESSION_ID=${shellQuote(runtime.sessionId)} ${command}`;
  }

  if (!preCommand) return agentCommand;
  if (session.type === "windows") {
    return `& { ${preCommand} }; if ($?) { ${agentCommand} }`;
  }
  return `${preCommand} && ${agentCommand}`;
}

function createAgentSessionLauncher({
  terminalManager,
  hookConfigManager,
  remoteHookConfigService,
  sshSessionRuntime,
  sshHookTunnelService,
  spawnSync = defaultSpawnSync
}) {
  function validateAgentSession(session) {
    if (!session.agentProvider) return;
    getAgentCommand(session.agentProvider);
    const cwd = String(session.cwd || "").trim();
    if (!cwd || cwd === "~") {
      throw new Error("选择 Agent CLI 时必须填写明确的项目工作目录。");
    }
    if ((session.type === "wsl" || session.type === "ssh") && !cwd.startsWith("/")) {
      throw new Error("WSL/SSH Agent 项目目录必须是绝对 Linux 路径。");
    }
  }

  function assertLocalCommand(session) {
    const command = getAgentCommand(session.agentProvider);
    const result = session.type === "wsl"
      ? spawnSync("wsl.exe", ["-d", session.wslDistro, "--", "sh", "-lc", `command -v ${shellQuote(command)}`], { encoding: "utf-8", windowsHide: true })
      : spawnSync("where.exe", [command], { encoding: "utf-8", windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`未在${session.type === "wsl" ? ` WSL ${session.wslDistro}` : " Windows"}环境中找到命令：${command}`);
    }
  }

  async function assertSshCommand(sessionId, session) {
    const command = getAgentCommand(session.agentProvider);
    try {
      await sshSessionRuntime.exec(sessionId, `bash -lic ${shellQuote(`command -v ${command} >/dev/null 2>&1`)}`, {
        actionName: `检测远程命令 ${command}`
      });
    } catch {
      throw new Error(`未在远程 SSH 环境中找到命令：${command}`);
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

  async function prepareLocal(session) {
    validateAgentSession(session);
    assertLocalCommand(session);
    await ensureLocalHook(session);
    return buildAgentStartCommand(session);
  }

  async function finishSsh(session) {
    try {
      validateAgentSession(session);
      await assertSshCommand(session.id, session);
      const tunnel = await ensureSshHook(session.id, session);
      const command = buildAgentStartCommand(session, {
        hookUrl: tunnel?.hookUrl,
        sessionId: session.id
      });
      terminalManager.write(session.id, `cd ${shellQuote(session.cwd)} && ${command}\r`);
      return session;
    } catch (err) {
      terminalManager.closeSession(session.id);
      throw err;
    }
  }

  async function createSession(options = {}) {
    const request = { ...options, type: options.type || "windows" };
    if (!request.agentProvider) return terminalManager.createSession(request);
    validateAgentSession(request);
    if (request.type === "ssh") {
      const session = terminalManager.createSession({ ...request, runtimeInitialCommand: "" });
      try {
        return await finishSsh(session);
      } catch (err) {
        terminalManager.deleteSavedSession(session.templateId);
        throw err;
      }
    }
    const runtimeInitialCommand = await prepareLocal(request);
    return terminalManager.createSession({ ...request, runtimeInitialCommand });
  }

  async function launchSession(template) {
    if (!template.agentProvider) return terminalManager.launchSession(template);
    validateAgentSession(template);
    if (template.type === "ssh") {
      const session = terminalManager.launchSession(template, { runtimeInitialCommand: "" });
      return finishSsh(session);
    }
    const runtimeInitialCommand = await prepareLocal(template);
    return terminalManager.launchSession(template, { runtimeInitialCommand });
  }

  async function launchSessions(templates) {
    for (const template of templates) {
      await launchSession(template);
    }
    return terminalManager.listSessions();
  }

  return { createSession, launchSession, launchSessions };
}

module.exports = {
  AGENT_COMMANDS,
  buildAgentStartCommand,
  createAgentSessionLauncher,
  getAgentCommand
};
