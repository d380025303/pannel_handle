const crypto = require("node:crypto");

const PUSH_STATUSES = new Set(["waiting_for_permission", "e_prompt", "failed"]);
const STATUS_LABELS = {
  waiting_for_permission: "等待授权",
  e_prompt: "等待用户输入",
  failed: "执行失败"
};

function getProviderName(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "opencode") return "OpenCode";
  if (provider === "qoder") return "Qoder";
  return "Claude";
}

function validateDingTalkWebhook(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("请输入有效的钉钉机器人 Webhook。");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "oapi.dingtalk.com" ||
    url.pathname !== "/robot/send" ||
    !url.searchParams.get("access_token")
  ) {
    throw new Error("仅支持包含 access_token 的 HTTPS 钉钉自定义机器人 Webhook。");
  }
  return url;
}

function buildSignedWebhook(webhook, secret, timestamp) {
  const url = validateDingTalkWebhook(webhook);
  if (secret) {
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", sign);
  }
  return url.toString();
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildDingTalkMessage(payload, session) {
  const provider = getProviderName(payload.provider);
  const status = STATUS_LABELS[payload.status] || payload.status;
  const title = `[Pannel Handle] ${provider} ${status}`;
  const lines = [
    `### ${title}`,
    `- Agent：${provider}`,
    `- 状态：${status}`,
    `- 会话：${session.title}`
  ];
  if (payload.toolName) {
    lines.push(`- 工具：${payload.toolName}`);
  }
  lines.push(`- 时间：${formatTimestamp(payload.timestamp)}`);
  return {
    msgtype: "markdown",
    markdown: {
      title,
      text: lines.join("\n")
    }
  };
}

function createDingTalkNotificationManager({
  configStore,
  terminalManager,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger = console
}) {
  const lastStatusBySessionId = new Map();

  async function postMessage(credentials, message) {
    const timestamp = now();
    const url = buildSignedWebhook(credentials.webhook, credentials.secret, timestamp);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      throw new Error(`钉钉机器人请求失败（HTTP ${response.status}）。`);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("钉钉机器人返回了无效响应。");
    }
    if (result.errcode !== 0) {
      throw new Error(result.errmsg || `钉钉机器人返回错误码 ${result.errcode}。`);
    }
  }

  async function sendStatus(payload, session) {
    const credentials = configStore.getCredentials();
    await postMessage(credentials, buildDingTalkMessage(payload, session));
  }

  function handleStatus(payload) {
    const previousStatus = lastStatusBySessionId.get(payload.id);
    lastStatusBySessionId.set(payload.id, payload.status);
    if (previousStatus === payload.status || !PUSH_STATUSES.has(payload.status)) {
      return;
    }
    const config = configStore.getConfig();
    if (!config.enabled || !config.hasWebhook) {
      return;
    }
    const session = terminalManager.getSession(payload.id);
    if (!session) {
      return;
    }
    void sendStatus(payload, session).catch((err) => {
      logger.error("Failed to send DingTalk agent status:", err);
    });
  }

  function updateConfig(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("钉钉配置格式无效。");
    }
    const update = {};
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new Error("启用状态格式无效。");
      update.enabled = input.enabled;
    }
    if (input.webhook !== undefined) {
      if (typeof input.webhook !== "string") throw new Error("Webhook 格式无效。");
      update.webhook = validateDingTalkWebhook(input.webhook).toString();
    }
    if (input.secret !== undefined) {
      if (typeof input.secret !== "string") throw new Error("加签密钥格式无效。");
      update.secret = input.secret.trim();
    }
    const current = configStore.getConfig();
    if (update.enabled === true && !update.webhook && !current.hasWebhook) {
      throw new Error("启用钉钉通知前请先填写 Webhook。");
    }
    return configStore.updateConfig(update);
  }

  async function testConnection() {
    try {
      const config = configStore.getConfig();
      if (!config.hasWebhook) {
        throw new Error("请先保存钉钉机器人 Webhook。");
      }
      const credentials = configStore.getCredentials();
      await postMessage(credentials, {
        msgtype: "markdown",
        markdown: {
          title: "[Pannel Handle] 钉钉通知测试",
          text: "### [Pannel Handle] 钉钉通知测试\n机器人配置有效，状态通知已连接。"
        }
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function clearSession(sessionId) {
    lastStatusBySessionId.delete(sessionId);
  }

  return {
    handleStatus,
    updateConfig,
    clearCredentials: () => configStore.clearCredentials(),
    testConnection,
    clearSession,
    sendStatus
  };
}

module.exports = {
  PUSH_STATUSES,
  validateDingTalkWebhook,
  buildSignedWebhook,
  buildDingTalkMessage,
  createDingTalkNotificationManager
};
