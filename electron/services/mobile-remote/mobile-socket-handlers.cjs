const { PROTOCOL_VERSION, MAX_INPUT_BYTES, MAX_INPUT_BYTES_PER_SECOND } = require("./mobile-protocol.cjs");
const { toRuntimeSession, toSavedTemplates, launchMobileTemplate } = require("./mobile-session-values.cjs");
const { createMobileGraphicalHandlers } = require("./mobile-graphical.cjs");
const { sessionOverview } = require("./mobile-session-overview.cjs");

function createMobileSocketHandlers({ terminalManager, sessionStore, agentSessionLauncher, graphicalService, codexPluginService, codexVersionService, projectSearchService, mcpConfigService, getAgentUsage, getOpenCodeVerifiedModels, getCodexVerifiedModels, getCodeBuddyVerifiedModels, codeBuddyPluginService, codeBuddyVersionService, openCodeVersionService, stateHub, now, auth, sizes, uploads, files, send, sendError, getAgentStatus, getWorkItems = () => null, getMobileMinimalMode = () => false, getGraphicalMenuConfig = () => ({}) }) {
  const { getSizeState, applySize } = sizes;
  const graphical = createMobileGraphicalHandlers({ terminalManager, graphicalService, codexPluginService, codexVersionService, projectSearchService, mcpConfigService, getAgentUsage, getOpenCodeVerifiedModels, getCodexVerifiedModels, getCodeBuddyVerifiedModels, codeBuddyPluginService, codeBuddyVersionService, openCodeVersionService, uploads, send, agentSessionLauncher });

  function sendReady(socket) {
    const sessions = terminalManager.listSessions();
    send(socket, {
      type: "ready",
      payload: {
        mobileGraphicalSessionMinimalMode: getMobileMinimalMode() === true,
        graphicalMenuSecondaryActions: getGraphicalMenuConfig(),
        deviceId: socket.mobileDevice.id,
        deviceName: socket.mobileDevice.name,
        sessions: sessions.map(toRuntimeSession),
        templates: toSavedTemplates(sessionStore, terminalManager)
      }
    });
    for (const session of sessions) {
      void sessionOverview(session, graphicalService, stateHub, getAgentStatus?.(session.id)).then(overview => {
        if (socket.authenticated && terminalManager.getSession(session.id))
          send(socket, { type: "session.overview", overview });
      }).catch(() => undefined);
    }
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
    graphical.release(socket);
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
      if (message.type === "work-items.request") {
        const operations = ["list", "get", "preview", "execute", "setFollowUp", "listAttempts", "getAttempt", "void", "restore", "resolveUncertain"];
        if (!requestId || !operations.includes(message.operation)) throw new Error("任务操作无效。");
        const service = getWorkItems();
        if (!service) throw new Error("任务服务尚未就绪。");
        const result = await service[message.operation](message.input);
        send(socket, { type: "work-items.result", requestId, result });
      } else if (message.type === "files.list") {
        const result = await files.list(message.path);
        send(socket, { type: "files.list.result", requestId, ...result });
      } else if (message.type === "files.download.prepare") {
        const result = await files.prepare(socket, message.path);
        send(socket, { type: "files.download.ready", requestId, ...result });
      } else if (message.type.startsWith("graphical.")) {
        await graphical.handle(socket, message);
      } else if (message.type === "terminal.subscribe") {
        await subscribeTerminal(socket, String(message.sessionId || ""), Number(message.lastSeq));
      } else if (message.type === "terminal.input") {
        if (terminalManager.getSession(String(message.sessionId || ""))?.runtimeMode === "app-server") throw new Error("图形会话不能接收终端输入。");
        const data = typeof message.data === "string" ? message.data : "";
        const bytes = Buffer.byteLength(data, "utf8");
        if (!data || bytes > MAX_INPUT_BYTES || !checkInputRate(socket, bytes)) throw new Error("终端输入过大或发送过快。");
        terminalManager.write(String(message.sessionId || ""), data);
      } else if (message.type === "quick-command.invoke") {
        const sessionId = String(message.sessionId || "");
        const session = terminalManager.getSession(sessionId);
        if (!session) throw new Error("会话不存在或已经结束。");
        const command = (session.quickCommands || []).find(value => value.id === message.commandId);
        if (!command || typeof command.command !== "string" || !command.command) throw new Error("快捷命令已失效，请刷新后重试。");
        const mode = command.mode || "write";
        if (!["write", "auto-enter", "one-time"].includes(mode)) throw new Error("快捷命令模式无效。");
        if (session.runtimeMode === "app-server") {
          if (socket.graphicalSessionId !== sessionId || !graphicalService) throw new Error("请先打开此图形会话。");
          const current = graphicalService.snapshot(sessionId);
          if (!current.threadId || current.threadId !== message.threadId || current.archived) throw new Error("对话已切换或已归档，请刷新后重试。");
          const blocked = require("./graphical-input-policy.cjs").graphicalSubmitError(current);
          if (blocked) throw new Error(blocked);
          if (mode === "auto-enter") await graphicalService.submit(sessionId, command.command, []);
        } else {
          if (typeof session.term?.write !== "function" || session.type === "ssh"
            && ["reconnecting", "disconnected"].includes(session.sshConnectionState))
            throw new Error("终端当前不可写入，请稍后重试。");
          const data = mode === "auto-enter" ? `${command.command}\r` : command.command;
          const bytes = Buffer.byteLength(data, "utf8");
          if (bytes > MAX_INPUT_BYTES || !checkInputRate(socket, bytes)) throw new Error("终端输入过大或发送过快。");
          terminalManager.write(sessionId, data);
        }
        if (mode === "one-time") {
          terminalManager.updateSession(sessionId, { quickCommands: session.quickCommands.filter(value => value.id !== command.id) });
        }
        send(socket, { type: "command.ok", requestId });
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
        graphical.release(socket);
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
        graphical.release(socket);
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
      const graphicalQuickCommand = message.type === "quick-command.invoke"
        && terminalManager.getSession(String(message.sessionId || ""))?.runtimeMode === "app-server";
      sendError(socket, message.type.startsWith("work-items.") ? "WORK_ITEM_COMMAND_FAILED" : message.type.startsWith("files.") ? "FILE_COMMAND_FAILED"
        : message.type.startsWith("graphical.") || graphicalQuickCommand ? "GRAPHICAL_COMMAND_FAILED" : "COMMAND_FAILED",
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
    socket.lastAliveAt = now();
    socket.remoteAddress = request.socket.remoteAddress || "unknown";
    socket.subscriptions = new Set();
    socket.graphicalSessionId = null;
    socket.on("pong", () => { socket.lastAliveAt = now(); });
    socket.on("message", (raw) => { socket.lastAliveAt = now(); handleSocketMessage(socket, raw); });
    socket.on("close", (code) => {
      graphical.release(socket);
      uploads?.releaseSocket(socket);
      files?.releaseSocket(socket);
      if (!socket.mobileCloseReason) socket.mobileCloseReason = Number.isInteger(code) ? `socket-close-${code}` : "socket-closed";
      auth.handleSocketClosed(socket);
    });
  }
  return { sendReady, handleWebSocket, handleGraphicalChanged: graphical.handleChanged,
    handleGraphicalAuth: graphical.handleAuthEvent, handleGraphicalDelta: graphical.handleDelta };
}

module.exports = { createMobileSocketHandlers };
