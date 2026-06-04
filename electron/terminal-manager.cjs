const os = require("node:os");
const { execSync } = require("node:child_process");
const pty = require("node-pty");

function getDefaultShell() {
  if (process.platform !== "win32") {
    return process.env.SHELL || "bash";
  }

  return process.env.ComSpec || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
}

function getWslShell() {
  return "C:\\Windows\\System32\\wsl.exe";
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

function createTerminalManager({ sessionStore, broadcast, getHookUrl }) {
  const sessions = new Map();
  let nextRuntimeId = 1;

  function broadcastAgentStatus(payload) {
    broadcast("agent:status", {
      provider: "claude",
      timestamp: Date.now(),
      ...payload
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
      wslDistro: session.wslDistro
    };
  }

  function listSessions() {
    return Array.from(sessions.values()).map(serializeSession);
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

  function spawnPty(session, options = {}) {
    const args = session.type === "wsl" && session.wslDistro
      ? ["-d", session.wslDistro]
      : [];
    const hookUrl = getHookUrl();

    const term = pty.spawn(session.shell, args, {
      name: "xterm-256color",
      cols: options.cols || 100,
      rows: options.rows || 30,
      cwd: session.cwd,
      env: {
        ...process.env,
        PANNEL_HANDLE_SESSION_ID: session.id,
        ...(hookUrl ? { PANNEL_HANDLE_HOOK_URL: hookUrl } : {})
      }
    });

    session.term = term;
    session.buffer = [];

    term.onData((data) => {
      session.buffer.push(data);
      if (session.buffer.length > 1000) {
        session.buffer.splice(0, session.buffer.length - 1000);
      }
      broadcast("terminal:data", { id: session.id, data });
      if (session.agentStatus === "completed" || session.agentStatus === "failed" || session.agentStatus === "ended") {
        session.agentStatus = "running";
        broadcastAgentStatus({
          id: session.id,
          status: "running",
          eventName: "TerminalData"
        });
      }
    });

    term.onExit(({ exitCode }) => {
      broadcast("terminal:exit", { id: session.id, exitCode });
      broadcastAgentStatus({
        id: session.id,
        status: "exited",
        eventName: "PtyExit",
        message: `Exit code ${exitCode}`
      });
      sessions.delete(session.id);
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
    const template = sessionStore.normalizeTemplate(templateData);
    const id = createRuntimeId();
    const session = {
      ...template,
      id,
      templateId: template.id,
      title: getRuntimeTitle(template),
      createdAt: Date.now()
    };

    sessions.set(id, session);
    spawnPty(session, options);
    return serializeSession(session);
  }

  function createSession(options = {}) {
    const id = sessionStore.createTemplateId();
    const type = options.type || "windows";
    const shell = options.shell || (type === "wsl" ? getWslShell() : getDefaultShell());
    const cwd = options.cwd || os.homedir();
    const title = options.title || `会话 ${id}`;

    const template = {
      id,
      title,
      shell,
      cwd,
      type,
      wslDistro: options.wslDistro,
      createdAt: Date.now(),
      initialCommand: options.initialCommand
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

    broadcast("sessions:changed", listSessions());
    return listSessions();
  }

  function deleteSavedSession(id) {
    sessionStore.removeFromLibrary(id);
    broadcast("sessions:changed", listSessions());
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

  function updateSession(id, { title, initialCommand }) {
    const session = sessions.get(id);
    if (!session) {
      sessionStore.updateLibrary(id, { title, initialCommand });
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
    sessionStore.updateLibrary(templateId, libraryUpdates);
    broadcast("sessions:changed", listSessions());
    return listSessions();
  }

  function closeSession(id) {
    const session = sessions.get(id);
    if (session) {
      session.term.kill();
      sessions.delete(id);
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

  function shutdown() {
    for (const session of sessions.values()) {
      session.term.kill();
    }
    sessions.clear();
  }

  return {
    createSession,
    launchSessions,
    deleteSavedSession,
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
  getWslShell
};
