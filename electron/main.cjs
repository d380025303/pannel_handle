const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const http = require("node:http");
const { app, BrowserWindow, clipboard, ipcMain } = require("electron");
const { execSync } = require("node:child_process");
const pty = require("node-pty");

const sessions = new Map();
const claudeSessions = new Map();
let librarySessions = [];
let mainWindow = null;
let nextSessionId = 1;
let nextRuntimeId = 1;
let isShuttingDown = false;
let claudeHookServer = null;
let claudeHookUrl = "";
const SESSIONS_FILE = path.join(app.getPath("userData"), "sessions.json");

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
      .replace(/^﻿/, "")
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch (err) {
    console.error("Failed to list WSL distros:", err);
    return [];
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    frame: false,
    show: false,
    backgroundColor: "#101318",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.maximize();
  mainWindow.show();

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && (input.key === "F12" || (input.key === "I" && input.control && input.shift))) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on("maximize", () => {
    broadcast("window:maximized-changed", true);
  });

  mainWindow.on("unmaximize", () => {
    broadcast("window:maximized-changed", false);
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function getWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastAgentStatus(payload) {
  broadcast("agent:status", {
    provider: "claude",
    timestamp: Date.now(),
    ...payload
  });
}

function normalizeCwd(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  return path.resolve(value).toLowerCase();
}

function registerClaudeSession(claudeSessionId, sessionId) {
  if (typeof claudeSessionId === "string" && claudeSessionId.length > 0) {
    claudeSessions.set(claudeSessionId, sessionId);
  }
}

function findSessionForClaudeHook(input) {
  const panelSessionId = input.pannel_handle_session_id || input.panelSessionId;
  if (typeof panelSessionId === "string" && sessions.has(panelSessionId)) {
    registerClaudeSession(input.session_id || input.sessionId, panelSessionId);
    return sessions.get(panelSessionId);
  }

  const claudeSessionId = input.session_id || input.sessionId;
  if (typeof claudeSessionId === "string") {
    const mappedId = claudeSessions.get(claudeSessionId);
    if (mappedId && sessions.has(mappedId)) {
      return sessions.get(mappedId);
    }
  }

  const hookCwd = normalizeCwd(input.cwd);
  if (hookCwd) {
    const cwdMatches = Array.from(sessions.values()).filter(session => normalizeCwd(session.cwd) === hookCwd);
    if (cwdMatches.length === 1) {
      registerClaudeSession(claudeSessionId, cwdMatches[0].id);
      return cwdMatches[0];
    }
  }

  if (sessions.size === 1) {
    const [session] = sessions.values();
    registerClaudeSession(claudeSessionId, session.id);
    return session;
  }

  return null;
}

function mapClaudeHookStatus(input) {
  const eventName = input.hook_event_name || input.eventName || input.event_name;
  const notificationType = input.notification_type || input.notificationType;

  if (eventName === "PermissionRequest") {
    return "waiting_for_permission";
  }
  if (eventName === "Notification" && notificationType === "permission_prompt") {
    return "waiting_for_permission";
  }
  if (eventName === "Notification" && notificationType === "idle_prompt") {
    return "completed";
  }
  if (eventName === "Stop") {
    return "completed";
  }
  if (eventName === "StopFailure") {
    return "failed";
  }
  if (eventName === "SessionEnd") {
    return "ended";
  }
  return "running";
}

function readJsonRequest(req, callback) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      req.destroy();
    }
  });
  req.on("end", () => {
    try {
      callback(null, JSON.parse(body || "{}"));
    } catch (err) {
      callback(err);
    }
  });
}

function handleClaudeHook(input) {
  const session = findSessionForClaudeHook(input);
  if (!session) {
    return false;
  }

  const eventName = input.hook_event_name || input.eventName || input.event_name || "Unknown";
  const status = mapClaudeHookStatus(input);
  const toolName = input.tool_name || input.toolName;
  const message = input.message || input.title || input.notification_type || input.reason;
  registerClaudeSession(input.session_id || input.sessionId, session.id);
  session.agentStatus = status;

  broadcastAgentStatus({
    id: session.id,
    status,
    eventName,
    message,
    toolName,
    toolInput: input.tool_input || input.toolInput,
    lastAssistantMessage: input.last_assistant_message || input.lastAssistantMessage
  });
  return true;
}

