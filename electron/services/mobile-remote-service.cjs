const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Bonjour } = require("bonjour-service");
const QRCode = require("qrcode");
const { WebSocket, WebSocketServer } = require("ws");

const PROTOCOL_VERSION = 1;
const PAIRING_TTL_MS = 2 * 60 * 1000;
const MOBILE_GRACE_MS = 30 * 1000;
const HEARTBEAT_MS = 10 * 1000;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES_PER_SECOND = 256 * 1024;
const MAX_BUFFERED_OUTPUT_BYTES = 2 * 1024 * 1024;

function sanitizeHostLabel(input) {
  const value = String(input || "pc").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return value.slice(0, 45) || "pc";
}

function getMobileHostname() {
  return `pannel-handle-${sanitizeHostLabel(os.hostname())}.local`;
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function listPrivateInterfaces(networkInterfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, entries] of Object.entries(networkInterfaces)) {
    const ipv4 = (entries || []).find((entry) => entry.family === "IPv4" && !entry.internal && isPrivateIpv4(entry.address));
    if (ipv4) result.push({ name, address: ipv4.address });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function createPairingUrls(state, nonce) {
  return {
    url: `${state.fallbackUrl}/#pair=${nonce}`,
    fallbackUrl: `${state.canonicalUrl}/#pair=${nonce}`
  };
}

function toRuntimeSession(session) {
  return {
    id: session.id,
    templateId: session.templateId,
    title: session.title,
    type: session.type,
    cwd: session.cwd,
    tags: Array.isArray(session.tags) ? session.tags : []
  };
}

function toSavedTemplates(sessionStore, terminalManager) {
  const counts = new Map();
  for (const session of terminalManager.listSessions()) {
    if (session.templateId) counts.set(session.templateId, (counts.get(session.templateId) || 0) + 1);
  }
  return sessionStore.getLibrary().map((template) => ({
    id: template.id,
    title: template.title,
    type: template.type,
    cwd: template.cwd,
    wslDistro: template.wslDistro,
    sshEndpoint: template.type === "ssh" && template.sshConfig?.host
      ? `${template.sshConfig.username ? `${template.sshConfig.username}@` : ""}${template.sshConfig.host}:${template.sshConfig.port || 22}`
      : undefined,
    tags: Array.isArray(template.tags) ? template.tags : [],
    runningCount: counts.get(template.id) || 0
  }));
}

function launchMobileTemplate(agentSessionLauncher, template, cols, rows) {
  return agentSessionLauncher.launchSession(template, { cols, rows, recordUsage: true });
}

function createMobileRemoteService({
  terminalManager,
  agentSessionLauncher,
  sessionStore,
  accessStore,
  stateHub,
  getStaticRoot,
  desktopBroadcast,
  confirmPairing,
  notifyConnection,
  now = () => Date.now(),
  networkInterfaces = () => os.networkInterfaces()
}) {
  let server = null;
  let webSocketServer = null;
  let bonjour = null;
  let bonjourService = null;
  let heartbeatTimer = null;
  let currentAddress = "";
  let lastError = "";
  let activeClient = null;
  const pairingNonces = new Map();
  const authAttempts = new Map();
  const sizes = new Map();

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

  function getSizeState(sessionId) {
    let state = sizes.get(sessionId);
    if (!state) {
      const session = terminalManager.getSession(sessionId);
      const cols = Number(session?.cols || session?.term?.cols || 100);
      const rows = Number(session?.rows || session?.term?.rows || 30);
      state = { owner: "desktop", cols, rows, lastDesktop: { cols, rows } };
      sizes.set(sessionId, state);
    }
    return state;
  }

  function publishSize(sessionId) {
    const state = getSizeState(sessionId);
    const payload = { sessionId, owner: state.owner, cols: state.cols, rows: state.rows };
    desktopBroadcast("terminal:size-owner", payload);
    const socket = activeClient?.socket;
    if (socket?.subscriptions?.has(sessionId)) send(socket, { type: "terminal.size-owner", ...payload });
  }

  function applySize(sessionId, owner, cols, rows) {
    const session = terminalManager.getSession(sessionId);
    if (!session) throw new Error("会话不存在或已经结束。");
    const nextCols = Math.max(20, Math.min(500, Math.floor(Number(cols))));
    const nextRows = Math.max(5, Math.min(200, Math.floor(Number(rows))));
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) throw new Error("终端尺寸无效。");
    const state = getSizeState(sessionId);
    state.owner = owner;
    state.cols = nextCols;
    state.rows = nextRows;
    if (owner === "desktop") state.lastDesktop = { cols: nextCols, rows: nextRows };
    else state.lastMobile = { cols: nextCols, rows: nextRows };
    terminalManager.resize(sessionId, nextCols, nextRows);
    stateHub.resize(sessionId, nextCols, nextRows);
    publishSize(sessionId);
  }

  function resizeFromDesktop(sessionId, cols, rows) {
    const state = getSizeState(sessionId);
    state.lastDesktop = { cols, rows };
    if (state.owner === "desktop") applySize(sessionId, "desktop", cols, rows);
  }

  function claimDesktopSize(sessionId, cols, rows) {
    applySize(sessionId, "desktop", cols, rows);
  }

  function releaseDeviceSizes(deviceId) {
    for (const [sessionId, state] of sizes) {
      if (state.owner !== deviceId || !terminalManager.getSession(sessionId)) continue;
      const fallback = state.lastDesktop || { cols: 100, rows: 30 };
      applySize(sessionId, "desktop", fallback.cols, fallback.rows);
    }
  }

  function currentState() {
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

  function verifyRequestHost(request) {
    const config = accessStore.getConfig();
    const allowed = new Set([`${currentAddress}:${config.port}`, `${getMobileHostname()}:${config.port}`]);
    const host = String(request.headers.host || "").toLowerCase();
    if (!allowed.has(host)) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  function setSecurityHeaders(response) {
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
  }

  function contentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" })[extension] || "application/octet-stream";
  }

  function handleHttp(request, response) {
    setSecurityHeaders(response);
    if (!verifyRequestHost(request)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Forbidden");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
    if (requestUrl.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
      return;
    }
    const staticRoot = path.resolve(getStaticRoot());
    const relative = requestUrl.pathname === "/" ? "index.html" : decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    const candidate = path.resolve(staticRoot, relative);
    const target = candidate.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(staticRoot, "index.html");
    if (!target.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(target)) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("移动端资源尚未构建，请先在项目根目录执行 corepack pnpm build:mobile。");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType(target),
      "Cache-Control": path.basename(target) === "index.html" ? "no-store" : "public, max-age=31536000, immutable"
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(target).pipe(response);
  }

  function allowAuthAttempt(ip) {
    const cutoff = now() - 60_000;
    const attempts = (authAttempts.get(ip) || []).filter((at) => at >= cutoff);
    if (attempts.length >= 5) return false;
    attempts.push(now());
    authAttempts.set(ip, attempts);
    return true;
  }

  function sendReady(socket) {
    send(socket, {
      type: "ready",
      payload: {
        deviceId: socket.mobileDevice.id,
        deviceName: socket.mobileDevice.name,
        sessions: terminalManager.listSessions().map(toRuntimeSession),
        templates: toSavedTemplates(sessionStore, terminalManager)
      }
    });
  }

  function releaseActiveClient(reason, immediate = false) {
    if (!activeClient) return;
    const client = activeClient;
    if (client.releaseTimer) clearTimeout(client.releaseTimer);
    const finish = () => {
      if (activeClient !== client) return;
      releaseDeviceSizes(client.device.id);
      accessStore.recordAudit("connection.disconnected", { deviceId: client.device.id, deviceName: client.device.name, reason });
      activeClient = null;
      broadcastState();
    };
    if (immediate) finish();
    else {
      client.graceUntil = now() + MOBILE_GRACE_MS;
      client.releaseTimer = setTimeout(finish, MOBILE_GRACE_MS);
      broadcastState();
    }
  }

  function authenticateSocket(socket, device) {
    if (activeClient && activeClient.device.id !== device.id) {
      sendError(socket, "DEVICE_BUSY", `“${activeClient.device.name}”仍在线，请稍后再试。`);
      accessStore.recordAudit("connection.rejected", { deviceId: device.id, deviceName: device.name, reason: "device-busy" });
      socket.close(1008, "Another mobile device is active");
      return false;
    }
    if (activeClient?.releaseTimer) clearTimeout(activeClient.releaseTimer);
    if (activeClient?.socket && activeClient.socket !== socket) activeClient.socket.close(1000, "同一设备已重新连接");
    const reconnecting = Boolean(activeClient);
    activeClient = activeClient || { device, subscriptions: new Set() };
    activeClient.device = device;
    activeClient.socket = socket;
    activeClient.graceUntil = 0;
    activeClient.releaseTimer = null;
    socket.mobileDevice = device;
    socket.authenticated = true;
    socket.subscriptions = activeClient.subscriptions;
    accessStore.recordAudit("connection.accepted", { deviceId: device.id, deviceName: device.name, reconnecting });
    if (!reconnecting) notifyConnection(device);
    sendReady(socket);
    broadcastState();
    return true;
  }

  async function handlePairRequest(socket, message) {
    const pairing = pairingNonces.get(message.nonce);
    if (!pairing || pairing.used || pairing.expiresAt < now()) {
      sendError(socket, "PAIR_INVALID", "配对二维码已失效，请在电脑端重新生成。");
      return;
    }
    pairing.used = true;
    const deviceName = String(message.deviceName || "Android Chrome").trim().slice(0, 80) || "Android Chrome";
    const verificationCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const requestId = crypto.randomUUID();
    send(socket, { type: "pair.pending", requestId, verificationCode });
    accessStore.recordAudit("pair.requested", { deviceName, remoteAddress: socket.remoteAddress });
    const accepted = await confirmPairing({ deviceName, verificationCode });
    if (!accepted || socket.readyState !== WebSocket.OPEN) {
      if (socket.readyState === WebSocket.OPEN) send(socket, { type: "pair.rejected", reason: "电脑端未允许本次配对。" });
      accessStore.recordAudit("pair.rejected", { deviceName });
      return;
    }
    try {
      const approved = accessStore.addDevice(deviceName);
      send(socket, { type: "pair.approved", deviceId: approved.device.id, deviceName: approved.device.name, token: approved.token });
      authenticateSocket(socket, approved.device);
    } catch (error) {
      sendError(socket, "PAIR_STORAGE_FAILED", error.message || String(error));
    }
  }

  function checkInputRate(socket, bytes) {
    const at = now();
    if (!socket.inputWindow || at - socket.inputWindow.startedAt >= 1000) socket.inputWindow = { startedAt: at, bytes: 0 };
    socket.inputWindow.bytes += bytes;
    return socket.inputWindow.bytes <= MAX_INPUT_BYTES_PER_SECOND;
  }

  async function subscribeTerminal(socket, sessionId, lastSeq) {
    if (!terminalManager.getSession(sessionId)) {
      sendError(socket, "SESSION_NOT_FOUND", "会话不存在或已经结束。");
      return;
    }
    socket.subscriptions.clear();
    socket.subscriptions.add(sessionId);
    const deltas = stateHub.getDeltas(sessionId, lastSeq);
    if (deltas !== null && Number.isSafeInteger(lastSeq)) {
      for (const event of deltas) send(socket, { type: "terminal.data", sessionId, data: event.data, seq: event.seq });
      const size = getSizeState(sessionId);
      send(socket, { type: "terminal.size-owner", sessionId, owner: size.owner, cols: size.cols, rows: size.rows });
      return;
    }
    const snapshot = await stateHub.getSnapshot(sessionId, getSizeState(sessionId).owner);
    if (snapshot) send(socket, { type: "terminal.snapshot", snapshot });
  }

  async function handleAuthenticatedMessage(socket, message) {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    try {
      if (message.type === "terminal.subscribe") {
        await subscribeTerminal(socket, String(message.sessionId || ""), Number(message.lastSeq));
      } else if (message.type === "terminal.input") {
        const data = typeof message.data === "string" ? message.data : "";
        const bytes = Buffer.byteLength(data, "utf8");
        if (!data || bytes > MAX_INPUT_BYTES || !checkInputRate(socket, bytes)) throw new Error("终端输入过大或发送过快。");
        terminalManager.write(String(message.sessionId || ""), data);
      } else if (message.type === "terminal.claim-size" || message.type === "terminal.resize") {
        const sessionId = String(message.sessionId || "");
        const state = getSizeState(sessionId);
        if (message.type === "terminal.resize" && state.owner !== socket.mobileDevice.id) return;
        applySize(sessionId, socket.mobileDevice.id, message.cols, message.rows);
      } else if (message.type === "template.launch") {
        const template = sessionStore.getTemplate(String(message.templateId || ""));
        if (!template) throw new Error("模板不存在或已被删除。");
        const cols = Math.max(20, Math.min(500, Math.floor(Number(message.cols) || 100)));
        const rows = Math.max(5, Math.min(200, Math.floor(Number(message.rows) || 30)));
        const session = await launchMobileTemplate(agentSessionLauncher, template, cols, rows);
        applySize(session.id, socket.mobileDevice.id, cols, rows);
        socket.subscriptions.clear();
        socket.subscriptions.add(session.id);
        send(socket, { type: "session.launched", sessionId: session.id });
        await subscribeTerminal(socket, session.id);
      } else if (message.type === "session.rename") {
        const title = String(message.title || "").trim();
        if (!title || title.length > 120) throw new Error("会话名称必须为 1 到 120 个字符。");
        terminalManager.updateSession(String(message.sessionId || ""), { title });
      } else if (message.type === "session.close") {
        terminalManager.closeSession(String(message.sessionId || ""));
      } else if (message.type === "ping") {
        send(socket, { type: "pong", at: Number(message.at) || now() });
      } else {
        sendError(socket, "MESSAGE_NOT_ALLOWED", "该移动端操作不被允许。", requestId);
      }
    } catch (error) {
      sendError(socket, "COMMAND_FAILED", error.message || String(error), requestId);
    }
  }

  function handleSocketMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      sendError(socket, "INVALID_JSON", "消息不是有效 JSON。");
      return;
    }
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== "string") {
      sendError(socket, "PROTOCOL_MISMATCH", "移动端协议版本不兼容。");
      return;
    }
    if (!socket.authenticated) {
      if (message.type === "pair.request") {
        void handlePairRequest(socket, message);
      } else if (message.type === "auth") {
        if (!allowAuthAttempt(socket.remoteAddress)) {
          sendError(socket, "AUTH_RATE_LIMIT", "认证尝试过多，请稍后再试。");
          socket.close(1008, "Rate limited");
          return;
        }
        const device = accessStore.verifyDevice(String(message.deviceId || ""), String(message.token || ""));
        if (!device) {
          sendError(socket, "AUTH_INVALID", "设备凭据无效或已被撤销。");
          accessStore.recordAudit("connection.rejected", { remoteAddress: socket.remoteAddress, reason: "invalid-auth" });
          socket.close(1008, "Invalid credentials");
          return;
        }
        authenticateSocket(socket, device);
      } else {
        sendError(socket, "AUTH_REQUIRED", "请先完成设备认证。");
      }
      return;
    }
    void handleAuthenticatedMessage(socket, message);
  }

  function handleWebSocket(socket, request) {
    socket.authenticated = false;
    socket.isAlive = true;
    socket.remoteAddress = request.socket.remoteAddress || "unknown";
    socket.subscriptions = new Set();
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw) => handleSocketMessage(socket, raw));
    socket.on("close", () => {
      if (activeClient?.socket === socket) {
        activeClient.socket = null;
        releaseActiveClient("socket-closed", false);
      }
    });
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
    server = http.createServer(handleHttp);
    webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/api/v1/ws" || !verifyRequestHost(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (ws) => handleWebSocket(ws, request));
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
    bonjour = new Bonjour();
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
      for (const [nonce, pairing] of pairingNonces) {
        if (pairing.expiresAt < now()) pairingNonces.delete(nonce);
      }
    }, HEARTBEAT_MS);
    broadcastState();
    return currentState();
  }

  async function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (activeClient?.socket) activeClient.socket.close(1001, "电脑端已关闭移动访问");
    releaseActiveClient("service-stopped", true);
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
    pairingNonces.clear();
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

  async function createPairing() {
    if (!server?.listening) throw new Error("请先启用移动访问服务。");
    const nonce = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now() + PAIRING_TTL_MS;
    pairingNonces.set(nonce, { expiresAt, used: false });
    const state = currentState();
    const { url, fallbackUrl } = createPairingUrls(state, nonce);
    return { url, fallbackUrl, expiresAt, qrDataUrl: await QRCode.toDataURL(url, { width: 280, margin: 1 }) };
  }

  function handleTerminalEvent(channel, payload) {
    if (channel === "terminal:started") {
      stateHub.start(payload.id, payload.cols, payload.rows);
      sizes.set(payload.id, { owner: "desktop", cols: payload.cols, rows: payload.rows, lastDesktop: { cols: payload.cols, rows: payload.rows } });
    } else if (channel === "terminal:data") {
      const seq = stateHub.write(payload.id, payload.data);
      const socket = activeClient?.socket;
      if (socket?.subscriptions?.has(payload.id)) send(socket, { type: "terminal.data", sessionId: payload.id, data: payload.data, seq });
    } else if (channel === "terminal:resized") {
      stateHub.resize(payload.id, payload.cols, payload.rows);
      const state = getSizeState(payload.id);
      state.cols = payload.cols;
      state.rows = payload.rows;
      publishSize(payload.id);
    } else if (channel === "terminal:exit") {
      const socket = activeClient?.socket;
      if (socket?.subscriptions?.has(payload.id)) send(socket, { type: "terminal.exit", sessionId: payload.id, exitCode: payload.exitCode });
      stateHub.remove(payload.id);
      sizes.delete(payload.id);
    } else if (channel === "sessions:changed") {
      const socket = activeClient?.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        send(socket, { type: "sessions.changed", sessions: payload.map(toRuntimeSession) });
        send(socket, { type: "templates.changed", templates: toSavedTemplates(sessionStore, terminalManager) });
      }
    }
  }

  function revokeDevice(deviceId) {
    const revoked = accessStore.revokeDevice(deviceId);
    if (revoked && activeClient?.device.id === deviceId) {
      sendError(activeClient.socket, "DEVICE_REVOKED", "本设备的信任已被电脑端撤销。");
      activeClient.socket?.close(1008, "Device revoked");
      releaseActiveClient("device-revoked", true);
    }
    broadcastState();
    return currentState();
  }

  function disconnectActiveDevice() {
    if (activeClient?.socket) activeClient.socket.close(1000, "电脑端主动断开");
    releaseActiveClient("desktop-disconnect", true);
    return currentState();
  }

  return {
    start,
    stop,
    updateConfig,
    getState: currentState,
    createPairing,
    listAudit: accessStore.listAudit,
    revokeDevice,
    disconnectActiveDevice,
    resizeFromDesktop,
    claimDesktopSize,
    handleTerminalEvent,
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
