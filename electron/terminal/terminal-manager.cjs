const { mergeEnvironment } = require("../services/environment/index.cjs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execSync } = require("node:child_process");
const nodePty = require("node-pty");
const { sanitizeSshConfig } = require("../ssh/ssh-config-utils.cjs");
const { buildSsh2ConnectionConfig, validateSsh2Config } = require("../ssh/ssh2-connection.cjs");
const { createSsh2Terminal } = require("../ssh/ssh2-terminal.cjs");
const { getCopilotOtelPath } = require("../services/token-usage/index.cjs");

const MAX_AGENT_COMMAND_INPUT_LENGTH = 1024;
const CODEX_CLEAR_COMPLETION_PREFIXES = new Set(["/cl", "/cle", "/clea", "/clear"]);
const AGENT_EXIT_MARKER = "__PANNEL_HANDLE_AGENT_EXIT__";

function consumeAgentCommandInput(currentState, data) {
  let input = currentState?.input || "";
  let overflow = currentState?.overflow === true;
  let escapeMode = currentState?.escapeMode || "none";
  let clearSubmissions = 0;

  for (const character of String(data || "")) {
    if (escapeMode === "escape") {
      if (character === "[" || character === "]") {
        escapeMode = character === "[" ? "csi" : "osc";
        continue;
      }
      escapeMode = "none";
      input = "";
      overflow = false;
    }
    if (escapeMode === "csi") {
      if (/[@-~]/.test(character)) {
        escapeMode = "none";
      }
      continue;
    }
    if (escapeMode === "osc") {
      if (character === "\x07") {
        escapeMode = "none";
      } else if (character === "\x1b") {
        escapeMode = "osc-escape";
      }
      continue;
    }
    if (escapeMode === "osc-escape") {
      escapeMode = character === "\\" ? "none" : "osc";
      continue;
    }
    if (character === "\x1b") {
      escapeMode = "escape";
      continue;
    }
    if (character === "\b" || character === "\x7f") {
      if (!overflow) {
        input = Array.from(input).slice(0, -1).join("");
      }
      continue;
    }
    if (character === "\x15") {
      input = "";
      overflow = false;
      continue;
    }
    if (character === "\t" && !overflow && CODEX_CLEAR_COMPLETION_PREFIXES.has(input.trim())) {
      input = "/clear";
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (!overflow && /^[\t ]*\/clear[\t ]*$/.test(input)) {
        clearSubmissions += 1;
      }
      input = "";
      overflow = false;
      continue;
    }
    if (character < " " && character !== "\t") {
      input = "";
      overflow = false;
      continue;
    }
    if (!overflow) {
      if (input.length + character.length <= MAX_AGENT_COMMAND_INPUT_LENGTH) {
        input += character;
      } else {
        overflow = true;
      }
    }
  }

  return {
    state: { input, overflow, escapeMode },
    clearSubmissions
  };
}

function resolveRunnableExecutable(executable, execFile = execFileSync) {
  let output;
  try {
    output = execFile("where.exe", [executable], {
      encoding: "utf-8",
      windowsHide: true
    });
  } catch {
    return null;
  }

  const candidates = String(output || "")
    .split(/\r?\n/)
    .map(candidate => candidate.trim())
    .filter(Boolean)
    .filter((candidate, index, values) =>
      values.findIndex(value => value.toLowerCase() === candidate.toLowerCase()) === index
    );

  for (const candidate of candidates) {
    try {
      execFile(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
        stdio: "ignore",
        timeout: 3000,
        windowsHide: true
      });
      return candidate;
    } catch {
      // Continue past stale WindowsApps aliases and try the next resolved executable.
    }
  }

  return null;
}

