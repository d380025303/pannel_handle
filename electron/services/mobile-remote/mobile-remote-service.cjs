const { createMobileSocketHandlers } = require("./mobile-socket-handlers.cjs");
const { createMobileAuth } = require("./mobile-auth.cjs");
const { createMobileHttpHandler } = require("./mobile-http.cjs");
const { createTerminalSizeOwner } = require("./terminal-size-owner.cjs");
const { toRuntimeSession, toSavedTemplates, launchMobileTemplate } = require("./mobile-session-values.cjs");
const { sanitizeHostLabel, getMobileHostname, isPrivateIpv4, listPrivateInterfaces, createPairingUrls } = require("./mobile-network.cjs");
const { PROTOCOL_VERSION, PAIRING_TTL_MS, MOBILE_GRACE_MS, HEARTBEAT_MS, MAX_INPUT_BYTES, MAX_INPUT_BYTES_PER_SECOND, MAX_BUFFERED_OUTPUT_BYTES } = require("./mobile-protocol.cjs");
const http = require("node:http");
const os = require("node:os");
const { Bonjour } = require("bonjour-service");
const { WebSocket, WebSocketServer } = require("ws");

function createMobileRemoteService({
  terminalManager,
  agentSessionLauncher,
  graphicalService,
  sessionStore,
  accessStore,
  stateHub,
  getStaticRoot,
  desktopBroadcast,
  confirmPairing,
  notifyConnection,
  now = () => Date.now(),
  networkInterfaces = () => os.networkInterfaces(),
  createHttpServer = handler => http.createServer(handler),
  createWebSocketServer = options => new WebSocketServer(options),
  createDiscovery = () => new Bonjour()
}) {
  let server = null;
  let webSocketServer = null;
  let bonjour = null;
  let bonjourService = null;
  let heartbeatTimer = null;
  let currentAddress = "";
  let lastError = "";

  const sizes = createTerminalSizeOwner({
    terminalManager, stateHub, desktopBroadcast, send,
    getActiveSocket: () => auth.getActiveClient()?.socket
  });
  const auth = createMobileAuth({
    accessStore, now, send, sendError, confirmPairing, notifyConnection,
    currentState, broadcastState,
    releaseDeviceSizes: sizes.releaseDeviceSizes,
    sendReady: socket => socketHandlers.sendReady(socket)
  });
  const socketHandlers = createMobileSocketHandlers({
    terminalManager, sessionStore, agentSessionLauncher, graphicalService, stateHub, now,
    accessStore, auth, sizes, send, sendError
  });
  const { verifyRequestHost, handleHttp } = createMobileHttpHandler({
    accessStore, getAddress: () => currentAddress, getStaticRoot
  });

  function send(socket, message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_OUTPUT_BYTES) {
      accessStore.recordAudit("connection.slow-client", { deviceId: socket.mobileDevice?.id, deviceName: socket.mobileDevice?.name });
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
    const activeClient = auth.getActiveClient();
    const config = accessStore.getConfig();
    const interfaces = listPrivateInterfaces(networkInterfaces());
    const hostname = getMobileHostname();
    const running = Boolean(server?.listening);
    return {
      config,
      interfaces,
      running,
      hostname,
      address: currentAddress,
      canonicalUrl: running ? `http://${hostname}:${config.port}` : "",
      fallbackUrl: running ? `http://${currentAddress}:${config.port}` : "",
      lastError,
      devices: accessStore.listDevices(),
      activeDevice: activeClient ? {
        id: activeClient.device.id,
        name: activeClient.device.name,
        connected: Boolean(activeClient.socket?.readyState === WebSocket.OPEN),
        graceUntil: activeClient.graceUntil || undefined
      } : null
    };
  }

  function broadcastState() {
    desktopBroadcast("mobile-access:state-changed", currentState());
  }

  async function start() {
    if (server?.listening) return currentState();
    const config = accessStore.getConfig();
    if (!config.enabled) return currentState();
    const selected = listPrivateInterfaces(networkInterfaces()).find((item) => item.name === config.interfaceName);
    if (!selected) {
      lastError = "选择的局域网网卡不可用，请重新选择。";
      broadcastState();
      throw new Error(lastError);
    }
    currentAddress = selected.address;
    lastError = "";
    server = createHttpServer(handleHttp);
    webSocketServer = createWebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/api/v1/ws" || !verifyRequestHost(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (ws) => socketHandlers.handleWebSocket(ws, request));
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, currentAddress);
    }).catch((error) => {
      lastError = error.code === "EADDRINUSE" ? `端口 ${config.port} 已被占用。` : (error.message || String(error));
      server = null;
      webSocketServer = null;
      broadcastState();
      throw new Error(lastError);
    });
    bonjour = createDiscovery();
    bonjourService = bonjour.publish({
      name: `Pannel Handle ${os.hostname()}`,
      type: "pannel-handle",
      host: getMobileHostname(),
      port: config.port,
      txt: { protocol: String(PROTOCOL_VERSION), address: currentAddress }
    });
    heartbeatTimer = setInterval(() => {
      for (const socket of webSocketServer.clients) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
      auth.expirePairings();
    }, HEARTBEAT_MS);
    broadcastState();
    return currentState();
  }

  async function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    auth.getActiveClient()?.socket?.close(1001, "电脑端已关闭移动访问");
    auth.releaseActiveClient("service-stopped", true);
    for (const socket of webSocketServer?.clients || []) socket.terminate();
    await new Promise((resolve) => server?.close(() => resolve()) || resolve());
    webSocketServer?.close();
    bonjourService?.stop?.();
    bonjour?.destroy?.();
    server = null;
    webSocketServer = null;
    bonjourService = null;
    bonjour = null;
    currentAddress = "";
    auth.clearPairings();
    broadcastState();
  }

  async function updateConfig(partial) {
    const before = accessStore.getConfig();
    const next = accessStore.updateConfig(partial);
    const changed = before.enabled !== next.enabled || before.interfaceName !== next.interfaceName || before.port !== next.port;
    if (changed && server) await stop();
    if (next.enabled) await start().catch(() => undefined);
    broadcastState();
    return currentState();
  }

  function handleDesktopEvent(channel, payload) {
    if (channel === "codex-app-server:changed") {
      socketHandlers.handleGraphicalChanged(auth.getActiveClient()?.socket, payload);
      return;
    }
    if (channel === "terminal:started") {
      stateHub.start(payload.id, payload.cols, payload.rows);
      sizes.start(payload);
    } else if (channel === "terminal:data") {
      const seq = stateHub.write(payload.id, payload.data);
      const socket = auth.getActiveClient()?.socket;
      if (socket?.subscriptions?.has(payload.id)) send(socket, { type: "terminal.data", sessionId: payload.id, data: payload.data, seq });
    } else if (channel === "terminal:resized") {
      stateHub.resize(payload.id, payload.cols, payload.rows);
      sizes.observeResize(payload);
    } else if (channel === "terminal:exit") {
      const socket = auth.getActiveClient()?.socket;
      if (socket?.subscriptions?.has(payload.id)) send(socket, { type: "terminal.exit", sessionId: payload.id, exitCode: payload.exitCode });
      stateHub.remove(payload.id);
      sizes.remove(payload.id);
    } else if (channel === "sessions:changed") {
      const socket = auth.getActiveClient()?.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        send(socket, { type: "sessions.changed", sessions: payload.map(toRuntimeSession) });
        send(socket, { type: "templates.changed", templates: toSavedTemplates(sessionStore, terminalManager) });
      }
    }
  }

  return {
    start,
    stop,
    updateConfig,
    getState: currentState,
    createPairing: auth.createPairing,
    listAudit: accessStore.listAudit,
    revokeDevice: auth.revokeDevice,
    disconnectActiveDevice: auth.disconnectActiveDevice,
    resizeFromDesktop: sizes.resizeFromDesktop,
    claimDesktopSize: sizes.claimDesktopSize,
    handleDesktopEvent,
    handleTerminalEvent: handleDesktopEvent,
    constants: { PROTOCOL_VERSION, PAIRING_TTL_MS, MOBILE_GRACE_MS }
  };
}

module.exports = {
  PROTOCOL_VERSION,
  PAIRING_TTL_MS,
  MOBILE_GRACE_MS,
  MAX_INPUT_BYTES,
  MAX_INPUT_BYTES_PER_SECOND,
  MAX_BUFFERED_OUTPUT_BYTES,
  sanitizeHostLabel,
  getMobileHostname,
  isPrivateIpv4,
  listPrivateInterfaces,
  createPairingUrls,
  launchMobileTemplate,
  createMobileRemoteService
};
