const { PROTOCOL_VERSION, MAX_INPUT_BYTES, MAX_INPUT_BYTES_PER_SECOND } = require("./mobile-protocol.cjs");
const { toRuntimeSession, toSavedTemplates, launchMobileTemplate } = require("./mobile-session-values.cjs");

function createMobileSocketHandlers({ terminalManager, sessionStore, agentSessionLauncher, stateHub, now, accessStore, auth, sizes, send, sendError }) {
  const { getSizeState, applySize } = sizes;

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
        void auth.handlePairRequest(socket, message);
      } else if (message.type === "auth") {
        if (!auth.allowAuthAttempt(socket.remoteAddress)) {
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
        auth.authenticateSocket(socket, device);
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
      auth.handleSocketClosed(socket);
    });
  }
  return { sendReady, handleWebSocket };
}

module.exports = { createMobileSocketHandlers };