function getDefaultShell({
  platform = process.platform,
  env = process.env,
  resolveExecutable = resolveRunnableExecutable,
  preference = "cmd",
  requireAvailable = true
} = {}) {
  if (platform !== "win32") {
    return env.SHELL || "bash";
  }

  if (preference === "pwsh") {
    if (!requireAvailable) return "pwsh.exe";
    const pwshPath = resolveExecutable("pwsh.exe");
    if (!pwshPath) throw new Error("PowerShell 7 不可用，请安装 PowerShell 7 或修改 Shell 选择。 / PowerShell 7 is unavailable; install it or select another shell.");
    return pwshPath;
  }
  if (preference === "powershell") {
    return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  return env.ComSpec || path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
}

function getWslShell() {
  return "C:\\Windows\\System32\\wsl.exe";
}

function getSshShell() {
  return "ssh2";
}

function listWslDistros() {
  try {
    const output = execSync("wsl.exe -l -q", {
      encoding: "utf-8",
      timeout: 5000
    });
    return output
      .replace(/\0/g, "")
      .replace(/\r/g, "")
      .replace(/^\uFEFF/, "")
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch (err) {
    console.error("Failed to list WSL distros:", err);
    return [];
  }
}

function appendWslEnv(existingValue, variableNames) {
  const entries = String(existingValue || "")
    .split(":")
    .map(entry => entry.trim())
    .filter(Boolean);
  const knownNames = new Set(entries.map(entry => entry.split("/")[0]));

  for (const variableName of variableNames) {
    if (!knownNames.has(variableName)) {
      entries.push(`${variableName}/u`);
      knownNames.add(variableName);
    }
  }

  return entries.join(":");
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function splitSshExtraArgs(value) {
  if (Array.isArray(value)) {
    return value.map(arg => String(arg).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/\s+/)
    .map(arg => arg.trim())
    .filter(Boolean);
}

function buildSshArgs(sshConfig = {}) {
  const host = String(sshConfig.host || "").trim();
  if (!host) {
    throw new Error("SSH host is required.");
  }

  const username = String(sshConfig.username || "").trim();
  const parsedPort = Number(sshConfig.port || 22);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 22;
  const args = [username ? `${username}@${host}` : host, "-p", String(port)];
  const identityFile = String(sshConfig.identityFile || "").trim();
  if (identityFile) {
    args.push("-i", identityFile);
  }
  args.push(...splitSshExtraArgs(sshConfig.extraArgs));

  const remoteCommand = String(sshConfig.remoteCommand || "").trim();
  if (remoteCommand) {
    args.push("-t", remoteCommand);
  }

  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function getInitialCommand(session, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "runtimeInitialCommand")) {
    return String(options.runtimeInitialCommand || "").trim();
  }
  const legacyRemoteCommand = session.type === "ssh" ? String(session.sshConfig?.remoteCommand || "").trim() : "";
  const command = String(options.initialCommand || session.initialCommand || legacyRemoteCommand || "").trim();
  if (session.type !== "ssh") {
    return command;
  }

  const cwd = String(session.cwd || "").trim();
  if (!cwd || cwd === "~") {
    return command;
  }

  const cdCommand = `cd ${shellQuote(cwd)}`;
  return command ? `${cdCommand} && ${command}` : cdCommand;
}

function createTerminalManager({
  environmentService,
  sessionStore,
  configStore,
  broadcast,
  getHookUrl,
  onSessionClosed,
  onAgentStatusChanged,
  knownHostStore,
  pty = nodePty,
  ssh2TerminalFactory = createSsh2Terminal,
  sshReconnectDelaysMs = [2000, 5000, 10000, 30000],
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  getDefaultShell: resolveDefaultShell = (preference) => getDefaultShell({ preference: preference || configStore?.getConfig().defaultWindowsShell })
}) {
  const sessions = new Map();
  const sessionOrder = [];
  let nextRuntimeId = 1;

  function syncLastActiveIds() {
    if (!configStore) return;
    const templateIds = listSessions()
      .map(s => s.templateId)
      .filter(Boolean);
    const current = configStore.getConfig().lastActiveSessionIds || [];
    if (JSON.stringify(current) !== JSON.stringify(templateIds)) {
      configStore.updateConfig({ lastActiveSessionIds: templateIds });
    }
  }

  function broadcastAgentStatus(payload) {
    const { provider = "claude", ...rest } = payload;
    const statusPayload = {
      provider,
      timestamp: Date.now(),
      ...rest
    };
    broadcast("agent:status", statusPayload);
    if (typeof onAgentStatusChanged === "function") {
      try {
        onAgentStatusChanged(statusPayload);
      } catch (err) {
        console.error("Failed to handle agent status change:", err);
      }
    }
  }

  function broadcastAgentHookDebug(payload) {
    const { provider = "claude", ...rest } = payload;
    broadcast("agent:hook-debug", {
      provider,
      timestamp: Date.now(),
      ...rest
    });
  }


  function serializeSession(session) {
    return {
      environmentProfileId: session.environmentProfileId,
      environmentOverrides: session.environmentOverrides,
      id: session.id,
      templateId: session.templateId,
      title: session.title,
      shell: session.shell,
      cwd: session.cwd,
      fileSort: session.fileSort,
      preferredDiskMountPoint: session.preferredDiskMountPoint,
      createdAt: session.createdAt,
      initialCommand: session.initialCommand,
      agentProvider: session.agentProvider,
      runtimeMode: session.runtimeMode,
      agentLocation: session.agentLocation,
      localAgentCwd: session.localAgentCwd,
      codexBackend: session.codexBackend,
      codexModel: session.codexModel,
      codexExperimentalAcknowledged: session.codexExperimentalAcknowledged,
      codexAppServerEnabled: session.codexAppServerEnabled,
      codeBuddyAcpEnabled: session.codeBuddyAcpEnabled,
      codexExecutionPermission: session.codexExecutionPermission,
      type: session.type,
      wslDistro: session.wslDistro,
      sshConfig: sanitizeSshConfig(session.sshConfig),
      ...(session.type === "ssh" ? {
        sshConnectionState: session.sshConnectionState || "connecting",
        sshReconnectAttempt: session.sshReconnectAttempt || 0
      } : {}),
      quickCommands: session.quickCommands || [],
      tags: session.tags || []
    };
  }

  function listSessions() {
    return sessionOrder
      .filter(id => sessions.has(id))
      .map(id => serializeSession(sessions.get(id)));
  }

  function createRuntimeId() {
    let id = `run-${nextRuntimeId++}`;
    while (sessions.has(id)) {
      id = `run-${nextRuntimeId++}`;
    }
    return id;
  }

  function getRuntimeTitle(template, matchTemplate = true) {
    const usedTitles = new Set(
      Array.from(sessions.values())
        .filter(session => matchTemplate ? session.templateId === template.id : !session.templateId)
        .map(session => session.title)
    );

    if (!usedTitles.has(template.title)) {
      return template.title;
    }

    let index = 2;
    let title = `${template.title} #${index}`;
    while (usedTitles.has(title)) {
      index += 1;
      title = `${template.title} #${index}`;
    }
    return title;
  }

  function getSshSecret(session) {
    const encryptedSecret = session.sshConfig?.encryptedSecret;
    if (!encryptedSecret || typeof sessionStore.decryptSecret !== "function") {
      return undefined;
    }
    return sessionStore.decryptSecret(encryptedSecret);
  }

  function getSshSecretPromptSignature(session) {
    const text = stripAnsi(session.buffer.slice(-5).join(""))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "");
    const match = text.match(/(?:^|\n)[^\n]*(?:password:|enter passphrase for key\b[^\n]*:)[ \t]*$/i);
    if (!match) {
      return undefined;
    }
    return `${text.length}:${match[0]}`;
  }

  function maybeAutofillTerminalSecretPrompt(session) {
    if (session.terminalTransport !== "ssh" || !session.sshSecret || session.sshSecretAttempts >= 2) {
      return;
    }
    const promptSignature = getSshSecretPromptSignature(session);
    if (!promptSignature || promptSignature === session.lastSshSecretPromptSignature) {
      return;
    }
    session.lastSshSecretPromptSignature = promptSignature;
    session.sshSecretAttempts += 1;
    session.term.write(`${session.sshSecret}\r`);
  }

  function maybeDetectCodexPermissionPrompt(session) {
    if (session.agentProvider !== "codex" || session.agentStatus !== "running") {
      return;
    }

    const text = stripAnsi(session.buffer.slice(-5).join("")).replace(/\r/g, "\n");
    if (!/would you like to run the following command\?/i.test(text)) {
      return;
    }

    session.agentStatus = "waiting_for_permission";
    broadcastAgentStatus({
      id: session.id,
      provider: "codex",
      status: "waiting_for_permission",
      eventName: "TerminalPermissionPrompt"
    });
  }

  function appendTerminalData(session, data) {
    session.buffer.push(data);
    if (session.buffer.length > 1000) {
      session.buffer.splice(0, session.buffer.length - 1000);
    }
    broadcast("terminal:data", { id: session.id, data });
  }

  function clearSshReconnectTimer(session) {
    if (session.sshReconnectTimer) {
      clearTimeoutFn(session.sshReconnectTimer);
      session.sshReconnectTimer = undefined;
    }
  }

  function setSshConnectionState(session, state, attempt = session.sshReconnectAttempt || 0) {
    session.sshConnectionState = state;
    session.sshReconnectAttempt = attempt;
    broadcast("sessions:changed", listSessions());
  }

  function setAppServerConnectionState(id, state) {
    const session = sessions.get(id);
    if (!session || session.type !== "ssh" || session.runtimeMode !== "app-server") return;
    if (!["connected", "disconnected", "reconnecting"].includes(state)) throw new Error("无效的 SSH 连接状态。");
    setSshConnectionState(session, state, state === "reconnecting" ? session.sshReconnectAttempt + 1 : 0);
  }

  function removeRuntimeSession(session) {
    clearSshReconnectTimer(session);
    sessions.delete(session.id);
    const orderIndex = sessionOrder.indexOf(session.id);
    if (orderIndex >= 0) sessionOrder.splice(orderIndex, 1);
    if (typeof onSessionClosed === "function") onSessionClosed(session.id);
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();
  }

  function scheduleSshReconnect(session) {
    if (!sessions.has(session.id) || session.closing) return;
    clearSshReconnectTimer(session);
    const attempt = (session.sshReconnectAttempt || 0) + 1;
    const delayIndex = Math.min(attempt - 1, sshReconnectDelaysMs.length - 1);
    const delay = Math.max(0, Number(sshReconnectDelaysMs[delayIndex] ?? 30000));
    setSshConnectionState(session, "reconnecting", attempt);
    appendTerminalData(session, `\r\n[SSH disconnected. Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${attempt})...]\r\n`);
    session.sshReconnectTimer = setTimeoutFn(() => {
      session.sshReconnectTimer = undefined;
      if (!sessions.has(session.id) || session.closing) return;
      try {
        spawnSsh2(session, { cols: session.cols, rows: session.rows, reconnecting: true });
      } catch (err) {
        setSshConnectionState(session, "disconnected", attempt);
        appendTerminalData(session, `\r\n[SSH reconnect failed: ${err instanceof Error ? err.message : String(err)}]\r\n`);
      }
    }, delay);
  }

  function consumeAgentExitMarker(session, data) {
    let text = "";
    let candidate = session.agentMarkerRemainder || "";
    let atLineStart = session.agentMarkerAtLineStart !== false;
    let detected = false;

    for (const character of String(data || "")) {
      if (candidate) {
        if (character === AGENT_EXIT_MARKER[candidate.length]) {
          candidate += character;
          if (candidate === AGENT_EXIT_MARKER) {
            candidate = "";
            detected = true;
            atLineStart = false;
          }
          continue;
        }
        text += candidate;
        candidate = "";
        atLineStart = false;
      }

      if (atLineStart && character === AGENT_EXIT_MARKER[0]) {
        candidate = character;
        continue;
      }

      text += character;
      atLineStart = character === "\r" || character === "\n";
    }

    session.agentMarkerRemainder = candidate;
    session.agentMarkerAtLineStart = atLineStart;

    if (detected) {
      session.agentStatus = "ended";
      broadcastAgentStatus({
        id: session.id,
        provider: session.agentRuntimeProvider || session.agentProvider,
        status: "ended",
        eventName: "AgentExit"
      });
    }

    return text;
  }

  function attachTerminal(session, term, options = {}) {
    if (!term
        || typeof term.onData !== "function"
        || typeof term.onExit !== "function"
        || typeof term.write !== "function"
        || typeof term.resize !== "function"
        || typeof term.kill !== "function") {
      throw new TypeError(`Failed to start session "${session.title}": invalid terminal instance.`);
    }

    session.term = term;
    if (!Array.isArray(session.buffer)) session.buffer = [];
    session.cols = Math.max(2, Math.floor(Number(options.cols || term.cols || 100)));
    session.rows = Math.max(1, Math.floor(Number(options.rows || term.rows || 30)));
    session.sshSecret = session.terminalTransport === "ssh" ? getSshSecret(session) : undefined;
    session.sshSecretAttempts = 0;
    session.lastSshSecretPromptSignature = undefined;
    session.agentMarkerRemainder = "";
    session.agentMarkerAtLineStart = true;
    broadcast("terminal:started", { id: session.id, cols: session.cols, rows: session.rows });

    if (!Number.isInteger(session.terminalGeneration)) session.terminalGeneration = 0;
    const terminalGeneration = session.terminalGeneration;
    term.onData((data) => {
      if (!sessions.has(session.id) || session.terminalGeneration !== terminalGeneration) return;
      const visibleData = consumeAgentExitMarker(session, data);
      if (!visibleData) return;
      appendTerminalData(session, visibleData);
      maybeAutofillTerminalSecretPrompt(session);
      maybeDetectCodexPermissionPrompt(session);
    });

    if (typeof term.onStatus === "function") {
      term.onStatus(({ status }) => {
        if (!sessions.has(session.id) || session.terminalGeneration !== terminalGeneration || session.closing) return;
        if (status === "connected") {
          const wasReconnecting = session.sshConnectionState === "reconnecting" || session.sshReconnectAttempt > 0;
          session.sshEverConnected = true;
          clearSshReconnectTimer(session);
          setSshConnectionState(session, "connected", 0);
          if (wasReconnecting) appendTerminalData(session, "\r\n[SSH reconnected.]\r\n");
        }
      });
    }

    term.onExit(({ exitCode, reason, retryable, message }) => {
      if (!sessions.has(session.id) || session.terminalGeneration !== terminalGeneration || session.closing) return;
      session.term = undefined;
      if (session.type === "ssh" && retryable === true) {
        broadcastAgentStatus({
          id: session.id,
          status: "exited",
          eventName: "SshExit",
          message: message || `Exit code ${exitCode}`
        });
        scheduleSshReconnect(session);
        return;
      }
      if (session.type === "ssh" && session.sshEverConnected && reason !== "remote-exit" && reason !== "killed") {
        setSshConnectionState(session, "disconnected");
        appendTerminalData(session, `\r\n[SSH disconnected${message ? `: ${message}` : "."}]\r\n`);
        return;
      }
      broadcast("terminal:exit", { id: session.id, exitCode });
      broadcastAgentStatus({
        id: session.id,
        status: "exited",
        eventName: session.terminalTransport === "ssh" ? "SshExit" : "PtyExit",
        message: `Exit code ${exitCode}`
      });
      removeRuntimeSession(session);
    });

    const initialCommand = getInitialCommand(session, options);
    if (initialCommand) {
      const cmd = String(initialCommand).trim();
      if (cmd) {
        const disposable = term.onData(() => {
          disposable.dispose();
          const activeSession = sessions.get(session.id);
          if (activeSession && activeSession.terminalGeneration === terminalGeneration) activeSession.term?.write(cmd + "\r");
        });
      }
    }
  }

  function spawnSsh2(session, options = {}) {
    session.terminalTransport = "ssh";
    clearSshReconnectTimer(session);
    session.terminalGeneration = (session.terminalGeneration || 0) + 1;
    session.sshConnectionState = options.reconnecting ? "reconnecting" : "connecting";
    validateSsh2Config(session.sshConfig);
    const environment = environmentService?.resolve(session) || {};
    if (Object.keys(environment).length && session.sshConfig?.remotePlatform === "windows") {
      throw new Error("SSH 环境变量注入仅支持 Linux / Bash。");
    }
    const term = ssh2TerminalFactory({
      environment,
      connectionConfig: buildSsh2ConnectionConfig({
        sshConfig: session.sshConfig,
        secret: getSshSecret(session),
        knownHostStore,
        onHostVerification: (result) => {
          if (result.trustedFirstUse) {
            broadcast("terminal:data", {
              id: session.id,
              data: `\r\nSSH host key trusted: ${result.fingerprint}\r\n`
            });
          } else if (result.accepted === false) {
            broadcast("terminal:data", {
              id: session.id,
              data: `\r\nSSH host key mismatch. Expected ${result.expectedFingerprint}, got ${result.fingerprint}.\r\n`
            });
          }
        }
      }),
      cols: options.cols || 100,
      rows: options.rows || 30
    });
    attachTerminal(session, term, options);
  }

  function spawnPty(session, options = {}) {
    if (session.type === "ssh" && options.terminalTransport !== "local-agent") {
      spawnSsh2(session, options);
      return;
    }

    session.terminalTransport = options.terminalTransport === "local-agent" ? "local-agent" : "local";

    const args = session.type === "wsl" && session.wslDistro
        ? ["-d", session.wslDistro, ...(session.cwd && session.cwd !== "~" ? ["--cd", session.cwd] : [])]
        : [];
    const hookUrl = getHookUrl();
    const configuredEnv = environmentService?.resolve(session) || {};
    let env = mergeEnvironment([process.env, configuredEnv, {
      PANNEL_HANDLE_SESSION_ID: session.id,
      ...(hookUrl ? { PANNEL_HANDLE_HOOK_URL: hookUrl } : {}),
      ...(options.runtimeEnv || {})
    }], session.type !== "wsl");

    if (session.agentProvider === "copilot") {
      const inheritedAttributes = String(process.env.OTEL_RESOURCE_ATTRIBUTES || "").trim();
      Object.assign(env, {
        COPILOT_OTEL_ENABLED: "true",
        COPILOT_OTEL_EXPORTER_TYPE: "file",
        COPILOT_OTEL_FILE_EXPORTER_PATH: getCopilotOtelPath(session),
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
        OTEL_RESOURCE_ATTRIBUTES: `${inheritedAttributes ? `${inheritedAttributes},` : ""}pannel_handle.panel_session_id=${session.id}`
      });
    }

    env = mergeEnvironment([env], session.type !== "wsl");

    if (session.type === "wsl") {
      env.WSLENV = appendWslEnv(String(env.WSLENV || "").split(":").filter(entry => !Object.hasOwn(configuredEnv, entry.split("/")[0])).join(":"), [
        ...Object.keys(configuredEnv),
        "PANNEL_HANDLE_SESSION_ID",
        "PANNEL_HANDLE_HOOK_URL",
        ...(Array.isArray(options.runtimeWslEnvKeys) ? options.runtimeWslEnvKeys : []),
        ...(session.agentProvider === "copilot" ? [
          "COPILOT_OTEL_ENABLED",
          "COPILOT_OTEL_EXPORTER_TYPE",
          "COPILOT_OTEL_FILE_EXPORTER_PATH",
          "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
          "OTEL_RESOURCE_ATTRIBUTES"
        ] : [])
      ]);
    }

    session.runtimeCwd = options.runtimeCwd || (session.type === "wsl" ? os.homedir() : session.cwd);
    const term = pty.spawn(options.runtimeShell || session.shell, args, {
      name: "xterm-256color",
      cols: options.cols || 100,
      rows: options.rows || 30,
      cwd: session.runtimeCwd,
      env
    });

    attachTerminal(session, term, options);
  }

  function startSessionFromTemplate(templateData, options = {}) {
    const storedTemplate = !options.useProvidedTemplate && templateData?.id
      ? sessionStore.getTemplate(templateData.id)
      : undefined;
    const template = sessionStore.normalizeTemplate(storedTemplate || templateData);
    environmentService?.resolve(template);
    if (template.type === "ssh") {
      validateSsh2Config(template.sshConfig);
    }
    const id = createRuntimeId();
    const templateId = Object.prototype.hasOwnProperty.call(options, "templateId")
      ? options.templateId
      : options.persist === false ? undefined : template.id;
    const session = {
      ...template,
      id,
      templateId,
      title: getRuntimeTitle(template, Boolean(templateId)),
      agentRuntimeProvider: template.agentProvider,
      runtimeMode: options.runtimeMode || "terminal",
      ...(template.type === "ssh" ? { sshConnectionState: "connecting", sshReconnectAttempt: 0 } : {}),
      createdAt: Date.now()
    };

    sessions.set(id, session);
    sessionOrder.push(id);
    try {
      if (!options.deferTerminalStart) {
        spawnPty(session, options);
      }
    } catch (err) {
      sessions.delete(id);
      const orderIndex = sessionOrder.indexOf(id);
      if (orderIndex >= 0) {
        sessionOrder.splice(orderIndex, 1);
      }
      throw err;
    }
    return serializeSession(session);
  }

  function startDeferredSession(id, options = {}) {
    const session = sessions.get(id);
    if (!session) throw new Error("Session is not running.");
    if (session.term) throw new Error("Session terminal has already started.");
    try {
      spawnPty(session, options);
    } catch (err) {
      sessions.delete(id);
      const orderIndex = sessionOrder.indexOf(id);
      if (orderIndex >= 0) sessionOrder.splice(orderIndex, 1);
      throw err;
    }
    broadcast("sessions:changed", listSessions());
    return serializeSession(session);
  }

  function createSession(options = {}) {
    const persist = options.persist !== false;
    const id = sessionStore.createTemplateId();
    const type = options.type || "windows";
    const shell = options.shell || (type === "wsl" ? getWslShell() : type === "ssh" ? getSshShell() : resolveDefaultShell(options.windowsShell));
    const cwd = options.cwd || (type === "wsl" || type === "ssh" ? "~" : os.homedir());
    const sshConfig = options.sshConfig;
    if (type === "ssh") {
      validateSsh2Config(sshConfig);
    }
    if (!options.title && sshConfig?.host) {
      options.title = `${sshConfig.username ? `${sshConfig.username}@` : ""}${sshConfig.host}`;
    }
    const title = options.title || `会话 ${id}`;

    const template = {
      id,
      title,
      shell,
      cwd,
      fileSort: options.fileSort,
      preferredDiskMountPoint: options.preferredDiskMountPoint,
      type,
      wslDistro: options.wslDistro,
      sshConfig,
      createdAt: Date.now(),
      initialCommand: options.initialCommand,
      agentProvider: options.agentProvider,
      agentLocation: options.agentLocation,
      localAgentCwd: options.localAgentCwd,
      codexBackend: options.codexBackend,
      codexModel: options.codexModel,
      codexExperimentalAcknowledged: options.codexExperimentalAcknowledged,
      codexAppServerEnabled: options.codexAppServerEnabled,
      codeBuddyAcpEnabled: options.codeBuddyAcpEnabled,
      quickCommands: options.quickCommands || [],
      environmentProfileId: options.environmentProfileId,
      environmentOverrides: options.environmentOverrides,
      tags: options.tags || []
    };

    const session = startSessionFromTemplate(template, { ...options, persist });
    if (persist) {
      sessionStore.addToLibrary(template);
    }
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();

    return session;
  }

  function launchSessions(sessionsToLaunch) {
    for (const sessionData of sessionsToLaunch) {
      startSessionFromTemplate(sessionData);
    }

    const allSessions = listSessions();
    console.log("[main] launchSessions result:", allSessions.map(s => ({ id: s.id, templateId: s.templateId })));
    broadcast("sessions:changed", allSessions);
    syncLastActiveIds();
    return allSessions;
  }

  function launchSession(sessionData, options = {}) {
    const session = startSessionFromTemplate(sessionData, options);
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();
    return session;
  }

  function deleteSavedSession(id) {
    sessionStore.removeFromLibrary(id);
    return listSessions();
  }

  function duplicateSavedSession(id) {
    return sessionStore.duplicateInLibrary(id);
  }

  function renameSession(id, title) {
    const session = sessions.get(id);
    if (!session) {
      return listSessions();
    }
    session.title = title.trim() || session.title;
    if (session.templateId) {
      sessionStore.updateLibrary(session.templateId, { title: session.title });
    }
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();
    return listSessions();
  }

  function updateSession(id, { title, cwd, fileSort, preferredDiskMountPoint, initialCommand, agentProvider, agentLocation, localAgentCwd, codexBackend, codexModel, codexExperimentalAcknowledged, codexAppServerEnabled, codeBuddyAcpEnabled, sshConfig, quickCommands, tags, environmentProfileId, environmentOverrides }) {
    const session = sessions.get(id);
    if (!session) {
      environmentService?.resolve({ ...sessionStore.getTemplate(id),
        ...(agentProvider !== undefined ? { agentProvider } : {}),
        ...(agentLocation !== undefined ? { agentLocation } : {}),
        ...(environmentProfileId !== undefined ? { environmentProfileId } : {}),
        ...(environmentOverrides !== undefined ? { environmentOverrides } : {})
      });
      sessionStore.updateLibrary(id, { title, cwd, fileSort, preferredDiskMountPoint, initialCommand, agentProvider, agentLocation, localAgentCwd, codexBackend, codexModel, codexExperimentalAcknowledged, codexAppServerEnabled, codeBuddyAcpEnabled, sshConfig, quickCommands, tags, environmentProfileId, environmentOverrides });
      if (typeof tags !== "undefined") {
        const normalizedTags = sessionStore.getTemplate(id)?.tags || [];
        for (const runningSession of sessions.values()) {
          if (runningSession.templateId === id) {
            runningSession.tags = normalizedTags;
          }
        }
        broadcast("sessions:changed", listSessions());
      }
      return listSessions();
    }
    const templateId = session.templateId;
    const template = templateId ? sessionStore.getTemplate(templateId) : undefined;
    const previousTitle = session.title;
    const previousCodexBackend = session.codexBackend;
    const previousCodexModel = session.codexModel;
    const libraryUpdates = {};
    if (environmentProfileId !== undefined || environmentOverrides !== undefined || agentProvider !== undefined || agentLocation !== undefined) {
      const next = sessionStore.normalizeTemplate({ ...session,
        ...(agentProvider !== undefined ? { agentProvider } : {}),
        ...(agentLocation !== undefined ? { agentLocation } : {}),
        ...(environmentProfileId !== undefined ? { environmentProfileId } : {}),
        ...(environmentOverrides !== undefined ? { environmentOverrides } : {})
      });
      environmentService?.resolve(next);
      if (environmentProfileId !== undefined || environmentOverrides !== undefined) {
        session.environmentProfileId = next.environmentProfileId;
        session.environmentOverrides = next.environmentOverrides;
        libraryUpdates.environmentProfileId = next.environmentProfileId || null;
        libraryUpdates.environmentOverrides = next.environmentOverrides || [];
      }
    }
    if (typeof title === "string") {
      session.title = title.trim() || session.title;
      if (session.title !== previousTitle || previousTitle === template?.title) {
        libraryUpdates.title = session.title;
      }
    }
    if (typeof initialCommand !== "undefined") {
      session.initialCommand = initialCommand;
      libraryUpdates.initialCommand = session.initialCommand;
    }
    if (typeof agentProvider !== "undefined") {
      session.agentProvider = agentProvider || undefined;
      if (agentProvider) {
        session.agentRuntimeProvider = agentProvider;
      }
      libraryUpdates.agentProvider = agentProvider || null;
    }
    if (typeof agentLocation !== "undefined") {
      session.agentLocation = agentLocation || undefined;
      libraryUpdates.agentLocation = agentLocation || null;
    }
    if (typeof localAgentCwd !== "undefined") {
      session.localAgentCwd = localAgentCwd || undefined;
      libraryUpdates.localAgentCwd = localAgentCwd || null;
    }
    if (typeof codexBackend !== "undefined") {
      session.codexBackend = codexBackend === "openrouter" || codexBackend === "nararouter" || codexBackend === "minimax" || codexBackend === "codebuddy" ? codexBackend : session.agentProvider === "codex" ? "openai" : undefined;
      libraryUpdates.codexBackend = session.codexBackend || null;
    }
    if (typeof codexAppServerEnabled === "boolean" || agentProvider === null) {
      session.codexAppServerEnabled = session.agentProvider === "codex" ? codexAppServerEnabled !== false : undefined;
      if (session.agentProvider === "codex") libraryUpdates.codexAppServerEnabled = session.codexAppServerEnabled;
    }
    if (typeof codeBuddyAcpEnabled === "boolean" || agentProvider === null) {
      session.codeBuddyAcpEnabled = session.agentProvider === "codebuddy" ? codeBuddyAcpEnabled === true : undefined;
      if (session.agentProvider === "codebuddy") libraryUpdates.codeBuddyAcpEnabled = session.codeBuddyAcpEnabled;
    }
    if (typeof codexModel !== "undefined") {
      session.codexModel = session.codexBackend === "openrouter" || session.codexBackend === "nararouter" || session.codexBackend === "minimax" || session.codexBackend === "codebuddy" ? String(codexModel || "").trim() || undefined : undefined;
      libraryUpdates.codexModel = session.codexModel || null;
    }
    const codexSelectionChanged = previousCodexBackend !== session.codexBackend || previousCodexModel !== session.codexModel;
    if (typeof codexExperimentalAcknowledged !== "undefined" || codexSelectionChanged) {
      session.codexExperimentalAcknowledged = (session.codexBackend === "openrouter" || session.codexBackend === "nararouter" || session.codexBackend === "minimax" || session.codexBackend === "codebuddy") && Boolean(session.codexModel) && codexExperimentalAcknowledged === true
        ? true
        : undefined;
      libraryUpdates.codexExperimentalAcknowledged = session.codexExperimentalAcknowledged || null;
    }
    if (typeof cwd === "string" && cwd.trim()) {
      session.cwd = cwd.trim();
      libraryUpdates.cwd = session.cwd;
    }
    if (fileSort && ["name", "modifiedAt", "size"].includes(fileSort.key)) {
      session.fileSort = { key: fileSort.key, direction: fileSort.direction === "desc" ? "desc" : "asc" };
      libraryUpdates.fileSort = session.fileSort;
    }
    if (typeof preferredDiskMountPoint === "string" && session.type === "ssh") {
      const normalizedMountPoint = preferredDiskMountPoint.trim();
      if (normalizedMountPoint) {
        session.preferredDiskMountPoint = normalizedMountPoint;
        libraryUpdates.preferredDiskMountPoint = normalizedMountPoint;
        for (const [sid, runningSession] of sessions) {
          if (templateId && sid !== id && runningSession.templateId === templateId) {
            runningSession.preferredDiskMountPoint = normalizedMountPoint;
          }
        }
      }
    }
    if (typeof quickCommands !== "undefined") {
      session.quickCommands = quickCommands;
      libraryUpdates.quickCommands = quickCommands;
      for (const [sid, s] of sessions) {
        if (templateId && sid !== id && s.templateId === templateId) {
          s.quickCommands = quickCommands;
        }
      }
    }
    if (typeof tags !== "undefined") {
      const normalizedTags = sessionStore.normalizeTemplate({
        ...(template || session),
        tags
      }).tags;
      session.tags = normalizedTags;
      libraryUpdates.tags = normalizedTags;
      for (const [sid, s] of sessions) {
        if (templateId && sid !== id && s.templateId === templateId) {
          s.tags = normalizedTags;
        }
      }
    }
    if (typeof sshConfig !== "undefined" && session.type === "ssh") {
      const previousSshConfig = session.sshConfig || {};
      session.sshConfig = {
        ...(template?.sshConfig || {}),
        ...previousSshConfig,
        ...sshConfig
      };
      libraryUpdates.sshConfig = session.sshConfig;
      const normalizedSshConfig = sessionStore.normalizeTemplate({
        ...(template || session),
        type: "ssh",
        sshConfig: session.sshConfig
      }).sshConfig;
      session.sshConfig = normalizedSshConfig;
      session.sshSecret = getSshSecret(session);
    }
    if (templateId) {
      sessionStore.updateLibrary(templateId, libraryUpdates);
    }
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();
    return listSessions();
  }

  function closeSession(id) {
    const session = sessions.get(id);
    if (session) {
      session.closing = true;
      clearSshReconnectTimer(session);
      if (typeof session.term?.kill === "function") {
        session.term.kill();
      }
      removeRuntimeSession(session);
    }
    return listSessions();
  }

  function reconnectSession(id) {
    const session = sessions.get(id);
    if (!session || session.type !== "ssh") throw new Error("SSH session is not running.");
    clearSshReconnectTimer(session);
    session.terminalGeneration = (session.terminalGeneration || 0) + 1;
    if (typeof session.term?.kill === "function") session.term.kill();
    session.term = undefined;
    session.closing = false;
    session.sshReconnectAttempt = 0;
    appendTerminalData(session, "\r\n[Retrying SSH connection now...]\r\n");
    try {
      spawnSsh2(session, { cols: session.cols, rows: session.rows, reconnecting: true });
    } catch (err) {
      setSshConnectionState(session, "disconnected", 0);
      throw err;
    }
    broadcast("sessions:changed", listSessions());
    return serializeSession(session);
  }

  function getHistory(id) {
    const session = sessions.get(id);
    return session ? session.buffer.join("") : "";
  }

  function trackCodexTerminalCommand(session, data) {
    const isCodex = session.agentRuntimeProvider === "codex" || session.agentProvider === "codex";
    const isQoder = session.agentRuntimeProvider === "qoder" || session.agentProvider === "qoder";
    const isGemini = session.agentRuntimeProvider === "gemini" || session.agentProvider === "gemini";
    if (!isCodex && !isQoder && !isGemini) {
      session.agentCommandState = undefined;
      return;
    }

    const result = consumeAgentCommandInput(session.agentCommandState, data);
    session.agentCommandState = result.state;
    const provider = isCodex ? "codex" : isQoder ? "qoder" : "gemini";
    for (let index = 0; index < result.clearSubmissions; index += 1) {
      session.agentStatus = "cleared";
      broadcastAgentStatus({
        id: session.id,
        provider,
        status: "cleared",
        eventName: "TerminalCommand"
      });
    }
  }

  function write(id, data) {
    const session = sessions.get(id);
    if (session?.type === "ssh" && (session.sshConnectionState === "reconnecting" || session.sshConnectionState === "disconnected")) {
      return;
    }
    if (typeof session?.term?.write === "function") {
      trackCodexTerminalCommand(session, data);
      session.term.write(data);
    }
  }

  function resize(id, cols, rows) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      return;
    }
    const session = sessions.get(id);
    if (typeof session?.term?.resize === "function") {
      session.term.resize(cols, rows);
      session.cols = Math.floor(cols);
      session.rows = Math.floor(rows);
      broadcast("terminal:resized", { id, cols: session.cols, rows: session.rows });
    }
  }

  function getSession(id) {
    return sessions.get(id);
  }

  function getSessions() {
    return Array.from(sessions.values());
  }

  function reorderRunningSessions(orderedIds) {
    const idSet = new Set(orderedIds);
    for (const id of sessionOrder) {
      if (!idSet.has(id)) idSet.add(id);
    }
    sessionOrder.length = 0;
    sessionOrder.push(...orderedIds);
    for (const id of idSet) {
      if (!sessionOrder.includes(id)) sessionOrder.push(id);
    }
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();
    return listSessions();
  }

  function shutdown() {
    for (const session of sessions.values()) {
      session.closing = true;
      clearSshReconnectTimer(session);
      if (typeof session.term?.kill === "function") {
        session.term.kill();
      }
    }
    sessions.clear();
    sessionOrder.length = 0;
  }

  return {
    createSession,
    startDeferredSession,
    launchSession,
    launchSessions,
    deleteSavedSession,
    duplicateSavedSession,
    reorderRunningSessions,
    renameSession,
    updateSession,
    closeSession,
    reconnectSession,
    setAppServerConnectionState,
    listSessions,
    getHistory,
    write,
    resize,
    getSession,
    getSessions,
    broadcastAgentStatus,
    broadcastAgentHookDebug,
    shutdown,
    listWslDistros
  };
}

module.exports = {
  AGENT_EXIT_MARKER,
  createTerminalManager,
  getDefaultShell,
  resolveRunnableExecutable,
  getWslShell,
  getSshShell,
  buildSshArgs
};
