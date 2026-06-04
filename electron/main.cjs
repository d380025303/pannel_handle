const path = require("node:path");
const os = require("node:os");
const { app, BrowserWindow, ipcMain } = require("electron");
const pty = require("node-pty");

const sessions = new Map();
let mainWindow = null;
let nextSessionId = 1;

function getDefaultShell() {
  if (process.platform !== "win32") {
    return process.env.SHELL || "bash";
  }

  return process.env.ComSpec || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: "#101318",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
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
    createdAt: session.createdAt
  };
}

function listSessions() {
  return Array.from(sessions.values()).map(serializeSession);
}

function createSession(options = {}) {
  const id = String(nextSessionId++);
  const shell = options.shell || getDefaultShell();
  const cwd = options.cwd || os.homedir();
  const title = options.title || `会话 ${id}`;
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: options.cols || 100,
    rows: options.rows || 30,
    cwd,
    env: process.env
  });

  const session = {
    id,
    title,
    shell,
    cwd,
    createdAt: Date.now(),
    term,
    buffer: []
  };

  term.onData((data) => {
    session.buffer.push(data);
    if (session.buffer.length > 1000) {
      session.buffer.splice(0, session.buffer.length - 1000);
    }
    broadcast("terminal:data", { id, data });
  });

  term.onExit(({ exitCode }) => {
    broadcast("terminal:exit", { id, exitCode });
    sessions.delete(id);
    broadcast("sessions:changed", listSessions());
  });

  sessions.set(id, session);
  broadcast("sessions:changed", listSessions());

  if (options.initialCommand) {
    const cmd = String(options.initialCommand).trim();
    if (cmd) {
      const disposable = term.onData(() => {
        disposable.dispose();
        const s = sessions.get(id);
        if (s) s.term.write(cmd + "\r");
      });
    }
  }

  return serializeSession(session);
}

ipcMain.handle("sessions:list", () => listSessions());

ipcMain.handle("sessions:create", (_event, options) => createSession(options));

ipcMain.handle("sessions:rename", (_event, { id, title }) => {
  const session = sessions.get(id);
  if (!session) {
    return listSessions();
  }
  session.title = title.trim() || session.title;
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

app.whenReady().then(() => {
  createWindow();
  createSession();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  for (const session of sessions.values()) {
    session.term.kill();
  }
  sessions.clear();

  if (process.platform !== "darwin") {
    app.quit();
  }
});
