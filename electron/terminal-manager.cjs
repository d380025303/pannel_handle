const os = require("node:os");
const { execSync } = require("node:child_process");
const nodePty = require("node-pty");

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
  return process.platform === "win32" ? "ssh.exe" : "ssh";
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
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
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

function sanitizeSshConfig(sshConfig) {
  if (!sshConfig) {
    return undefined;
  }
  const { secret, encryptedSecret, clearSecret, ...safeConfig } = sshConfig;
  return {
    ...safeConfig,
    hasSecret: Boolean(encryptedSecret)
  };
}

function createTerminalManager({ sessionStore, broadcast, getHookUrl, pty = nodePty }) {
  const sessions = new Map();
  const sessionOrder = [];
  let nextRuntimeId = 1;

  function broadcastAgentStatus(payload) {
    const { provider = "claude", ...rest } = payload;
    broadcast("agent:status", {
      provider,
      timestamp: Date.now(),
      ...rest
    });
  }

  function maybeBroadcastTerminalPermissionPrompt(session) {
    if (session.agentProvider !== "codex" || session.agentStatus === "waiting_for_permission") {
      return;
    }

    const recentOutput = stripAnsi(session.buffer.slice(-20).join(""));
    if (
      !recentOutput.includes("Would you like to run the following command?") &&
      !recentOutput.includes("Press enter to confirm or esc to cancel")
    ) {
      return;
    }

    session.agentStatus = "waiting_for_permission";
    broadcastAgentStatus({
      id: session.id,
      provider: "codex",
      status: "waiting_for_permission",
      eventName: "TerminalPermissionPrompt",
      message: "Codex is waiting for command approval"
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
      type: session.type,
      wslDistro: session.wslDistro,
      sshConfig: sanitizeSshConfig(session.sshConfig),
      quickCommands: session.quickCommands || []
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

  function isSshSecretPrompt(data) {
    const text = stripAnsi(data).replace(/\r/g, "\n");
    return /(?:^|\n).*password:\s*$/i.test(text) || /enter passphrase for key\b.*:\s*$/i.test(text);
  }

  function maybeWriteSshSecret(session, data) {
    if (session.type !== "ssh" || !session.sshSecret || session.sshSecretAttempts >= 2) {
      return;
    }
    if (!isSshSecretPrompt(data)) {
      return;
    }
    session.sshSecretAttempts += 1;
    session.term.write(`${session.sshSecret}\r`);
  }

  function spawnPty(session, options = {}) {
    const args = session.type === "ssh"
      ? buildSshArgs(session.sshConfig)
      : session.type === "wsl" && session.wslDistro
        ? ["-d", session.wslDistro]
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
      cwd: session.cwd,
      env
    });

    session.term = term;
    session.buffer = [];
    session.sshSecret = getSshSecret(session);
    session.sshSecretAttempts = 0;

    term.onData((data) => {
      session.buffer.push(data);
      if (session.buffer.length > 1000) {
        session.buffer.splice(0, session.buffer.length - 1000);
      }
      maybeWriteSshSecret(session, data);
      maybeBroadcastTerminalPermissionPrompt(session);
      broadcast("terminal:data", { id: session.id, data });
    });

    term.onExit(({ exitCode }) => {
      if (!sessions.has(session.id)) return;
      broadcast("terminal:exit", { id: session.id, exitCode });
      broadcastAgentStatus({
        id: session.id,
        status: "exited",
        eventName: "PtyExit",
        message: `Exit code ${exitCode}`
      });
      sessions.delete(session.id);
      sessionOrder.splice(sessionOrder.indexOf(session.id), 1);
      broadcast("sessions:changed", listSessions());
    });

    const initialCommand = options.initialCommand || session.initialCommand;
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

  function startSessionFromTemplate(templateData, options = {}) {
    const storedTemplate = templateData?.id ? sessionStore.getTemplate(templateData.id) : undefined;
    const template = sessionStore.normalizeTemplate(storedTemplate || templateData);
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
    spawnPty(session, options);
    return serializeSession(session);
  }

  function createSession(options = {}) {
    const id = sessionStore.createTemplateId();
    const type = options.type || "windows";
    const shell = options.shell || (type === "wsl" ? getWslShell() : type === "ssh" ? getSshShell() : getDefaultShell());
    const cwd = options.cwd || os.homedir();
    const sshConfig = options.sshConfig;
    if (type === "ssh") {
      buildSshArgs(sshConfig);
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
      quickCommands: options.quickCommands || []
    };

    sessionStore.addToLibrary(template);
    const session = startSessionFromTemplate(template, options);
    broadcast("sessions:changed", listSessions());

    return session;
  }

  function launchSessions(sessionsToLaunch) {
    for (const sessionData of sessionsToLaunch) {
      startSessionFromTemplate(sessionData);
    }

    const allSessions = listSessions();
    console.log("[main] launchSessions result:", allSessions.map(s => ({ id: s.id, templateId: s.templateId })));
    broadcast("sessions:changed", allSessions);
    return allSessions;
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
    return listSessions();
  }

  function updateSession(id, { title, initialCommand, sshConfig, quickCommands }) {
    const session = sessions.get(id);
    if (!session) {
      sessionStore.updateLibrary(id, { title, initialCommand, sshConfig, quickCommands });
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
      session.initialCommand = initialCommand || undefined;
      libraryUpdates.initialCommand = session.initialCommand;
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
    if (typeof sshConfig !== "undefined" && session.type === "ssh") {
      session.sshConfig = {
        ...(session.sshConfig || {}),
        ...sshConfig
      };
      libraryUpdates.sshConfig = session.sshConfig;
      session.sshConfig = sanitizeSshConfig(session.sshConfig);
    }
    sessionStore.updateLibrary(templateId, libraryUpdates);
    broadcast("sessions:changed", listSessions());
    return listSessions();
  }

  function closeSession(id) {
    const session = sessions.get(id);
    if (session) {
      session.term.kill();
      sessions.delete(id);
      sessionOrder.splice(sessionOrder.indexOf(id), 1);
      broadcast("sessions:changed", listSessions());
    }
    return listSessions();
  }

  function getHistory(id) {
    const session = sessions.get(id);
    return session ? session.buffer.join("") : "";
  }

  function write(id, data) {
    const session = sessions.get(id);
    if (session) {
      session.term.write(data);
    }
  }

  function resize(id, cols, rows) {
    const session = sessions.get(id);
    if (session) {
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
    return listSessions();
  }

  function shutdown() {
    for (const session of sessions.values()) {
      session.term.kill();
    }
    sessions.clear();
    sessionOrder.length = 0;
  }

  return {
    createSession,
    launchSessions,
    deleteSavedSession,
    reorderSavedSessions,
    reorderRunningSessions,
    renameSession,
    updateSession,
    closeSession,
    listSessions,
    getHistory,
    write,
    resize,
    getSession,
    getSessions,
    broadcastAgentStatus,
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
