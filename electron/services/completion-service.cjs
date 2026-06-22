const MAX_DRAFT_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_COMPLETION_CHARS = 2000;

function buildEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) throw new Error("智能补全 Base URL 必须使用 http 或 https。");
  return `${normalized}/chat/completions`;
}

function extractCompletion(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("模型返回了无效的补全结果。");
  return content.replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").slice(0, MAX_COMPLETION_CHARS);
}

function createCompletionService({
  configStore,
  fetchApi = globalThis.fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  isDebugEnabled = () => false,
  broadcastDebug = () => {}
}) {
  let nextDebugRequestId = 0;

  function emitDebug(payload) {
    if (!isDebugEnabled()) return;
    try {
      broadcastDebug(payload);
    } catch {
      // Debug telemetry must never affect completion behavior.
    }
  }

  async function request(messages, { requireEnabled = true, debugSessionId } = {}) {
    const config = configStore.getConfig();
    if (requireEnabled && !config.enabled) throw new Error("智能补全尚未启用。");
    if (!config.model) throw new Error("请先配置智能补全模型名称。");
    if (!config.hasApiKey) throw new Error("请先配置智能补全 API Key。");
    if (typeof fetchApi !== "function") throw new Error("当前环境不支持模型网络请求。");

    const { apiKey } = configStore.getCredentials();
    const url = buildEndpoint(config.baseUrl);
    const method = "POST";
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };
    const body = JSON.stringify({ model: config.model, messages, temperature: 0.2, max_tokens: 256 });
    const debugStartedAt = Date.now();
    const debugRequestId = debugSessionId && isDebugEnabled()
      ? `${debugStartedAt}-${++nextDebugRequestId}`
      : null;
    let debugCompleted = false;
    let receivedHttpStatus;
    let receivedResponseBody;
    if (debugRequestId) {
      emitDebug({
        requestId: debugRequestId,
        phase: "request",
        timestamp: debugStartedAt,
        sessionId: debugSessionId,
        request: {
          url,
          method,
          headers: { "Content-Type": headers["Content-Type"] },
          body
        }
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchApi(url, {
        method,
        headers,
        body,
        signal: controller.signal
      });
      const responseBody = await response.text();
      receivedHttpStatus = response.status;
      receivedResponseBody = responseBody;
      if (!response.ok) {
        const error = new Error(`模型请求失败（HTTP ${response.status}）${responseBody ? `：${responseBody.slice(0, 300)}` : ""}`);
        if (debugRequestId) {
          debugCompleted = true;
          emitDebug({
            requestId: debugRequestId,
            phase: "response",
            timestamp: Date.now(),
            sessionId: debugSessionId,
            durationMs: Date.now() - debugStartedAt,
            status: "error",
            httpStatus: response.status,
            responseBody,
            error: error.message
          });
        }
        throw error;
      }
      let payload;
      try {
        payload = JSON.parse(responseBody);
      } catch {
        throw new Error("模型返回了无效的 JSON 响应。");
      }
      const completion = extractCompletion(payload);
      if (debugRequestId) {
        debugCompleted = true;
        emitDebug({
          requestId: debugRequestId,
          phase: "response",
          timestamp: Date.now(),
          sessionId: debugSessionId,
          durationMs: Date.now() - debugStartedAt,
          status: "success",
          httpStatus: response.status,
          responseBody,
          completion
        });
      }
      return completion;
    } catch (err) {
      const error = err?.name === "AbortError"
        ? new Error("模型请求超时，请检查网络或服务地址。")
        : err;
      if (debugRequestId && !debugCompleted) {
        emitDebug({
          requestId: debugRequestId,
          phase: receivedHttpStatus == null ? "error" : "response",
          timestamp: Date.now(),
          sessionId: debugSessionId,
          durationMs: Date.now() - debugStartedAt,
          status: "error",
          httpStatus: receivedHttpStatus,
          responseBody: receivedResponseBody,
          error: error instanceof Error ? error.message : String(error || "Unknown error")
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function complete({ sessionId, draft, cursor }) {
    const normalizedDraft = String(draft || "").slice(0, MAX_DRAFT_CHARS);
    const normalizedCursor = Number.isInteger(cursor) && cursor >= 0 && cursor <= normalizedDraft.length
      ? cursor : normalizedDraft.length;
    if (!normalizedDraft.trim()) return { completion: "" };
    const context = {
      textBeforeCursor: normalizedDraft.slice(0, normalizedCursor),
      textAfterCursor: normalizedDraft.slice(normalizedCursor)
    };
    const completion = await request([
      {
        role: "system",
        content: "你负责补全用户正在编辑的输入。请只推断应精确插入光标位置的文本，确保光标后的现有文本仍然有效。仅返回待插入文本，不要解释，不要添加引号或 Markdown 代码块"
      },
      { role: "user", content: JSON.stringify(context) }
    ], { debugSessionId: sessionId });
    return { completion };
  }

  async function testConnection() {
    const completion = await request([
      { role: "system", content: "请仅返回 OK。" },
      { role: "user", content: "连接测试" }
    ], { requireEnabled: false });
    return completion.trim() ? { ok: true } : { ok: false, error: "模型返回了空响应。" };
  }

  return { complete, testConnection };
}

module.exports = { buildEndpoint, createCompletionService, extractCompletion };
