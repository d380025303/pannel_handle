const fs = require("node:fs");
const path = require("node:path");
const { createMascotNotifications } = require("./mascot-notifications.cjs");

function clampPosition(position, area, size) {
  return {
    x: Math.round(Math.max(area.x, Math.min(position.x, area.x + Math.max(0, area.width - size.width)))),
    y: Math.round(Math.max(area.y, Math.min(position.y, area.y + Math.max(0, area.height - size.height))))
  };
}

function createDesktopMascot({ app, BrowserWindow, screen, ipcMain, terminalManager, graphicalService, conversationManager, stateHub, openExternal, getLocale = () => "zh-CN", random = Math.random }) {
  const file = path.join(app.getPath("userData"), "desktop-mascot.json");
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  const state = { collapsed: saved.collapsed === true, animated: saved.animated !== false, moving: saved.moving !== false, migrated: saved.migrated === true, locale: getLocale() };
  let win, timer, poll, journey, drag;
  let interaction = false, reduced = false, regions = [];
  let roaming = false;
  let roamingDirection = "left";
  let showingNotification = false, showingRequest = false;
  const notifications = createMascotNotifications({ terminalManager, graphicalService, conversationManager, stateHub, openExternal,
    onChanged: snapshot => {
      const showing = Boolean(snapshot.notification);
      const dimensionsChanged = Boolean(snapshot.notification?.action) !== showingRequest;
      if (showing !== showingNotification || dimensionsChanged) {
        showingNotification = showing; showingRequest = Boolean(snapshot.notification?.action); regions = []; correct(true);
      }
      if (alive()) win.webContents.send("desktop-mascot:notifications", snapshot);
    }
  });
  const characterSize = () => state.collapsed ? { width: 52, height: 52 } : { width: 192, height: 232 };
  const bubbleHeight = () => notifications.snapshot().notification?.action ? 388 : 188;
  const size = () => showingNotification ? { width: 320, height: characterSize().height + bubbleHeight() } : characterSize();
  const alive = () => win && !win.isDestroyed();
  const publish = () => { if (alive()) win.webContents.send("desktop-mascot:state", { ...state, roaming, roamingDirection, notifications: notifications.snapshot() }); };
  function persist() {
    if (!alive()) return;
    const bounds = win.getBounds();
    const x = bounds.x + (bounds.width - characterSize().width) / 2;
    const y = bounds.y + bounds.height - characterSize().height;
    saved = { ...state, x, y };
    try { fs.writeFileSync(file, JSON.stringify(saved)); } catch (error) { console.error("Failed to save desktop mascot:", error); }
  }
  function setRoaming(value) {
    if (roaming === value) return;
    roaming = value; publish();
  }
  function stop() {
    clearTimeout(timer);
    timer = undefined;
    if (journey) persist();
    journey = undefined;
    setRoaming(false);
  }
  function eligible() { return alive() && state.moving && !state.collapsed && !showingNotification && !interaction && !reduced && !drag; }
  function schedule() {
    stop();
    if (!eligible()) return;
    timer = setTimeout(() => {
      if (!eligible()) return;
      const start = win.getBounds();
      const area = screen.getDisplayMatching(start).workArea;
      const dimensions = size();
      const target = clampPosition({ x: area.x + random() * Math.max(0, area.width - dimensions.width), y: area.y + random() * Math.max(0, area.height - dimensions.height) }, area, dimensions);
      if (target.x === start.x && target.y === start.y) { schedule(); return; }
      journey = { start, target, time: Date.now(), duration: Math.max(1, Math.hypot(target.x - start.x, target.y - start.y) / 60 * 1000) };
      if (target.x !== start.x) roamingDirection = target.x < start.x ? "left" : "right";
      setRoaming(true);
    }, 8000 + random() * 7000);
  }
  function correct(preserveAnchor = false) {
    if (!alive()) return;
    stop();
    drag = undefined;
    const bounds = win.getBounds();
    const dimensions = size();
    const anchor = preserveAnchor === true ? { x: bounds.x + (bounds.width - dimensions.width) / 2, y: bounds.y + bounds.height - dimensions.height } : bounds;
    const next = clampPosition(anchor, screen.getDisplayMatching(bounds).workArea, dimensions);
    win.setBounds({ ...next, ...size() });
    persist();
    schedule();
  }
  function tick() {
    if (!alive()) return;
    const locale = getLocale();
    if (state.locale !== locale) { state.locale = locale; publish(); }
    const cursor = screen.getCursorScreenPoint();
    if (drag) {
      const candidate = { x: cursor.x - drag.offset.x, y: cursor.y - drag.offset.y };
      const next = clampPosition(candidate, screen.getDisplayNearestPoint(cursor).workArea, size());
      win.setPosition(next.x, next.y);
    } else if (journey && eligible()) {
      const progress = Math.min(1, (Date.now() - journey.time) / journey.duration);
      win.setPosition(Math.round(journey.start.x + (journey.target.x - journey.start.x) * progress), Math.round(journey.start.y + (journey.target.y - journey.start.y) * progress));
      if (progress === 1) { schedule(); }
    }
    const bounds = win.getBounds();
    const x = cursor.x - bounds.x, y = cursor.y - bounds.y;
    const hit = regions.some(rect => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
    win.setIgnoreMouseEvents(!hit && !drag, { forward: true });
  }
  function authorized(event) { return alive() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame; }
  ipcMain.handle("desktop-mascot:state", event => authorized(event) ? { ...state, roaming, roamingDirection, notifications: notifications.snapshot() } : null);
  ipcMain.handle("desktop-mascot:action", (event, id, operation) => {
    if (!authorized(event)) throw new Error("无权处理看板娘请求。");
    return notifications.processAction(id, operation);
  });
  ipcMain.on("desktop-mascot:command", (event, command) => {
    if (!authorized(event) || !command || typeof command !== "object") return;
    switch (command.type) {
      case "notification-dismiss": notifications.dismiss(command.id); break;
      case "notification-presentation":
        if (typeof command.paused === "boolean") notifications.setPresentation(command.id, command.paused);
        break;
      case "preferences":
        for (const key of ["collapsed", "moving"]) if (typeof command[key] === "boolean") state[key] = command[key];
        correct(); publish(); break;
      case "migrate":
        if (state.migrated) break;
        for (const key of ["collapsed", "animated"]) if (typeof command[key] === "boolean") state[key] = command[key];
        state.migrated = true; correct(); publish(); break;
      case "interaction":
        if (typeof command.paused !== "boolean" || typeof command.reduced !== "boolean") break;
        if (interaction === command.paused && reduced === command.reduced) break;
        interaction = command.paused; reduced = command.reduced; schedule(); break;
      case "regions":
        if (!Array.isArray(command.regions)) break;
        regions = command.regions.slice(0, 256).filter(rect => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0); break;
      case "drag-start": {
        stop();
        const cursor = screen.getCursorScreenPoint(), bounds = win.getBounds();
        drag = { offset: { x: cursor.x - bounds.x, y: cursor.y - bounds.y } }; break;
      }
      case "drag-end": drag = undefined; persist(); schedule(); break;
      case "step": {
        if (!["left", "right", "up", "down"].includes(command.direction)) break;
        stop();
        const delta = { left: [-20, 0], right: [20, 0], up: [0, -20], down: [0, 20] }[command.direction];
        const bounds = win.getBounds();
        const next = clampPosition({ x: bounds.x + delta[0], y: bounds.y + delta[1] }, screen.getDisplayMatching(bounds).workArea, size());
        win.setPosition(next.x, next.y); persist(); schedule(); break;
      }
    }
  });
  function open(mainWindow) {
    if (alive() || !mainWindow || mainWindow.isDestroyed?.()) return;
    interaction = false; reduced = false; regions = []; drag = undefined;
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const dimensions = size();
    const initial = Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : { x: area.x + area.width - dimensions.width - 24, y: area.y + area.height - dimensions.height - 8 };
    const display = screen.getDisplayNearestPoint({ x: initial.x, y: initial.y });
    const position = clampPosition({ x: initial.x - (dimensions.width - characterSize().width) / 2,
      y: initial.y - (dimensions.height - characterSize().height) }, display.workArea, dimensions);
    win = new BrowserWindow({ ...position, ...dimensions, frame: false, thickFrame: false, transparent: true, focusable: process.platform !== "win32", resizable: false, maximizable: false, minimizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: "#00000000", webPreferences: { preload: path.join(__dirname, "..", "mascot-preload.cjs"), contextIsolation: true, nodeIntegration: false } });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.once("ready-to-show", () => { if (alive()) win.showInactive(); });
    win.on("blur", () => { drag = undefined; interaction = false; persist(); schedule(); });
    win.on("closed", () => {
      win = undefined; stop(); clearInterval(poll); notifications.suspend();
      screen.removeListener("display-removed", correct);
      screen.removeListener("display-metrics-changed", correct);
    });
    if (app.isPackaged) win.loadFile(path.join(__dirname, "..", "..", "dist", "mascot.html"));
    else win.loadURL("http://127.0.0.1:6173/mascot.html");
    poll = setInterval(tick, 33);
    screen.on("display-removed", correct);
    screen.on("display-metrics-changed", correct);
  }
  function close() {
    stop(); clearInterval(poll);
    screen.removeListener("display-removed", correct);
    screen.removeListener("display-metrics-changed", correct);
    if (alive()) { persist(); win.destroy(); }
  }
  function setEnabled(enabled, mainWindow) {
    if (enabled) open(mainWindow);
    else close();
  }
  function shutdown() { close(); notifications.shutdown(); }
  return { open, close, setEnabled, shutdown, handleDesktopEvent: notifications.handleDesktopEvent };
}

module.exports = { createDesktopMascot, clampPosition };
