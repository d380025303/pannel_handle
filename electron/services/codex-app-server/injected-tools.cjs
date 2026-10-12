const MAX_BYTES = 256 * 1024;
const failure = text => ({ success: false, contentItems: [{ type: "inputText", text }] });

function createInjectedTools({ config, sessionId, current, respond, fetchRequest = fetch }) {
  const pending = new Map();
  const seen = new Set();
  const definitions = config?.tools.map(tool => ({ type: "function", ...tool })) || [];
  async function call(requestId, params) {
    if (!current(params)) { respond(requestId, failure("工具调用不属于当前活动回合。")); return; }
    if (!config || params.namespace || !config.tools.some(tool => tool.name === params.tool)) {
      respond(requestId, failure("工具未注册或回调配置已失效，请重新创建实例。")); return;
    }
    if (typeof params.callId !== "string" || !params.callId || !Object.hasOwn(params, "arguments")) { respond(requestId, failure("无效的工具调用。")); return; }
    const key = JSON.stringify([params.threadId, params.turnId, params.callId]);
    if (seen.has(key)) { respond(requestId, failure("重复工具调用已拒绝，回调不会重试。")); return; }
    seen.add(key);
    const controller = new AbortController();
    pending.set(key, controller);
    const timer = setTimeout(() => controller.abort(), config.toolCallback.timeoutMs);
    let result;
    try {
      const body = JSON.stringify({ sessionId, threadId: params.threadId, turnId: params.turnId,
        callId: params.callId, tool: params.tool, arguments: params.arguments });
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error();
      const response = await fetchRequest(config.toolCallback.url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(config.toolCallback.bearerToken
          ? { Authorization: `Bearer ${config.toolCallback.bearerToken}` } : {}) }, body });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(); }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) { controller.abort(); throw new Error(); }
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof value.success !== "boolean" || typeof value.output !== "string") throw new Error();
      result = { success: value.success, contentItems: [{ type: "inputText", text: value.output }] };
    } catch {
      result = failure(controller.signal.aborted ? "工具回调超时或已取消。" : "工具回调失败：网络、状态或响应格式无效。");
    } finally { clearTimeout(timer); }
    // Cancellation removes ownership before a late callback can write to the transport.
    if (pending.get(key) !== controller) return;
    pending.delete(key);
    if (current(params)) respond(requestId, result);
  }
  function cancel() {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  }
  function revoke() { cancel(); config = undefined; definitions.length = 0; seen.clear(); }
  const ownsRequest = params => {
    const controller = pending.get(JSON.stringify([params.threadId, params.turnId, params.callId]));
    return Boolean(controller && !controller.signal.aborted);
  };
  return { definitions, call, cancel, revoke, ownsRequest };
}

module.exports = { createInjectedTools };