function startClaudeHookServer() {
  if (claudeHookServer) {
    return;
  }

  claudeHookServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/claude-hook") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    readJsonRequest(req, (err, input) => {
      if (err) {
        res.writeHead(400);
        res.end("invalid json");
        return;
      }

      handleClaudeHook(input);
      res.writeHead(204);
      res.end();
    });
  });

  claudeHookServer.listen(0, "127.0.0.1", () => {
    const address = claudeHookServer.address();
    if (address && typeof address === "object") {
      claudeHookUrl = `http://127.0.0.1:${address.port}/claude-hook`;
    }
  });

  claudeHookServer.on("error", (err) => {
    console.error("Failed to run Claude hook server:", err);
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

function serializeTemplate(template) {
  return {
    id: template.id,
    title: template.title,
    shell: template.shell,
    cwd: template.cwd,
    createdAt: template.createdAt,
    initialCommand: template.initialCommand,
    type: template.type,
    wslDistro: template.wslDistro
  };
}

function listSessions() {
  return Array.from(sessions.values()).map(serializeSession);
}

function bumpTemplateIdCounter(id) {
  const idNum = parseInt(id, 10);
  if (!isNaN(idNum) && idNum >= nextSessionId) {
    nextSessionId = idNum + 1;
  }
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

function normalizeTemplate(template) {
  const type = template.type || (template.shell && template.shell.includes('wsl') ? 'wsl' : 'windows');
  return serializeTemplate({
    ...template,
    type,
    shell: template.shell || (type === 'wsl' ? getWslShell() : getDefaultShell()),
    cwd: template.cwd || os.homedir(),
    createdAt: template.createdAt || Date.now()
  });
}

function loadSessions() {
  try {
    const data = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error("Failed to load sessions:", err);
    return [];
  }
}

function loadLibrary() {
  librarySessions = loadSessions().map(normalizeTemplate);
  for (const session of librarySessions) {
    bumpTemplateIdCounter(session.id);
  }
}

function saveLibrary() {
  try {
    const data = JSON.stringify(librarySessions, null, 2);
    const tmpPath = SESSIONS_FILE + ".tmp";
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, SESSIONS_FILE);
  } catch (err) {
    console.error("Failed to save library:", err);
  }
}

function addToLibrary(sessionMeta) {
  const template = normalizeTemplate(sessionMeta);
  const idx = librarySessions.findIndex(s => s.id === template.id);
  if (idx >= 0) {
    librarySessions[idx] = template;
  } else {
    librarySessions.push(template);
  }
  saveLibrary();
}

function removeFromLibrary(id) {
  librarySessions = librarySessions.filter(s => s.id !== id);
  saveLibrary();
}

function updateLibrary(id, updates) {
  const idx = librarySessions.findIndex(s => s.id === id);
  if (idx >= 0) {
    const nextUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => typeof value !== "undefined")
    );
    librarySessions[idx] = normalizeTemplate({ ...librarySessions[idx], ...nextUpdates });
    saveLibrary();
  }
}

function spawnPty(session, options = {}) {
  const args = session.type === 'wsl' && session.wslDistro
    ? ['-d', session.wslDistro]
    : [];

  const term = pty.spawn(session.shell, args, {
    name: "xterm-256color",
    cols: options.cols || 100,
    rows: options.rows || 30,
    cwd: session.cwd,
    env: {
      ...process.env,
      PANNEL_HANDLE_SESSION_ID: session.id,
      ...(claudeHookUrl ? { PANNEL_HANDLE_HOOK_URL: claudeHookUrl } : {})
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
        const s = sessions.get(session.id);
        if (s) s.term.write(cmd + "\r");
      });
    }
  }
}

