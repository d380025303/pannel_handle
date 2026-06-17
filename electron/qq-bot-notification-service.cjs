const DEFAULT_API_BASE_URL = "https://api.sgroup.qq.com";
const DEFAULT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const NOTIFY_STATUSES = new Set(["waiting_for_permission", "completed", "failed", "ended"]);
const PASSIVE_REPLY_WINDOW_MS = 5 * 60 * 1000;
const MAX_QUEUE_SIZE = 50;
const GROUP_AND_C2C_EVENT_INTENT = 1 << 25;

const STATUS_LABELS = {
  waiting_for_permission: "等待确认",
  completed: "已完成",
  failed: "失败",
  ended: "已结束"
};

function getProviderName(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "opencode") return "OpenCode";
  if (provider === "qoder") return "Qoder";
  return "Claude";
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms, setTimeoutFn = setTimeout) {
  return new Promise(resolve => setTimeoutFn(resolve, ms));
}

function createQqBotNotificationService({
  configStore,
  terminalManager,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  tokenUrl = DEFAULT_TOKEN_URL,
  passiveReplyWindowMs = PASSIVE_REPLY_WINDOW_MS
}) {
  const lastStatusBySessionId = new Map();
  const queue = [];
  let droppedCount = 0;
  let accessToken = null;
  let accessTokenExpiresAt = 0;
  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let lastSeq = null;
  let lastInboundAt = 0;
  let lastMessageId = "";
  let lastOpenid = "";
  let lastError = "";
  let lastSentAt = 0;
  let connected = false;
  let msgSeq = 1;
  let flushing = false;

  function getConfig() {
    return configStore.getQqBotConfig();
  }

  function setError(message) {
    lastError = message;
    if (message) {
      logger.error("QQ bot notification:", message);
    }
  }

  function clearError() {
    lastError = "";
  }

  function getStatus() {
    const config = getConfig();
    return {
      enabled: config.enabled,
      connected,
      targetOpenid: config.targetOpenid || lastOpenid,
      hasClientSecret: Boolean(config.clientSecret || config.clientSecretEncrypted),
      queuedCount: queue.length,
      droppedCount,
      lastError,
      lastInboundAt,
      lastSentAt
    };
  }

  function canSendNow(config = getConfig()) {
    const targetOpenid = config.targetOpenid || lastOpenid;
    return Boolean(
      config.enabled &&
      config.appId &&
      config.clientSecret &&
      targetOpenid &&
      lastMessageId &&
      now() - lastInboundAt <= passiveReplyWindowMs
    );
  }

  async function requestJson(url, options) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available in this Electron runtime.");
    }
    const response = await fetchImpl(url, options);
    const text = await response.text();
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { message: text };
      }
    }
    if (!response.ok) {
      const message = json.message || json.error_description || json.error || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return json;
  }

  async function getAccessToken() {
    const config = getConfig();
    if (!config.appId || !config.clientSecret) {
      throw new Error("QQ bot AppID or client secret is not configured.");
    }
    if (accessToken && now() < accessTokenExpiresAt - 60_000) {
      return accessToken;
    }
    const data = await requestJson(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: config.appId,
        clientSecret: config.clientSecret
      })
    });
    const token = data.access_token || data.accessToken;
    if (!token) {
      throw new Error("QQ bot access token response did not include access_token.");
    }
    const expiresIn = Number(data.expires_in || data.expiresIn || 7200);
    accessToken = token;
    accessTokenExpiresAt = now() + Math.max(60, expiresIn) * 1000;
    return accessToken;
  }

  async function sendText(content, options = {}) {
    const config = getConfig();
    const targetOpenid = options.targetOpenid || config.targetOpenid || lastOpenid;
    const messageId = options.messageId || lastMessageId;
    if (!targetOpenid) {
      throw new Error("QQ bot target openid is not available.");
    }
    if (!messageId) {
      throw new Error("需要先给机器人发送一条消息，才能使用官方单聊回复窗口。");
    }
    const token = await getAccessToken();
    await requestJson(`${apiBaseUrl}/v2/users/${encodeURIComponent(targetOpenid)}/messages`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        msg_type: 0,
        content,
        msg_id: messageId,
        msg_seq: msgSeq++
      })
    });
    lastSentAt = now();
    clearError();
  }

  function buildStatusMessage(payload) {
    const session = terminalManager.getSession(payload.id);
    const providerName = getProviderName(payload.provider);
    const label = STATUS_LABELS[payload.status] || payload.status;
    const lines = [
      `[Pannel Handle] ${providerName} ${label}`,
      `会话: ${session?.title || payload.id}`
    ];
    if (payload.toolName) {
      lines.push(`工具: ${payload.toolName}`);
    }
    if (payload.message) {
      lines.push(`消息: ${String(payload.message).slice(0, 240)}`);
    }
    return lines.join("\n");
  }

  function trimQueue() {
    while (queue.length > MAX_QUEUE_SIZE) {
      queue.shift();
      droppedCount += 1;
    }
  }

  function enqueue(text, status) {
    if (status === "waiting_for_permission") {
      queue.unshift({ text, status, queuedAt: now() });
    } else {
      queue.push({ text, status, queuedAt: now() });
    }
    trimQueue();
  }

  function buildQueueDigest() {
    const lines = [];
    if (droppedCount > 0) {
      lines.push(`[Pannel Handle] ${droppedCount} 条较早 QQ 通知已省略`);
    }
    while (queue.length > 0) {
      const next = queue.shift();
      const nextLines = [...lines, next.text];
      if (nextLines.join("\n\n").length > 1800 && lines.length > 0) {
        queue.unshift(next);
        break;
      }
      lines.push(next.text);
    }
    droppedCount = 0;
    return lines.join("\n\n");
  }

  async function flushQueue() {
    if (flushing || queue.length === 0 || !canSendNow()) {
      return;
    }
    flushing = true;
    try {
      while (queue.length > 0 && canSendNow()) {
        const digest = buildQueueDigest();
        if (!digest) break;
        await sendText(digest);
        if (queue.length > 0) {
          await sleep(500, setTimeoutFn);
        }
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      flushing = false;
    }
  }

  async function handleStatus(payload) {
    const config = getConfig();
    if (!config.enabled) {
      return;
    }

    const previousStatus = lastStatusBySessionId.get(payload.id);
    lastStatusBySessionId.set(payload.id, payload.status);
    if (
      previousStatus === payload.status ||
      !NOTIFY_STATUSES.has(payload.status) ||
      !config.notifyStatuses.includes(payload.status)
    ) {
      return;
    }

    const text = buildStatusMessage(payload);
    if (!canSendNow(config)) {
      if (config.queueWhenUnavailable) {
        enqueue(text, payload.status);
      }
      return;
    }

    try {
      await sendText(text);
    } catch (err) {
      setError(getErrorMessage(err));
      if (config.queueWhenUnavailable) {
        enqueue(text, payload.status);
      }
    }
  }

  function clearSession(sessionId) {
    lastStatusBySessionId.delete(sessionId);
  }

  function getOpenid(payload) {
    return payload?.author?.user_openid ||
      payload?.author?.openid ||
      payload?.user_openid ||
      payload?.openid ||
      payload?.user?.openid ||
      "";
  }

  function getMessageId(payload) {
    return payload?.id || payload?.msg_id || payload?.message_id || "";
  }

  function handleInboundEvent(eventName, payload) {
    if (!["C2C_MESSAGE_CREATE", "FRIEND_ADD", "C2C_MSG_RECEIVE"].includes(eventName)) {
      return;
    }
    const openid = getOpenid(payload);
    const config = getConfig();
    if (config.targetOpenid && openid && openid !== config.targetOpenid) {
      return;
    }
    if (openid) {
      lastOpenid = openid;
    }
    const messageId = getMessageId(payload);
    if (messageId) {
      lastMessageId = messageId;
    }
    lastInboundAt = now();
    return flushQueue();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleHeartbeat(interval) {
    stopHeartbeat();
    heartbeatTimer = setTimeoutFn(() => {
      try {
        ws?.send(JSON.stringify({ op: 1, d: lastSeq }));
      } catch (err) {
        setError(getErrorMessage(err));
      }
      scheduleHeartbeat(interval);
    }, interval);
  }

  async function identifyGateway() {
    const config = getConfig();
    const token = await getAccessToken();
    ws?.send(JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: GROUP_AND_C2C_EVENT_INTENT,
        shard: [0, 1],
        properties: {
          os: process.platform,
          browser: "pannel-handle",
          device: "pannel-handle"
        },
        app_id: config.appId
      }
    }));
  }

  function scheduleReconnect() {
    if (reconnectTimer || !getConfig().enabled) {
      return;
    }
    const delay = Math.min(30_000, 1000 * (2 ** reconnectAttempts));
    reconnectAttempts += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      void connectGateway();
    }, delay);
  }

  function closeWebSocket() {
    stopHeartbeat();
    if (ws) {
      try {
        ws.close();
      } catch {
        // best effort
      }
      ws = null;
    }
    connected = false;
  }

  function handleGatewayMessage(rawData) {
    let packet;
    try {
      packet = JSON.parse(String(rawData));
    } catch {
      return;
    }
    if (packet.s !== undefined && packet.s !== null) {
      lastSeq = packet.s;
    }
    if (packet.op === 10) {
      scheduleHeartbeat(Number(packet.d?.heartbeat_interval || 45_000));
      void identifyGateway().catch(err => setError(getErrorMessage(err)));
      return;
    }
    if (packet.op === 0) {
      if (packet.t === "READY") {
        connected = true;
        reconnectAttempts = 0;
        clearError();
      }
      handleInboundEvent(packet.t, packet.d || {});
    }
  }

  async function connectGateway() {
    const config = getConfig();
    if (!config.enabled || !config.appId || !config.clientSecret) {
      closeWebSocket();
      return;
    }
    if (typeof WebSocketImpl !== "function") {
      setError("WebSocket is not available in this Electron runtime.");
      return;
    }
    try {
      const token = await getAccessToken();
      const gateway = await requestJson(`${apiBaseUrl}/gateway`, {
        method: "GET",
        headers: {
          authorization: `QQBot ${token}`
        }
      });
      const gatewayUrl = typeof gateway === "string" ? gateway : gateway.url;
      if (!gatewayUrl) {
        throw new Error("QQ bot gateway response did not include url.");
      }
      closeWebSocket();
      ws = new WebSocketImpl(gatewayUrl);
      ws.onmessage = event => handleGatewayMessage(event.data);
      ws.onopen = () => {
        clearError();
      };
      ws.onerror = () => {
        setError("QQ bot WebSocket connection failed.");
      };
      ws.onclose = () => {
        connected = false;
        stopHeartbeat();
        scheduleReconnect();
      };
    } catch (err) {
      setError(getErrorMessage(err));
      scheduleReconnect();
    }
  }

  function start() {
    void connectGateway();
  }

  function applyConfig() {
    accessToken = null;
    accessTokenExpiresAt = 0;
    closeWebSocket();
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    start();
  }

  async function testSend() {
    const config = getConfig();
    if (!config.enabled) {
      return { ok: false, error: "QQ 机器人通知未启用。", status: getStatus() };
    }
    if (!canSendNow(config)) {
      return { ok: false, error: "需要先给机器人发送一条消息。", status: getStatus() };
    }
    try {
      await sendText("[Pannel Handle] QQ 机器人通知测试");
      return { ok: true, status: getStatus() };
    } catch (err) {
      const error = getErrorMessage(err);
      setError(error);
      return { ok: false, error, status: getStatus() };
    }
  }

  function shutdown() {
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    closeWebSocket();
    queue.length = 0;
    lastStatusBySessionId.clear();
  }

  return {
    start,
    applyConfig,
    handleStatus,
    clearSession,
    handleGatewayMessage,
    handleInboundEvent,
    flushQueue,
    testSend,
    getStatus,
    shutdown
  };
}

module.exports = {
  GROUP_AND_C2C_EVENT_INTENT,
  createQqBotNotificationService
};
