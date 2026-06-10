const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function createWindowManager() {
  let mainWindow = null;

  function hasWindow() {
    return mainWindow && !mainWindow.isDestroyed();
  }

  function broadcast(channel, payload) {
    if (hasWindow()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  function createWindow() {
    if (hasWindow()) {
      focusWindow();
      return mainWindow;
    }

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 820,
      minHeight: 520,
      frame: false,
      show: false,
      icon: path.join(__dirname, "..", "build", "icon.png"),
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

    return mainWindow;
  }

  function focusWindow() {
    if (!hasWindow()) {
      return null;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    return mainWindow;
  }

  function isMainWindowFocused() {
    return Boolean(hasWindow() && !mainWindow.isMinimized() && mainWindow.isFocused());
  }

  function focusAndSelectSession(sessionId) {
    const window = focusWindow();
    if (window) {
      broadcast("sessions:select-requested", { id: sessionId });
    }
    return window;
  }

  function getWindowFromEvent(event) {
    return BrowserWindow.fromWebContents(event.sender);
  }

  function closeWindowManager() {
    mainWindow = null;
  }

  return {
    createWindow,
    focusWindow,
    isMainWindowFocused,
    focusAndSelectSession,
    broadcast,
    getWindowFromEvent,
    closeWindowManager
  };
}

module.exports = {
  createWindowManager
};