function startSessionFromTemplate(templateData, options = {}) {
  const template = normalizeTemplate(templateData);
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
  const id = String(nextSessionId++);
  const type = options.type || 'windows';
  const shell = options.shell || (type === 'wsl' ? getWslShell() : getDefaultShell());
  const cwd = options.cwd || os.homedir();
  const title = options.title || `会话 ${id}`;

  const template = { id, title, shell, cwd, type, wslDistro: options.wslDistro, createdAt: Date.now(), initialCommand: options.initialCommand };

  addToLibrary(template);
  const session = startSessionFromTemplate(template, options);
  broadcast("sessions:changed", listSessions());

  return session;
}

startClaudeHookServer();

ipcMain.handle("sessions:list", () => listSessions());

ipcMain.handle("sessions:load-saved", () => librarySessions);

ipcMain.handle("sessions:launch-selected", (_event, sessionsToLaunch) => {
  for (const sessionData of sessionsToLaunch) {
    startSessionFromTemplate(sessionData);
  }

  broadcast("sessions:changed", listSessions());
  return listSessions();
});

ipcMain.handle("sessions:delete-saved", (_event, id) => {
  removeFromLibrary(id);
  broadcast("sessions:changed", listSessions());
  return listSessions();
});

ipcMain.handle("wsl:list-distros", () => listWslDistros());

ipcMain.handle("sessions:create", (_event, options) => createSession(options));

ipcMain.handle("sessions:rename", (_event, { id, title }) => {
  const session = sessions.get(id);
  if (!session) {
    return listSessions();
  }
  session.title = title.trim() || session.title;
  updateLibrary(session.templateId || id, { title: session.title });
  broadcast("sessions:changed", listSessions());
  return listSessions();
});

ipcMain.handle("sessions:update", (_event, { id, title, initialCommand }) => {
  const session = sessions.get(id);
  if (!session) {
    updateLibrary(id, { title, initialCommand });
    return listSessions();
  }
  const templateId = session.templateId || id;
  const template = librarySessions.find(item => item.id === templateId);
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
  updateLibrary(templateId, libraryUpdates);
  broadcast("sessions:changed", listSessions());
  return listSessions();
});

ipcMain.handle("sessions:close", (_event, id) => {
  const session = sessions.get(id);
  if (session) {
    session.term.kill();
    sessions.delete(id);
    broadcast("sessions:changed", listSessions());
  }
  return listSessions();
});

ipcMain.handle("terminal:history", (_event, id) => {
  const session = sessions.get(id);
  return session ? session.buffer.join("") : "";
});

ipcMain.handle("clipboard:write-text", (_event, text) => {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }

  clipboard.writeText(text);
  return true;
});

ipcMain.on("terminal:write", (_event, { id, data }) => {
  const session = sessions.get(id);
  if (session) {
    session.term.write(data);
  }
});

ipcMain.on("terminal:resize", (_event, { id, cols, rows }) => {
  const session = sessions.get(id);
  if (session) {
    session.term.resize(cols, rows);
  }
});

ipcMain.handle("window:is-maximized", (event) => {
  const window = getWindowFromEvent(event);
  return window ? window.isMaximized() : false;
});

ipcMain.on("window:minimize", (event) => {
  const window = getWindowFromEvent(event);
  if (window) {
    window.minimize();
  }
});

ipcMain.on("window:toggle-maximize", (event) => {
  const window = getWindowFromEvent(event);
  if (!window) {
    return;
  }

  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
});

ipcMain.on("window:close", (event) => {
  const window = getWindowFromEvent(event);
  if (window) {
    window.close();
  }
});

app.whenReady().then(() => {
  loadLibrary();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  isShuttingDown = true;
  saveLibrary();
  for (const session of sessions.values()) {
    session.term.kill();
  }
  sessions.clear();
  if (claudeHookServer) {
    claudeHookServer.close();
    claudeHookServer = null;
    claudeHookUrl = "";
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
