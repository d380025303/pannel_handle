const os = require("node:os");
const { execSync } = require("node:child_process");
const nodePty = require("node-pty");
const { sanitizeSshConfig } = require("./ssh-config-utils.cjs");
const { buildSsh2ConnectionConfig, validateSsh2Config } = require("./ssh2-connection.cjs");
const { createSsh2Terminal } = require("./ssh2-terminal.cjs");

function getDefaultShell() {
  if (process.platform !== "win32") {
    return process.env.SHELL || "bash";
  }

  return process.env.ComSpec || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
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
  sessionStore,
  configStore,
  broadcast,
  getHookUrl,
  onSessionClosed,
  onAgentStatusChanged,
  knownHostStore,
  pty = nodePty,
  ssh2TerminalFactory = createSsh2Terminal
}) {
  const sessions = new Map();
  const sessionOrder = [];
  let nextRuntimeId = 1;

  function syncLastActiveIds() {
    if (!configStore) return;
    const templateIds = Array.from(sessions.values())
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
      id: session.id,
      templateId: session.templateId,
      title: session.title,
      shell: session.shell,
      cwd: session.cwd,
      createdAt: session.createdAt,
      initialCommand: session.initialCommand,
      agentProvider: session.agentProvider,
      type: session.type,
      wslDistro: session.wslDistro,
      sshConfig: sanitizeSshConfig(session.sshConfig),
      quickCommands: session.quickCommands || [],
      tags: session.tags || [],
      gitCwd: session.gitCwd,
      gitCwdHistory: session.gitCwdHistory || []
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

  function getRuntimeTitle(template) {
    const usedTitles = new Set(
      Array.from(sessions.values())
        .filter(session => session.templateId === template.id)
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
    if (session.type !== "ssh" || !session.sshSecret || session.sshSecretAttempts >= 2) {
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
    session.buffer = [];
    session.sshSecret = session.type === "ssh" ? getSshSecret(session) : undefined;
    session.sshSecretAttempts = 0;
    session.lastSshSecretPromptSignature = undefined;

    term.onData((data) => {
      session.buffer.push(data);
      if (session.buffer.length > 1000) {
        session.buffer.splice(0, session.buffer.length - 1000);
      }
      maybeAutofillTerminalSecretPrompt(session);
      maybeDetectCodexPermissionPrompt(session);
      broadcast("terminal:data", { id: session.id, data });
    });

    term.onExit(({ exitCode }) => {
      if (!sessions.has(session.id)) return;
      broadcast("terminal:exit", { id: session.id, exitCode });
      broadcastAgentStatus({
        id: session.id,
        status: "exited",
        eventName: session.type === "ssh" ? "SshExit" : "PtyExit",
        message: `Exit code ${exitCode}`
      });
      sessions.delete(session.id);
      sessionOrder.splice(sessionOrder.indexOf(session.id), 1);
      if (typeof onSessionClosed === "function") {
        onSessionClosed(session.id);
      }
      broadcast("sessions:changed", listSessions());
    });

    const initialCommand = getInitialCommand(session, options);
    if (initialCommand) {
      const cmd = String(initialCommand).trim();
      if (cmd) {
        const disposable = term.onData(() => {
          disposable.dispose();
          const activeSession = sessions.get(session.id);
          if (activeSession) activeSession.term.write(cmd + "\r");
        });
      }
    }
  }

  function spawnSsh2(session, options = {}) {
    validateSsh2Config(session.sshConfig);
    const term = ssh2TerminalFactory({
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
    if (session.type === "ssh") {
      spawnSsh2(session, options);
      return;
    }

    const args = session.type === "wsl" && session.wslDistro
        ? ["-d", session.wslDistro, ...(session.cwd && session.cwd !== "~" ? ["--cd", session.cwd] : [])]
        : [];
    const hookUrl = getHookUrl();
    const env = {
      ...process.env,
      PANNEL_HANDLE_SESSION_ID: session.id,
      ...(hookUrl ? { PANNEL_HANDLE_HOOK_URL: hookUrl } : {})
    };

    if (session.type === "wsl") {
      env.WSLENV = appendWslEnv(env.WSLENV, [
        "PANNEL_HANDLE_SESSION_ID",
        "PANNEL_HANDLE_HOOK_URL"
      ]);
    }

    const term = pty.spawn(session.shell, args, {
      name: "xterm-256color",
      cols: options.cols || 100,
      rows: options.rows || 30,
      cwd: session.type === "wsl" ? os.homedir() : session.cwd,
      env
    });

    attachTerminal(session, term, options);
  }

  function startSessionFromTemplate(templateData, options = {}) {
    const storedTemplate = templateData?.id ? sessionStore.getTemplate(templateData.id) : undefined;
    const template = sessionStore.normalizeTemplate(storedTemplate || templateData);
    if (template.type === "ssh") {
      validateSsh2Config(template.sshConfig);
    }
    const id = createRuntimeId();
    const session = {
      ...template,
      id,
      templateId: template.id,
      title: getRuntimeTitle(template),
      createdAt: Date.now()
    };

    sessions.set(id, session);
    sessionOrder.push(id);
    try {
      spawnPty(session, options);
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

  function createSession(options = {}) {
    const id = sessionStore.createTemplateId();
    const type = options.type || "windows";
    const shell = options.shell || (type === "wsl" ? getWslShell() : type === "ssh" ? getSshShell() : getDefaultShell());
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
      type,
      wslDistro: options.wslDistro,
      sshConfig,
      createdAt: Date.now(),
      initialCommand: options.initialCommand,
      agentProvider: options.agentProvider,
      quickCommands: options.quickCommands || [],
      tags: options.tags || []
    };

    const session = startSessionFromTemplate(template, options);
    sessionStore.addToLibrary(template);
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

  function reorderSavedSessions(orderedIds) {
    sessionStore.reorderLibrary(orderedIds);
    return listSessions();
  }

  function renameSession(id, title) {
    const session = sessions.get(id);
    if (!session) {
      return listSessions();
    }
    session.title = title.trim() || session.title;
    sessionStore.updateLibrary(session.templateId || id, { title: session.title });
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();
    return listSessions();
  }

  function updateSession(id, { title, cwd, initialCommand, agentProvider, sshConfig, quickCommands, tags }) {
    const session = sessions.get(id);
    if (!session) {
      sessionStore.updateLibrary(id, { title, cwd, initialCommand, agentProvider, sshConfig, quickCommands, tags });
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
    const templateId = session.templateId || id;
    const template = sessionStore.getTemplate(templateId);
    const previousTitle = session.title;
    const libraryUpdates = {};
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
      libraryUpdates.agentProvider = agentProvider || null;
    }
    if (typeof cwd === "string" && cwd.trim()) {
      session.cwd = cwd.trim();
      libraryUpdates.cwd = session.cwd;
    }
    if (typeof quickCommands !== "undefined") {
      session.quickCommands = quickCommands;
      libraryUpdates.quickCommands = quickCommands;
      for (const [sid, s] of sessions) {
        if (sid !== id && s.templateId === templateId) {
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
        if (sid !== id && s.templateId === templateId) {
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
    sessionStore.updateLibrary(templateId, libraryUpdates);
    broadcast("sessions:changed", listSessions());
    syncLastActiveIds();
    return listSessions();
  }

  function updateGitDirectory(id, gitCwd) {
    const session = sessions.get(id);
    if (!session) {
      throw new Error("Session is not running.");
    }
    const normalizedCwd = String(gitCwd || "").trim();
    if (!normalizedCwd) {
      throw new Error("A valid Git working directory is required.");
    }
    const templateId = session.templateId || id;
    const previousHistory = Array.isArray(session.gitCwdHistory) ? session.gitCwdHistory : [];
    const keyFor = value => session.type === "windows" ? value.toLowerCase() : value;
    const seen = new Set();
    const gitCwdHistory = [normalizedCwd, ...previousHistory]
      .filter(value => typeof value === "string" && value.trim())
      .map(value => value.trim())
      .filter(value => {
        const key = keyFor(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);

    for (const runningSession of sessions.values()) {
      if ((runningSession.templateId || runningSession.id) === templateId) {
        runningSession.gitCwd = normalizedCwd;
        runningSession.gitCwdHistory = gitCwdHistory;
      }
    }
    sessionStore.updateLibrary(templateId, { gitCwd: normalizedCwd, gitCwdHistory });
    broadcast("sessions:changed", listSessions());
    return serializeSession(session);
  }

  function closeSession(id) {
    const session = sessions.get(id);
    if (session) {
      if (typeof session.term?.kill === "function") {
        session.term.kill();
      }
      sessions.delete(id);
      const orderIndex = sessionOrder.indexOf(id);
      if (orderIndex >= 0) {
        sessionOrder.splice(orderIndex, 1);
      }
      if (typeof onSessionClosed === "function") {
        onSessionClosed(id);
      }
      broadcast("sessions:changed", listSessions());
      syncLastActiveIds();
    }
    return listSessions();
  }

  function getHistory(id) {
    const session = sessions.get(id);
    return session ? session.buffer.join("") : "";
  }

  function write(id, data) {
    const session = sessions.get(id);
    if (typeof session?.term?.write === "function") {
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
      if (typeof session.term?.kill === "function") {
        session.term.kill();
      }
    }
    sessions.clear();
    sessionOrder.length = 0;
  }

  return {
    createSession,
    launchSession,
    launchSessions,
    deleteSavedSession,
    reorderSavedSessions,
    reorderRunningSessions,
    renameSession,
    updateSession,
    updateGitDirectory,
    closeSession,
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
  createTerminalManager,
  getDefaultShell,
  getWslShell,
  getSshShell,
  buildSshArgs
};
