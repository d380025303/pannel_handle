const DEFAULT_BOUNDS = { width: 320, height: 720 };

function constrainBounds(screenApi, savedBounds) {
  const candidate = savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)
    ? savedBounds
    : null;
  const display = candidate
    ? screenApi.getDisplayMatching(candidate)
    : screenApi.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = Math.min(Math.max(candidate?.width || DEFAULT_BOUNDS.width, 320), workArea.width);
  const height = Math.min(Math.max(candidate?.height || DEFAULT_BOUNDS.height, 220), workArea.height);
  return {
    x: candidate
      ? Math.min(Math.max(candidate.x, workArea.x), workArea.x + workArea.width - width)
      : Math.max(workArea.x, workArea.x + workArea.width - width - 24),
    y: candidate
      ? Math.min(Math.max(candidate.y, workArea.y), workArea.y + workArea.height - height)
      : Math.max(workArea.y, workArea.y + workArea.height - height - 48),
    width,
    height
  };
}

function createAgentConversationOverlayManager({
  BrowserWindow,
  screen,
  configStore,
  windowManager,
  isPackaged,
  preloadPath,
  indexPath,
  devUrl = "http://127.0.0.1:6173",
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  const turns = new Map();
  let overlayWindow = null;
  let overlayWindowLoaded = false;
  let activeSessionId = null;
  let shuttingDown = false;
  let boundsTimer = null;

  function getConfig() {
    return configStore.getConfig();
  }

  function getSnapshot() {
    const turn = activeSessionId ? turns.get(activeSessionId) : null;
    const config = getConfig();
    return {
      enabled: config.agentConversationOverlayEnabled,
      themeId: config.themeId,
      locale: config.locale,
      activeSessionId,
      turn: turn ? {
        sessionId: turn.sessionId,
        sessionTitle: turn.sessionTitle,
        provider: turn.provider,
        status: turn.status,
        supported: turn.supported,
        messages: turn.messages.map(message => ({ ...message }))
      } : null
    };
  }

  function shouldShow(turn) {
    return Boolean(
      getConfig().agentConversationOverlayEnabled &&
      turn &&
      !turn.suppressed &&
      (!turn.supported || turn.messages.length > 0)
    );
  }

  function sendSnapshot() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("agent-conversation:snapshot", getSnapshot());
    }
  }

  function saveBoundsSoon() {
    if (boundsTimer) clearTimeoutFn(boundsTimer);
    boundsTimer = setTimeoutFn(() => {
      boundsTimer = null;
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      configStore.updateConfig({ agentConversationOverlayBounds: overlayWindow.getBounds() });
    }, 250);
  }

  function ensureWindow() {
    if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
    const bounds = constrainBounds(screen, getConfig().agentConversationOverlayBounds);
    overlayWindow = new BrowserWindow({
      ...bounds,
      minWidth: 320,
      minHeight: 220,
      frame: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    overlayWindowLoaded = false;
    overlayWindow.setAlwaysOnTop(true, "floating");
    overlayWindow.on("move", saveBoundsSoon);
    overlayWindow.on("resize", saveBoundsSoon);
    overlayWindow.on("close", event => {
      if (shuttingDown) return;
      event.preventDefault();
      const turn = activeSessionId ? turns.get(activeSessionId) : null;
      if (turn) turn.suppressed = true;
      overlayWindow.hide();
    });
    overlayWindow.on("closed", () => { overlayWindow = null; overlayWindowLoaded = false; });
    overlayWindow.webContents.on("did-finish-load", () => {
      overlayWindowLoaded = true;
      sendSnapshot();
      const turn = activeSessionId ? turns.get(activeSessionId) : null;
      if (shouldShow(turn)) overlayWindow.showInactive();
    });
    if (isPackaged) {
      overlayWindow.loadFile(indexPath, { query: { view: "agent-conversation" } });
    } else {
      overlayWindow.loadURL(`${devUrl}/?view=agent-conversation`);
    }
    return overlayWindow;
  }

  function refreshVisibility() {
    const turn = activeSessionId ? turns.get(activeSessionId) : null;
    if (!shouldShow(turn)) {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        sendSnapshot();
        overlayWindow.hide();
      }
      return;
    }
    const win = ensureWindow();
    sendSnapshot();
    if (overlayWindowLoaded && !win.isVisible()) win.showInactive();
  }

  function setActiveSession(sessionId) {
    activeSessionId = sessionId ? String(sessionId) : null;
    refreshVisibility();
  }

  function startTurn({ sessionId, sessionTitle, provider, supported }) {
    if (provider !== "codex" && provider !== "codebuddy") return;
    const existingTurn = turns.get(sessionId);
    turns.set(sessionId, {
      sessionId,
      sessionTitle: String(sessionTitle || provider),
      provider,
      status: supported ? "running" : "unsupported",
      supported: Boolean(supported),
      messages: existingTurn?.messages || [],
      suppressed: false
    });
    if (activeSessionId === sessionId) refreshVisibility();
  }

  function appendMessages(sessionId, messages) {
    const turn = turns.get(sessionId);
    if (!turn || !turn.supported || !Array.isArray(messages)) return;
    const ids = new Set(turn.messages.map(message => message.id));
    for (const message of messages) {
      if (!message?.id || !message.text || ids.has(message.id)) continue;
      ids.add(message.id);
      turn.messages.push({ ...message });
    }
    if (activeSessionId === sessionId) refreshVisibility();
  }

  function completeTurn(sessionId) {
    const turn = turns.get(sessionId);
    if (!turn || !turn.supported) return;
    turn.status = "completed";
    if (activeSessionId === sessionId) refreshVisibility();
  }

  function clearSession(sessionId) {
    turns.delete(sessionId);
    if (activeSessionId === sessionId) refreshVisibility();
  }

  function setEnabled(enabled) {
    const nextEnabled = Boolean(enabled);
    if (getConfig().agentConversationOverlayEnabled !== nextEnabled) {
      configStore.updateConfig({ agentConversationOverlayEnabled: nextEnabled });
    }
    refreshVisibility();
  }

  function hide() {
    const turn = activeSessionId ? turns.get(activeSessionId) : null;
    if (turn) turn.suppressed = true;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  }

  function focusActiveSession() {
    if (activeSessionId) windowManager.focusAndSelectSession(activeSessionId);
    else windowManager.focusWindow();
  }

  function shutdown() {
    shuttingDown = true;
    if (boundsTimer) clearTimeoutFn(boundsTimer);
    boundsTimer = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
    overlayWindowLoaded = false;
    turns.clear();
  }

  return {
    setActiveSession,
    startTurn,
    appendMessages,
    completeTurn,
    clearSession,
    setEnabled,
    getSnapshot,
    hide,
    focusActiveSession,
    refresh: refreshVisibility,
    shutdown
  };
}

module.exports = {
  DEFAULT_BOUNDS,
  constrainBounds,
  createAgentConversationOverlayManager
};
