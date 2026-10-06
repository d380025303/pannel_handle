const { createMobileSocketHandlers } = require("./mobile-socket-handlers.cjs");
const { createMobileAuth } = require("./mobile-auth.cjs");
const { createMobileHttpHandler } = require("./mobile-http.cjs");
const { createMobileUploads } = require("./mobile-uploads.cjs");
const { createMobileFiles } = require("./mobile-files.cjs");
const { createTerminalSizeOwner } = require("./terminal-size-owner.cjs");
const { toRuntimeSession, toSavedTemplates, launchMobileTemplate } = require("./mobile-session-values.cjs");
const { sessionOverview } = require("./mobile-session-overview.cjs");
const { sanitizeHostLabel, getMobileHostname, isPrivateIpv4, listPrivateInterfaces } = require("./mobile-network.cjs");
const { PROTOCOL_VERSION, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, MAX_INPUT_BYTES, MAX_INPUT_BYTES_PER_SECOND, MAX_BUFFERED_OUTPUT_BYTES } = require("./mobile-protocol.cjs");
const http = require("node:http");
const os = require("node:os");
const { Bonjour } = require("bonjour-service");
const { WebSocket, WebSocketServer } = require("ws");

function createMobileRemoteService({
  terminalManager,
  agentSessionLauncher,
  graphicalService,
  codexPluginService, codexVersionService, projectSearchService, mcpConfigService,
  getAgentUsage,
  getOpenCodeVerifiedModels, getCodexVerifiedModels, getCodeBuddyVerifiedModels, codeBuddyPluginService, codeBuddyVersionService,
  sessionStore,
  accessStore,
  stateHub,
  getStaticRoot,
  desktopBroadcast,
  notifyConnection,
  now = () => Date.now(),
  networkInterfaces = () => os.networkInterfaces(),
  createHttpServer = handler => http.createServer(handler),
  createWebSocketServer = options => new WebSocketServer(options),
  createDiscovery = () => new Bonjour()
}) {
  let server = null;
  let localServer = null;
  let webSocketServer = null;
  let bonjour = null;
  let bonjourService = null;
  let heartbeatTimer = null;
  let currentAddress = "";
  let lastError = "";
  const overviewTimers = new Map();
  const lastOverviews = new Map();
  const overviewRevisions = new Map();
  const agentStatuses = new Map();
  const uploads = createMobileUploads({ now });
  const files = createMobileFiles({ now });

  const sizes = createTerminalSizeOwner({
    terminalManager, stateHub, desktopBroadcast, send,
    getSubscribedSockets: sessionId => auth.getClients().map(client => client.socket).filter(socket => socket.subscriptions?.has(sessionId))
  });
  const auth = createMobileAuth({
    accessStore, now, send, sendError, notifyConnection, broadcastState, currentState,
    releaseDeviceSizes: sizes.releaseDeviceSizes,
    sendReady: socket => socketHandlers.sendReady(socket)
  });
  const socketHandlers = createMobileSocketHandlers({
    terminalManager, sessionStore, agentSessionLauncher, graphicalService, codexPluginService, codexVersionService, projectSearchService, mcpConfigService, getAgentUsage, getOpenCodeVerifiedModels, getCodexVerifiedModels, getCodeBuddyVerifiedModels, codeBuddyPluginService, codeBuddyVersionService, stateHub, now,
    auth, sizes, uploads, files, send, sendError,
    getAgentStatus: sessionId => agentStatuses.get(sessionId)
  });
  const { verifyRequestHost, handleHttp } = createMobileHttpHandler({
    accessStore, getAddress: () => currentAddress, getStaticRoot, uploads, files
  });

  function send(socket, message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_OUTPUT_BYTES) {
      accessStore.recordAudit("connection.slow-client", { deviceId: socket.mobileDevice?.id, deviceName: socket.mobileDevice?.name });
      socket.mobileCloseReason = "slow-client";
      socket.close(1013, "客户端接收过慢");
      return false;
    }
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
    return true;
  }

  function sendError(socket, code, message, requestId) {
    send(socket, { type: "error", code, message, ...(requestId ? { requestId } : {}) });
  }

  function currentState() {
    const config = accessStore.getConfig();
    const interfaces = listPrivateInterfaces(networkInterfaces());
    const hostname = getMobileHostname();
    const running = Boolean(localServer?.listening);
    const lanRunning = Boolean(server?.listening);
    return {
      config,
      interfaces,
      running,
      hostname,
      address: currentAddress,
      canonicalUrl: lanRunning ? `http://${hostname}:${config.port}` : "",
      fallbackUrl: lanRunning ? `http://${currentAddress}:${config.port}` : "",
      localUrl: running ? `http://127.0.0.1:${config.port}` : "",
      lastError,
      activeConnections: auth.getClients().map(client => ({
        id: client.id, name: client.name, remoteAddress: client.remoteAddress
      }))
    };
  }

  function broadcastState() {
    desktopBroadcast("mobile-access:state-changed", currentState());
  }

  function attachUpgradeHandler(httpServer) {
    httpServer.on("upgrade", (request, socket, head) => {
      if (request.url !== "/api/v1/ws" || !verifyRequestHost(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (ws) => socketHandlers.handleWebSocket(ws, request));
    });
  }

  function queueOverview(sessionId, delay = 0) {
    if (overviewTimers.has(sessionId)) return;
    overviewTimers.set(sessionId, setTimeout(() => {
      overviewTimers.delete(sessionId);
      const session = terminalManager.getSession(sessionId);
      if (!session) return;
      const revision = (overviewRevisions.get(sessionId) || 0) + 1;
      overviewRevisions.set(sessionId, revision);
      void sessionOverview(session, graphicalService, stateHub, agentStatuses.get(sessionId)).then(overview => {
        if (!terminalManager.getSession(sessionId) || overviewRevisions.get(sessionId) !== revision) return;
        const serialized = JSON.stringify(overview);
        if (lastOverviews.get(sessionId) === serialized) return;
        lastOverviews.set(sessionId, serialized);
        for (const client of auth.getClients()) send(client.socket, { type: "session.overview", overview });
      }).catch(() => undefined);
    }, delay));
  }

  function listen(httpServer, port, address) {
    return new Promise((resolve, reject) => {
      const onError = (error) => { httpServer.off("listening", onListening); reject(error); };
      const onListening = () => { httpServer.off("error", onError); resolve(); };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, address);
    });
  }

  function closeHttpServer(httpServer) {
    return new Promise((resolve) => {
      if (!httpServer?.listening) return resolve();
      httpServer.close(() => resolve());
    });
  }

  async function start() {
    if (server?.listening && localServer?.listening) return currentState();
    const config = accessStore.getConfig();
    if (!config.enabled) return currentState();
    if (!localServer?.listening) {
      localServer = createHttpServer(handleHttp);
      webSocketServer = createWebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
      attachUpgradeHandler(localServer);
      try {
        await listen(localServer, config.port, "127.0.0.1");
      } catch (error) {
        lastError = error.code === "EADDRINUSE" ? `端口 ${config.port} 已被占用。` : (error.message || String(error));
        webSocketServer.close();
        localServer = null;
        webSocketServer = null;
        broadcastState();
        throw new Error(lastError);
      }
      heartbeatTimer = setInterval(() => {
        for (const socket of webSocketServer.clients) {
          if (socket.readyState !== WebSocket.OPEN) continue;
          if (now() - socket.lastAliveAt >= HEARTBEAT_TIMEOUT_MS) {
            socket.mobileCloseReason = "heartbeat-timeout";
            accessStore.recordAudit("connection.heartbeat-timeout", { deviceId: socket.mobileDevice?.id, deviceName: socket.mobileDevice?.name });
            socket.terminate();
            continue;
          }
          socket.ping();
        }
      }, HEARTBEAT_MS);
    }
    const selected = listPrivateInterfaces(networkInterfaces()).find((item) => item.name === config.interfaceName);
    if (!selected) {
      lastError = "选择的局域网网卡不可用，请重新选择。";
      broadcastState();
      return currentState();
    }
    server = createHttpServer(handleHttp);
    attachUpgradeHandler(server);
    try {
      await listen(server, config.port, selected.address);
    } catch (error) {
      lastError = error.code === "EADDRINUSE" ? `局域网端口 ${config.port} 已被占用。`
        : error.code === "EADDRNOTAVAIL" ? "选择的局域网网卡不可用，请重新选择。" : (error.message || String(error));
      server = null;
      broadcastState();
      return currentState();
    }
    currentAddress = selected.address;
    lastError = "";
    bonjour = createDiscovery();
    bonjourService = bonjour.publish({
      name: `Pannel Handle ${os.hostname()}`,
      type: "pannel-handle",
      host: getMobileHostname(),
      port: config.port,
      txt: { protocol: String(PROTOCOL_VERSION), address: currentAddress }
    });
    broadcastState();
    return currentState();
  }

  async function stop() {
    for (const timer of overviewTimers.values()) clearTimeout(timer);
    overviewTimers.clear();
    lastOverviews.clear();
    overviewRevisions.clear();
    agentStatuses.clear();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    auth.disconnectAll("service-stopped");
    uploads.stop();
    files.stop();
    for (const socket of webSocketServer?.clients || []) socket.terminate();
    await Promise.all([closeHttpServer(server), closeHttpServer(localServer)]);
    webSocketServer?.close();
    bonjourService?.stop?.();
    bonjour?.destroy?.();
    server = null;
    localServer = null;
    webSocketServer = null;
    bonjourService = null;
    bonjour = null;
    currentAddress = "";
    broadcastState();
  }

  async function updateConfig(partial) {
    const before = accessStore.getConfig();
    const next = accessStore.updateConfig(partial);
    const changed = before.enabled !== next.enabled || before.interfaceName !== next.interfaceName || before.port !== next.port;
    if (changed && (server || localServer)) await stop();
    if (next.enabled) await start().catch(() => undefined);
    broadcastState();
    return currentState();
  }

  function setPassword(password) {
    accessStore.setPassword(password);
    auth.disconnectAll("password-changed");
    broadcastState();
    return currentState();
  }

  function handleDesktopEvent(channel, payload) {
    if (channel === "agent:status") {
      if (payload?.id) {
        if (payload.status === "cleared") agentStatuses.delete(payload.id);
        else agentStatuses.set(payload.id, payload);
        queueOverview(payload.id);
      }
      return;
    }
    if (channel === "codex-app-server:changed") {
      for (const client of auth.getClients()) socketHandlers.handleGraphicalChanged(client.socket, payload);
      if (payload?.id) queueOverview(payload.id);
      return;
    }
    if (channel === "codex-app-server:delta") {
      for (const client of auth.getClients()) socketHandlers.handleGraphicalDelta(client.socket, payload);
      return;
    }
    if (channel === "terminal:started") {
      stateHub.start(payload.id, payload.cols, payload.rows);
      sizes.start(payload);
    } else if (channel === "terminal:data") {
      const seq = stateHub.write(payload.id, payload.data);
      for (const client of auth.getClients()) {
        const socket = client.socket;
        if (socket.subscriptions?.has(payload.id)) send(socket, { type: "terminal.data", sessionId: payload.id, data: payload.data, seq });
      }
      queueOverview(payload.id, 300);
    } else if (channel === "terminal:resized") {
      stateHub.resize(payload.id, payload.cols, payload.rows);
      sizes.observeResize(payload);
    } else if (channel === "terminal:exit") {
      if (overviewTimers.has(payload.id)) clearTimeout(overviewTimers.get(payload.id));
      overviewTimers.delete(payload.id);
      lastOverviews.delete(payload.id);
      overviewRevisions.delete(payload.id);
      for (const client of auth.getClients()) {
        const socket = client.socket;
        if (socket.subscriptions?.has(payload.id)) send(socket, { type: "terminal.exit", sessionId: payload.id, exitCode: payload.exitCode });
      }
      stateHub.remove(payload.id);
      sizes.remove(payload.id);
      uploads.releaseSession(payload.id);
    } else if (channel === "sessions:changed") {
      const ids = new Set(payload.map(session => session.id));
      for (const id of lastOverviews.keys()) if (!ids.has(id)) lastOverviews.delete(id);
      for (const id of overviewRevisions.keys()) if (!ids.has(id)) overviewRevisions.delete(id);
      for (const id of agentStatuses.keys()) if (!ids.has(id)) agentStatuses.delete(id);
      for (const client of auth.getClients()) {
        const socket = client.socket;
        if (socket.readyState !== WebSocket.OPEN) continue;
        send(socket, { type: "sessions.changed", sessions: payload.map(toRuntimeSession) });
        send(socket, { type: "templates.changed", templates: toSavedTemplates(sessionStore, terminalManager) });
      }
      for (const session of payload) queueOverview(session.id);
    }
  }

  return {
    start,
    stop,
    updateConfig,
    setPassword,
    getState: currentState,
    listAudit: accessStore.listAudit,
    disconnectConnection: auth.disconnectClient,
    resizeFromDesktop: sizes.resizeFromDesktop,
    claimDesktopSize: sizes.claimDesktopSize,
    handleDesktopEvent,
    handleTerminalEvent: handleDesktopEvent,
    constants: { PROTOCOL_VERSION }
  };
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_INPUT_BYTES,
  MAX_INPUT_BYTES_PER_SECOND,
  MAX_BUFFERED_OUTPUT_BYTES,
  sanitizeHostLabel,
  getMobileHostname,
  isPrivateIpv4,
  listPrivateInterfaces,
  launchMobileTemplate,
  createMobileRemoteService
};
