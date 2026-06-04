const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const { execSync } = require("node:child_process");
const pty = require("node-pty");

const sessions = new Map();
let mainWindow = null;
let nextSessionId = 1;
let isShuttingDown = false;
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
    backgroundColor: "#101318",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
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

function serializeSession(session) {
  return {
    id: session.id,
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

function saveSessions() {
  try {
    const data = JSON.stringify(listSessions(), null, 2);
    const tmpPath = SESSIONS_FILE + ".tmp";
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, SESSIONS_FILE);
  } catch (err) {
    console.error("Failed to save sessions:", err);
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
    env: process.env
  });

  session.term = term;
  session.buffer = [];

  term.onData((data) => {
    session.buffer.push(data);
    if (session.buffer.length > 1000) {
      session.buffer.splice(0, session.buffer.length - 1000);
    }
    broadcast("terminal:data", { id: session.id, data });
  });

  term.onExit(({ exitCode }) => {
    broadcast("terminal:exit", { id: session.id, exitCode });
    sessions.delete(session.id);
    if (!isShuttingDown) {
      saveSessions();
    }
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

function createSession(options = {}) {
  const id = String(nextSessionId++);
  const type = options.type || 'windows';
  const shell = options.shell || (type === 'wsl' ? getWslShell() : getDefaultShell());
  const cwd = options.cwd || os.homedir();
  const title = options.title || `会话 ${id}`;

  const session = { id, title, shell, cwd, type, wslDistro: options.wslDistro, createdAt: Date.now(), initialCommand: options.initialCommand };

  spawnPty(session, options);
  sessions.set(id, session);
  saveSessions();
  broadcast("sessions:changed", listSessions());

  return serializeSession(session);
}

function restoreSavedSessions() {
  const saved = loadSessions();
  if (saved.length === 0) {
    createSession();
    return;
  }

  for (const data of saved) {
    const idNum = parseInt(data.id, 10);
    if (!isNaN(idNum) && idNum >= nextSessionId) {
      nextSessionId = idNum + 1;
    }
    if (!data.type) {
      data.type = data.shell && data.shell.includes('wsl') ? 'wsl' : 'windows';
    }
    const session = { ...data };
    spawnPty(session);
    sessions.set(session.id, session);
  }

  broadcast("sessions:changed", listSessions());
}

ipcMain.handle("sessions:list", () => listSessions());

ipcMain.handle("wsl:list-distros", () => listWslDistros());

ipcMain.handle("sessions:create", (_event, options) => createSession(options));

ipcMain.handle("sessions:rename", (_event, { id, title }) => {
  const session = sessions.get(id);
  if (!session) {
    return listSessions();
  }
  session.title = title.trim() || session.title;
  saveSessions();
  broadcast("sessions:changed", listSessions());
  return listSessions();
});

ipcMain.handle("sessions:close", (_event, id) => {
  const session = sessions.get(id);
  if (session) {
    session.term.kill();
    sessions.delete(id);
    saveSessions();
    broadcast("sessions:changed", listSessions());
  }
  return listSessions();
});

ipcMain.handle("terminal:history", (_event, id) => {
  const session = sessions.get(id);
  return session ? session.buffer.join("") : "";
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
  createWindow();
  restoreSavedSessions();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (sessions.size === 0) {
        restoreSavedSessions();
      }
    }
  });
});

app.on("window-all-closed", () => {
  isShuttingDown = true;
  saveSessions();
  for (const session of sessions.values()) {
    session.term.kill();
  }
  sessions.clear();

  if (process.platform !== "darwin") {
    app.quit();
  }
});
