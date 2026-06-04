const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function createWindowManager() {
  let mainWindow = null;

  function broadcast(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
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

    return mainWindow;
  }

  function getWindowFromEvent(event) {
    return BrowserWindow.fromWebContents(event.sender);
  }

  function closeWindowManager() {
    mainWindow = null;
  }

  return {
    createWindow,
    broadcast,
    getWindowFromEvent,
    closeWindowManager
  };
}

module.exports = {
  createWindowManager
};
