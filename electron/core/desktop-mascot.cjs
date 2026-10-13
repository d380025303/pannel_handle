const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createMascotNotifications } = require("./mascot-notifications.cjs");

function clampPosition(position, area, size) {
  if (![position.x, position.y, area.x, area.y, area.width, area.height, size.width, size.height].every(Number.isFinite)) throw new TypeError("Invalid desktop mascot geometry");
  const result = {
    // Math.round can return -0, which Electron's native integer converter rejects.
    x: Math.round(Math.max(area.x, Math.min(position.x, area.x + Math.max(0, area.width - size.width)))) + 0,
    y: Math.round(Math.max(area.y, Math.min(position.y, area.y + Math.max(0, area.height - size.height)))) + 0
  };
  if (!validPosition(result)) throw new RangeError("Desktop mascot coordinates exceed Electron integer range");
  return result;
}

function validPosition(position) {
  return [position.x, position.y].every(value => Number.isFinite(value) && value >= -2147483648 && value <= 2147483647);
}

function createDesktopMascot({ app, BrowserWindow, screen, ipcMain, terminalManager, graphicalService, conversationManager, stateHub, openExternal, getLocale = () => "zh-CN", random = Math.random, now = () => performance.now() }) {
  const file = path.join(app.getPath("userData"), "desktop-mascot.json");
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  const state = { collapsed: saved.collapsed === true, animated: saved.animated !== false, moving: saved.moving !== false, migrated: saved.migrated === true, locale: getLocale() };
  let win, timer, poll, journey, drag, frameRefresh;
  let enabled = true;
  let movementFailed = false, pollFailed = false, movementContext;
  let ignoringMouse;
  function setIgnoringMouse(value) {
    if (ignoringMouse === value) return;
    win.setIgnoreMouseEvents(value, { forward: true });
    ignoringMouse = value;
  }
  function guarded(operation, callback) {
    try { callback(); } catch (error) { recover(operation, error); }
  }
  function recover(operation, error) {
    console.error("Desktop mascot operation failed:", { operation, ...movementContext, journey }, error);
    clearTimeout(timer); timer = undefined; journey = undefined; drag = undefined;
    roaming = false; movementFailed = true;
    if (!alive()) return;
    try {
      const bounds = win.getBounds();
      const area = screen.getDisplayMatching(mainWindow?.getBounds?.() || bounds).workArea;
      const dimensions = size();
      const next = clampPosition(validPosition(bounds) ? bounds : area, area, dimensions);
      win.setBounds({ ...next, ...dimensions });
      win.setIgnoreMouseEvents(false); ignoringMouse = false;
      publish(); persist();
      // A failed cursor/hit-test API must not be retried every 33 ms.
      if (operation === "poll") pollFailed = true;
      else { movementFailed = false; schedule(); }
    } catch (recoveryError) {
      console.error("Desktop mascot recovery failed:", recoveryError);
      pollFailed = true;
      // Keep notification actions reachable even if restoring the bounds failed.
      try { win.setIgnoreMouseEvents(false); ignoringMouse = false; } catch {}
    }
  }
  function move(position, area) {
    movementContext = { ...movementContext, position, area };
    const dimensions = size();
    const next = clampPosition(position, area, dimensions);
    const bounds = win.getBounds();
    if (bounds.width !== dimensions.width || bounds.height !== dimensions.height) {
      win.setBounds({ ...next, ...dimensions });
    } else if (bounds.x !== next.x || bounds.y !== next.y) win.setPosition(next.x, next.y);
  }
  // Electron #46882: another window losing focus can repaint our native caption.
  function refreshNativeFrame() {
    if (process.platform !== "win32" || !alive() || frameRefresh !== undefined) return;
    frameRefresh = setTimeout(() => {
      frameRefresh = undefined;
      if (alive()) win.setMaximizable(false);
    }, 0);
  }
  function removeFrameRefresh() {
    clearTimeout(frameRefresh); frameRefresh = undefined;
    app.removeListener("browser-window-blur", refreshNativeFrame);
  }
  let interaction = false, reduced = false, regions = [];
  let roaming = false;
  let roamingDirection = "left";
  let showingNotification = false, showingRequest = false;
  let openedId = null;
  let hasMessage = false;
  let expandedId = null, presentationPaused = false;
  let mainWindow, mainFocused = false, presentationRevision = 0;
  let presentationReady = false;
  const presentationSnapshot = () => ({ ...notifications.snapshot(), revision: presentationRevision,
    notification: mainFocused ? null : notifications.snapshot().notification });
  function setPresentation(id, paused) {
    if (!alive() || !presentationReady) notifications.suspend();
    else notifications.setPresentation(id, paused);
  }
  function updateNotifications() {
    presentationRevision++;
    const snapshot = presentationSnapshot();
    if (mainFocused) {
      presentationPaused = false;
    }
    if (snapshot.notification?.id !== openedId) openedId = null;
    const showing = Boolean(snapshot.notification && openedId === snapshot.notification.id);
    const messageChanged = hasMessage !== Boolean(snapshot.notification);
    hasMessage = Boolean(snapshot.notification);
    const expansionChanged = expandedId !== null && (snapshot.notification?.id !== expandedId || snapshot.notification?.action);
    if (expansionChanged) expandedId = null;
    const dimensionsChanged = Boolean(showing && snapshot.notification?.action) !== showingRequest || expansionChanged || messageChanged;
    if (showing !== showingNotification || dimensionsChanged) {
      showingNotification = showing; showingRequest = Boolean(showing && snapshot.notification?.action); regions = []; correct(true, messageChanged ? (hasMessage ? 40 : -40) : 0);
    }
    const current = notifications.snapshot().notification;
    setPresentation(current?.id, mainFocused || showing || presentationPaused);
    if (alive()) win.webContents.send("desktop-mascot:notifications", snapshot);
  }
  function setMainFocused(value) {
    if (mainFocused === value) return;
    mainFocused = value;
    updateNotifications();
  }
  const mainFocus = () => setMainFocused(true);
  const mainBlur = () => setMainFocused(false);
  function removeMainListeners() {
    mainWindow?.removeListener?.("focus", mainFocus);
    mainWindow?.removeListener?.("blur", mainBlur);
    mainWindow = undefined;
  }
  const notifications = createMascotNotifications({ terminalManager, graphicalService, conversationManager, stateHub, openExternal,
    onChanged: updateNotifications
  });
  const characterSize = () => state.collapsed ? { width: hasMessage ? 120 : 52, height: hasMessage ? 92 : 52 } : { width: 192, height: hasMessage ? 272 : 232 };
  const bubbleHeight = () => notifications.snapshot().notification?.action ? 388 : 188;
  const size = () => {
    if (expandedId && alive()) {
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      return { width: Math.min(656, area.width), height: Math.min(498 + characterSize().height, area.height) };
    }
    return showingNotification ? { width: 320, height: characterSize().height + bubbleHeight() } : characterSize();
  };
  const alive = () => win && !win.isDestroyed();
  const publish = () => { if (alive()) win.webContents.send("desktop-mascot:state", { ...state, roaming, roamingDirection, notifications: presentationSnapshot() }); };
  function persist() {
    if (!alive()) return;
    const bounds = win.getBounds();
    const x = bounds.x + (bounds.width - characterSize().width) / 2;
    const y = bounds.y + bounds.height - characterSize().height;
    if (!validPosition({ x, y })) return;
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
  function eligible() { return alive() && !movementFailed && state.moving && !state.collapsed && !hasMessage && !interaction && !reduced && !drag; }
  function schedule() {
    stop();
    if (!eligible()) return;
    timer = setTimeout(() => guarded("movement-start", () => {
      if (!eligible()) return;
      const start = win.getBounds();
      const area = screen.getDisplayMatching(start).workArea;
      const dimensions = size();
      movementContext = { bounds: start, area };
      const target = clampPosition({ x: area.x + random() * Math.max(0, area.width - dimensions.width), y: area.y + random() * Math.max(0, area.height - dimensions.height) }, area, dimensions);
      if (target.x === start.x && target.y === start.y) { schedule(); return; }
      journey = { start, target, time: now(), duration: Math.max(1, Math.hypot(target.x - start.x, target.y - start.y) / 60 * 1000) };
      if (target.x !== start.x) roamingDirection = target.x < start.x ? "left" : "right";
      setRoaming(true);
    }), 8000 + random() * 7000);
  }
  function correct(preserveAnchor = false, bottomOffset = 0) {
    if (!alive()) return;
    stop();
    drag = undefined;
    const bounds = win.getBounds();
    const dimensions = size();
    const anchor = preserveAnchor === true ? { x: bounds.x + (bounds.width - dimensions.width) / 2, y: bounds.y + bounds.height - dimensions.height + bottomOffset } : bounds;
    const next = clampPosition(anchor, screen.getDisplayMatching(bounds).workArea, dimensions);
    win.setBounds({ ...next, ...size() });
    persist();
    schedule();
  }
  function tick() {
    if (!alive() || pollFailed) return;
    movementContext = undefined;
    let operation = "poll";
    try {
      const locale = getLocale();
      if (state.locale !== locale) { state.locale = locale; publish(); }
      const cursor = screen.getCursorScreenPoint();
      if (drag) {
        operation = "drag";
        const candidate = { x: cursor.x - drag.offset.x, y: cursor.y - drag.offset.y };
        move(candidate, screen.getDisplayNearestPoint(cursor).workArea);
      } else if (journey && eligible()) {
        operation = "movement";
        const progress = Math.max(0, Math.min(1, (now() - journey.time) / journey.duration));
        movementContext = { progress, bounds: win.getBounds() };
        move({ x: journey.start.x + (journey.target.x - journey.start.x) * progress, y: journey.start.y + (journey.target.y - journey.start.y) * progress }, screen.getDisplayMatching(win.getBounds()).workArea);
        if (progress === 1) { schedule(); }
      }
      operation = "poll";
      const bounds = win.getBounds();
      movementContext = { ...movementContext, bounds };
      const x = cursor.x - bounds.x, y = cursor.y - bounds.y;
      const hit = regions.some(rect => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
      setIgnoringMouse(!hit && !drag);
    } catch (error) { recover(operation, error); }
  }
  function authorized(event) { return alive() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame; }
  ipcMain.handle("desktop-mascot:state", event => authorized(event) ? { ...state, roaming, roamingDirection, notifications: presentationSnapshot() } : null);
  ipcMain.handle("desktop-mascot:action", (event, id, operation) => {
    if (!authorized(event)) throw new Error("无权处理看板娘请求。");
    return notifications.processAction(id, operation);
  });
  ipcMain.on("desktop-mascot:command", (event, command) => {
    if (!authorized(event) || !command || typeof command !== "object") return;
    switch (command.type) {
      case "notification-dismiss": notifications.dismiss(command.id); break;
      case "notification-presentation":
        if (typeof command.paused === "boolean" && command.id === notifications.snapshot().notification?.id) {
          presentationPaused = !mainFocused && command.paused;
          setPresentation(command.id, mainFocused || openedId === command.id || presentationPaused || expandedId === command.id);
        }
        break;
      case "notification-expanded": {
        const current = notifications.snapshot().notification;
        if (mainFocused || !current || current.id !== command.id || typeof command.expanded !== "boolean") break;
        openedId = command.expanded ? current.id : null;
        if (!command.expanded) expandedId = null;
        updateNotifications(); break;
      }
      case "summary-expanded": {
        const current = notifications.snapshot().notification;
        if (mainFocused || openedId !== current?.id || !current || current.action || current.id !== command.id || typeof command.expanded !== "boolean") break;
        const next = command.expanded ? current.id : null;
        if (next === expandedId) break;
        expandedId = next;
        setPresentation(current.id, openedId === current.id || presentationPaused || expandedId === current.id);
        regions = []; correct(true); break;
      }
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
        guarded("step", () => { move({ x: bounds.x + delta[0], y: bounds.y + delta[1] }, screen.getDisplayMatching(bounds).workArea); persist(); schedule(); }); break;
      }
    }
  });
  function open(hostWindow) {
    if (alive() || !hostWindow || hostWindow.isDestroyed?.()) return;
    mainWindow = hostWindow;
    mainFocused = mainWindow.isFocused?.() === true;
    mainWindow.on?.("focus", mainFocus);
    mainWindow.on?.("blur", mainBlur);
    updateNotifications();
    interaction = false; reduced = false; regions = []; drag = undefined;
    movementFailed = false; pollFailed = false;
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const dimensions = size();
    const initial = validPosition(saved) ? { x: Math.round(saved.x), y: Math.round(saved.y) } : { x: area.x + area.width - dimensions.width - 24, y: area.y + area.height - dimensions.height - 8 };
    const display = screen.getDisplayNearestPoint({ x: initial.x, y: initial.y });
    const position = clampPosition({ x: initial.x - (dimensions.width - characterSize().width) / 2,
      y: initial.y - (dimensions.height - characterSize().height) }, display.workArea, dimensions);
    win = new BrowserWindow({ ...position, ...dimensions, frame: false, thickFrame: false, transparent: true, focusable: true, resizable: false, maximizable: false, minimizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: "#00000000", webPreferences: { preload: path.join(__dirname, "..", "mascot-preload.cjs"), contextIsolation: true, nodeIntegration: false } });
    if (process.platform === "win32") {
      app.on("browser-window-blur", refreshNativeFrame);
      // Defer until Windows finishes WM_NCACTIVATE; avoid reentrant frame updates.
      win.hookWindowMessage(0x0086, refreshNativeFrame);
    }
    ignoringMouse = undefined;
    setIgnoringMouse(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.once("ready-to-show", () => {
      if (!alive()) return;
      win.showInactive();
      presentationReady = true;
      updateNotifications();
    });
    win.on("blur", () => { drag = undefined; interaction = false; persist(); schedule(); });
    win.on("closed", () => {
      removeMainListeners();
      presentationReady = false;
      openedId = null; expandedId = null; presentationPaused = false;
      removeFrameRefresh();
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
    removeMainListeners();
    openedId = null; expandedId = null; presentationPaused = false;
    removeFrameRefresh();
    stop(); clearInterval(poll);
    screen.removeListener("display-removed", correct);
    screen.removeListener("display-metrics-changed", correct);
    if (alive()) { persist(); win.destroy(); }
  }
  function setEnabled(value, mainWindow) {
    const wasEnabled = enabled;
    enabled = Boolean(value);
    if (enabled) {
      if (!wasEnabled) notifications.syncCurrentPending();
      open(mainWindow);
    } else {
      close();
      notifications.reset();
    }
  }
  function handleDesktopEvent(channel, payload) {
    if (enabled) notifications.handleDesktopEvent(channel, payload);
  }
  function shutdown() { enabled = false; close(); notifications.shutdown(); }
  return { open, close, setEnabled, shutdown, handleDesktopEvent };
}

module.exports = { createDesktopMascot, clampPosition };
