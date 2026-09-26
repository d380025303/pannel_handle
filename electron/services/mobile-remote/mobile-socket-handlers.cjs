const { PROTOCOL_VERSION, MAX_INPUT_BYTES, MAX_INPUT_BYTES_PER_SECOND } = require("./mobile-protocol.cjs");
const { toRuntimeSession, toSavedTemplates, launchMobileTemplate } = require("./mobile-session-values.cjs");
const { createMobileGraphicalHandlers } = require("./mobile-graphical.cjs");

function createMobileSocketHandlers({ terminalManager, sessionStore, agentSessionLauncher, graphicalService, getAgentUsage, stateHub, now, auth, sizes, uploads, send, sendError }) {
  const { getSizeState, applySize } = sizes;
  const graphical = createMobileGraphicalHandlers({ terminalManager, graphicalService, getAgentUsage, uploads, send });

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
    const session = terminalManager.getSession(sessionId);
    if (!session || session.runtimeMode === "app-server") {
      sendError(socket, "SESSION_NOT_FOUND", "会话不存在或已经结束。");
      return;
    }
    socket.subscriptions.clear();
    socket.graphicalSessionId = null;
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
      if (message.type.startsWith("graphical.")) {
        await graphical.handle(socket, message);
      } else if (message.type === "terminal.subscribe") {
        await subscribeTerminal(socket, String(message.sessionId || ""), Number(message.lastSeq));
      } else if (message.type === "terminal.input") {
        if (terminalManager.getSession(String(message.sessionId || ""))?.runtimeMode === "app-server") throw new Error("图形会话不能接收终端输入。");
        const data = typeof message.data === "string" ? message.data : "";
        const bytes = Buffer.byteLength(data, "utf8");
        if (!data || bytes > MAX_INPUT_BYTES || !checkInputRate(socket, bytes)) throw new Error("终端输入过大或发送过快。");
        terminalManager.write(String(message.sessionId || ""), data);
      } else if (message.type === "terminal.claim-size" || message.type === "terminal.resize") {
        const sessionId = String(message.sessionId || "");
        if (terminalManager.getSession(sessionId)?.runtimeMode === "app-server") throw new Error("图形会话没有终端尺寸。");
        const state = getSizeState(sessionId);
        if (message.type === "terminal.resize" && state.owner !== socket.mobileDevice.id) return;
        applySize(sessionId, socket.mobileDevice.id, message.cols, message.rows);
      } else if (message.type === "template.launch") {
        const template = sessionStore.getTemplate(String(message.templateId || ""));
        if (!template) throw new Error("模板不存在或已被删除。");
        const cols = Math.max(20, Math.min(500, Math.floor(Number(message.cols) || 100)));
        const rows = Math.max(5, Math.min(200, Math.floor(Number(message.rows) || 30)));
        const session = await launchMobileTemplate(agentSessionLauncher, template, cols, rows);
        socket.subscriptions.clear();
        socket.graphicalSessionId = null;
        send(socket, { type: "session.launched", sessionId: session.id });
        if (session.runtimeMode === "app-server") await graphical.handle(socket, { type: "graphical.subscribe", sessionId: session.id });
        else {
          applySize(session.id, socket.mobileDevice.id, cols, rows);
          await subscribeTerminal(socket, session.id);
        }
      } else if (message.type === "session.switch-agent") {
        const sessionId = graphical.assertSwitchAllowed(socket, message);
        const replacement = await agentSessionLauncher.switchAgent(sessionId, message.provider);
        uploads?.releaseSession(sessionId);
        if (replacement.agentProvider !== message.provider || replacement.runtimeMode !== "app-server")
          throw new Error("目标图形 Agent 未能启动，请查看当前会话状态。");
        socket.subscriptions.clear();
        socket.graphicalSessionId = replacement.id;
        send(socket, { type: "session.launched", sessionId: replacement.id });
        await graphical.handle(socket, { type: "graphical.subscribe", sessionId: replacement.id });
      } else if (message.type === "session.rename") {
        const title = String(message.title || "").trim();
        if (!title || title.length > 120) throw new Error("会话名称必须为 1 到 120 个字符。");
        terminalManager.updateSession(String(message.sessionId || ""), { title });
      } else if (message.type === "session.close") {
        uploads?.releaseSession(String(message.sessionId || ""));
        terminalManager.closeSession(String(message.sessionId || ""));
      } else if (message.type === "ping") {
        send(socket, { type: "pong", at: Number(message.at) || now() });
      } else {
        sendError(socket, "MESSAGE_NOT_ALLOWED", "该移动端操作不被允许。", requestId);
      }
    } catch (error) {
      sendError(socket, message.type.startsWith("graphical.") ? "GRAPHICAL_COMMAND_FAILED" : "COMMAND_FAILED",
        error.message || String(error), requestId);
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
      if (message?.v === 1) {
        socket.send(JSON.stringify({ v: 1, type: "error", code: "PROTOCOL_MISMATCH", message: "移动端已更新，请刷新手机页面。" }));
      } else sendError(socket, "PROTOCOL_MISMATCH", "移动端协议版本不兼容，请刷新页面。");
      return;
    }
    if (!socket.authenticated) {
      if (message.type === "password.login") {
        auth.handlePasswordLogin(socket, message);
      } else {
        sendError(socket, "AUTH_REQUIRED", "请先输入移动访问密码。");
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
    socket.graphicalSessionId = null;
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw) => handleSocketMessage(socket, raw));
    socket.on("close", () => {
      uploads?.releaseSocket(socket);
      auth.handleSocketClosed(socket);
    });
  }
  return { sendReady, handleWebSocket, handleGraphicalChanged: graphical.handleChanged };
}

module.exports = { createMobileSocketHandlers };
