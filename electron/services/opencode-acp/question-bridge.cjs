const http = require("node:http");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const MAX_BODY_BYTES = 256 * 1024;
const TOOL = {
  name: "ask_user_question",
  description: "Ask the user one or more questions and wait for their answers. Use this tool whenever a decision, missing detail, or approval requires user input. Each question can offer choices and allow a custom answer.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["questions"],
    properties: { questions: { type: "array", minItems: 1, items: {
      type: "object", additionalProperties: false, required: ["question"],
      properties: {
        id: { type: "string" }, header: { type: "string" }, question: { type: "string" },
        multiSelect: { type: "boolean" }, allowCustomAnswer: { type: "boolean" },
        options: { type: "array", items: { type: "object", additionalProperties: false, required: ["label"],
          properties: { label: { type: "string" }, description: { type: "string" } } } }
      }
    } } }
  }
};

function normalizeQuestions(input) {
  if (!Array.isArray(input) || input.length < 1) throw new Error("请至少提供一个问题。");
  const ids = new Set();
  return input.map((item, index) => {
    const question = typeof item?.question === "string" ? item.question.trim() : "";
    const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `q_${index}`;
    if (!question || ids.has(id) || ["__proto__", "constructor", "prototype"].includes(id))
      throw new Error("问题内容或 ID 无效。");
    ids.add(id);
    const options = Array.isArray(item.options) ? item.options.map(option => ({
      label: typeof option?.label === "string" ? option.label.trim() : "",
      description: typeof option?.description === "string" ? option.description.trim() : ""
    })) : [];
    if (options.some(option => !option.label) || new Set(options.map(option => option.label)).size !== options.length)
      throw new Error("问题选项无效。");
    return { id, header: typeof item.header === "string" ? item.header.trim() : "", question,
      multiSelect: item.multiSelect === true, isOther: item.allowCustomAnswer !== false || options.length === 0,
      options };
  });
}

function wslHost(distro, runCommand) {
  const result = runCommand("wsl.exe", ["-d", distro, "--", "sh", "-lc", "ip route show default | awk '{print $3; exit}'"],
    { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const host = String(result.stdout || "").trim();
  if (result.error || result.status !== 0 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))
    throw new Error("无法确定 WSL 到提问服务的 Windows 主机地址。");
  return host;
}

function canUseWslLocalhost(distro, port, runCommand) {
  const result = runCommand("wsl.exe", ["-d", distro, "--", "bash", "-lc", `timeout 2 bash -c '</dev/tcp/127.0.0.1/${port}'`],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return !result.error && result.status === 0;
}

async function createOpenCodeQuestionBridge({ session, sshAgentTransport, onQuestion, onCancel, runCommand = spawnSync }) {
  const token = randomBytes(32).toString("hex");
  const pending = new Map();
  let closed = false;
  let server;
  let forwarder;
  let origin;

  const json = (response, status, value) => {
    if (response.destroyed) return;
    const body = JSON.stringify(value);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(body);
  };
  const result = (id, value, isError = false) => ({ jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
      ...(isError ? { isError: true } : {}) } });
  function cancel(requestId) {
    const item = pending.get(requestId);
    if (!item) return false;
    pending.delete(requestId);
    item.resolve({ cancelled: true });
    onCancel?.(requestId);
    return true;
  }
  async function handle(message) {
    const id = message?.id ?? null;
    if (message?.method === "notifications/initialized") return null;
    if (message?.method === "notifications/cancelled") {
      for (const [requestId, item] of pending) if (item.rpcId === message.params?.requestId) cancel(requestId);
      return null;
    }
    if (message?.jsonrpc !== "2.0" || typeof message.method !== "string")
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    if (message.method === "initialize") return { jsonrpc: "2.0", id, result: {
      protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "pannel-handle-question", version: "1.0.0" } } };
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
    if (message.method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    if (message.params?.name !== TOOL.name) return result(id, "未知提问工具。", true);
    let questions;
    try { questions = normalizeQuestions(message.params?.arguments?.questions); }
    catch (error) { return result(id, error.message, true); }
    const requestId = randomUUID();
    const answer = new Promise(resolve => pending.set(requestId, { resolve, rpcId: id, questions }));
    try { onQuestion({ requestId, questions }); }
    catch (error) { pending.delete(requestId); return result(id, error.message, true); }
    const response = await answer;
    return response.cancelled ? result(id, "用户取消了提问。", true) : result(id, { answers: response.answers });
  }
  async function route(request, response) {
    if (request.url !== "/mcp" || request.method !== "POST") { json(response, 404, { error: "Not Found" }); return; }
    const supplied = String(request.headers.authorization || "").replace(/^Bearer /, "");
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { json(response, 401, { error: "Unauthorized" }); return; }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { json(response, 413, { error: "Request too large" }); return; }
      chunks.push(chunk);
    }
    let message;
    try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { json(response, 400, { error: "Invalid JSON" }); return; }
    const reply = await handle(message);
    if (reply === null) { response.writeHead(202, { "Cache-Control": "no-store" }); response.end(); }
    else json(response, 200, reply);
  }
  async function listen(host) {
    server = http.createServer((request, response) => void route(request, response).catch(error => {
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.destroy();
    }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
    return server.address().port;
  }
  try {
    let port = await listen("127.0.0.1");
    origin = `http://127.0.0.1:${port}`;
    if (session.type === "wsl" && !canUseWslLocalhost(session.wslDistro, port, runCommand)) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      port = await listen(wslHost(session.wslDistro, runCommand));
      origin = `http://${server.address().address}:${port}`;
    }
    if (session.type === "ssh" && session.agentLocation !== "local") {
      if (!sshAgentTransport?.createReverseHttpForwarder) throw new Error("SSH 提问通道不可用。");
      forwarder = await sshAgentTransport.createReverseHttpForwarder(session.id, port);
      origin = forwarder.url;
    }
  } catch (error) {
    if (server?.listening) {
      server.closeAllConnections?.();
      server.close();
    }
    throw error;
  }
  return {
    url: `${origin}/mcp`, token,
    answer(requestId, answers) {
      const item = pending.get(requestId);
      if (!item) throw new Error("问题请求已失效。");
      pending.delete(requestId);
      item.resolve({ answers });
    },
    cancel,
    cancelAll() { for (const id of [...pending.keys()]) cancel(id); },
    close() {
      if (closed) return;
      closed = true;
      for (const id of [...pending.keys()]) cancel(id);
      forwarder?.close();
      server.closeAllConnections?.();
      server.close();
    }
  };
}

module.exports = { createOpenCodeQuestionBridge, normalizeQuestions };
