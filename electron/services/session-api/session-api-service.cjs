const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { listPrivateInterfaces } = require("../mobile-remote/mobile-network.cjs");
const { sessionInstanceSchema } = require("../mcp/session-instance-schema.cjs");
const MAX_BODY_BYTES = 256 * 1024;

function createSessionApiService({ userData, instances, moduleOwners, listInstances, getInstanceStatus, broadcast = () => {}, defaultPort = 43125 }) {
  const file = path.join(userData, "session-api.json");
  let config = { enabled: false, port: defaultPort, token: randomBytes(32).toString("hex") };
  let server = null;
  let error = "";
  let transition = Promise.resolve();
  const trackedCreations = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    config.enabled = saved.enabled === true;
    if (Number.isInteger(saved.port) && saved.port > 0 && saved.port <= 65535) config.port = saved.port;
    if (/^[a-f0-9]{64}$/.test(saved.token)) config.token = saved.token;
  } catch (err) { if (err.code !== "ENOENT") error = "无法读取接口服务配置。"; }

  const baseUrl = () => `http://127.0.0.1:${server?.address()?.port || config.port}`;
  const status = () => ({ enabled: config.enabled, running: Boolean(server?.listening), port: config.port,
    url: baseUrl(), lanUrls: listPrivateInterfaces().map(item => `http://${item.address}:${server?.address()?.port || config.port}`), error });
  const changed = () => broadcast("session-api:changed", status());
  function save() {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(config), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  function reply(response, code, value) {
    response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  }
  const fail = (response, statusCode, code, message) => reply(response, statusCode, { error: { code, message } });
  async function route(request, response) {
    if (request.url === "/api/v1/module-owner-tools" && moduleOwners) {
      if (request.headers.origin) return fail(response, 403, "origin_forbidden", "不支持跨域浏览器调用。");
      if (request.method !== "POST") return fail(response, 405, "method_not_allowed", "请求方法不支持。");
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) return fail(response, 400, "invalid_json", "请求必须使用 application/json。");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return fail(response, 413, "body_too_large", "请求体超过 256 KiB。");
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return fail(response, 400, "invalid_json", "JSON 格式无效。"); }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(String(request.headers.authorization || ""))?.[1];
      try { return reply(response, 200, await moduleOwners.callback(token, body)); }
      catch (err) { return fail(response, err.statusCode || 500, "tool_callback_failed", err.statusCode === 401 ? err.message : "负责人工具调用失败。"); }
    }
    const supplied = Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(String(request.headers.authorization || ""))?.[1] || "");
    const expected = Buffer.from(config.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return fail(response, 401, "unauthorized", "接口令牌无效。");
    if (request.headers.origin) return fail(response, 403, "origin_forbidden", "不支持跨域浏览器调用。");
    const instancePath = /^\/api\/v1\/session-instances\/([^/]+)$/.exec(request.url);
    if (instancePath || (request.url === "/api/v1/session-instances" && request.method === "GET")) {
      if (request.method !== "GET") return fail(response, 405, "method_not_allowed", "请求方法不支持。");
      let sessionId;
      if (instancePath) {
        try { sessionId = decodeURIComponent(instancePath[1]); }
        catch { return fail(response, 400, "invalid_parameters", "会话 ID 编码无效。"); }
      }
      try {
        if (!instancePath) return reply(response, 200, await listInstances());
        const instance = await getInstanceStatus(sessionId);
        return instance ? reply(response, 200, instance) : fail(response, 404, "session_not_found", "会话实例不存在或已经结束。");
      } catch { return fail(response, 500, "query_failed", "会话状态查询失败。"); }
    }
    if (!["/api/v1/session-templates", "/api/v1/session-instances"].includes(request.url)) return fail(response, 404, "not_found", "接口不存在。");
    if (request.url === "/api/v1/session-templates") {
      if (request.method !== "GET") return fail(response, 405, "method_not_allowed", "请求方法不支持。");
      return reply(response, 200, instances.listTemplates());
    }
    if (request.method !== "POST") return fail(response, 405, "method_not_allowed", "请求方法不支持。");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) return fail(response, 400, "invalid_json", "请求必须使用 application/json。");
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(response, 413, "body_too_large", "请求体超过 256 KiB。");
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return fail(response, 400, "invalid_json", "JSON 格式无效。"); }
    const parsed = sessionInstanceSchema.safeParse(value);
    if (!parsed.success) return fail(response, 400, "invalid_parameters", "请提供有效的模板、模式、任务文本和模型参数。");
    let hooks;
    try {
      const trackingId = request.headers["x-pannel-creation-id"];
      if (trackingId) {
        const tracked = trackedCreations.get(trackingId);
        if (!tracked || tracked.body !== JSON.stringify(parsed.data)) return fail(response, 409, "invalid_creation_tracking", "创建关联已失效。");
        trackedCreations.delete(trackingId);
        hooks = tracked.hooks;
      } else hooks = moduleOwners?.claimCreation(parsed.data);
      hooks?.onCreationClaimed?.();
      reply(response, 201, await (hooks ? instances.create(parsed.data, hooks) : instances.create(parsed.data)));
    }
    catch (err) {
      hooks?.failed(err);
      const code = err.statusCode || 500;
      fail(response, code, err.apiCode || "creation_failed", code === 500 ? "会话启动或任务提交失败，请检查桌面会话状态。" : err.message);
    }
  }
  async function stop() {
    moduleOwners?.revokeAll();
    const previous = server;
    server = null;
    error = "";
    if (previous) {
      await new Promise(resolve => { previous.close(resolve); previous.closeIdleConnections(); });
    }
    changed();
  }
  async function start() {
    if (!config.enabled || server) return status();
    error = "";
    const next = http.createServer((request, response) => void route(request, response).catch(() => {
      if (!response.headersSent) fail(response, 500, "internal_error", "接口请求处理失败。");
      else response.end();
    }));
    try {
      await new Promise((resolve, reject) => { next.once("error", reject); next.listen(config.port, "0.0.0.0", resolve); });
      next.removeAllListeners("error");
      next.on("error", () => { error = "接口服务运行失败。"; changed(); });
      server = next;
    } catch (err) { error = err.code === "EADDRINUSE" ? "接口端口已被占用。" : "接口服务无法启动。"; }
    changed();
    return status();
  }
  function configure(input) {
    const operation = transition.then(async () => {
      if (!input || typeof input !== "object" || (input.enabled !== undefined && typeof input.enabled !== "boolean")
        || (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535))) throw new Error("无效的接口服务配置。");
      const previous = config;
      config = { ...config, enabled: input.enabled ?? config.enabled, port: input.port ?? config.port };
      try { save(); } catch (err) { config = previous; throw err; }
      await stop();
      await start();
      changed();
      return status();
    });
    transition = operation.catch(() => {});
    return operation;
  }
  async function invoke(input, hooks) {
    if (!server?.listening) throw new Error("接口服务未启用。");
    if (!["list", "create", "listInstances", "getInstanceStatus"].includes(input?.operation)) throw new Error("无效的接口调用。");
    if (input.operation === "getInstanceStatus" && (typeof input.sessionId !== "string" || !input.sessionId.trim())) throw new Error("请提供会话 ID。");
    const method = input.operation === "create" ? "POST" : "GET";
    const url = `${baseUrl()}/api/v1/${input.operation === "list" ? "session-templates" : "session-instances"}${input.operation === "getInstanceStatus" ? `/${encodeURIComponent(input.sessionId.trim())}` : ""}`;
    const started = Date.now();
    const trackingId = hooks && method === "POST" ? randomBytes(32).toString("hex") : null;
    if (trackingId) trackedCreations.set(trackingId, { body: JSON.stringify(sessionInstanceSchema.parse(input.body)), hooks });
    try {
      const response = await fetch(url, { method, headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", ...(trackingId ? { "X-Pannel-Creation-Id": trackingId } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(input.body) } : {}), signal: AbortSignal.timeout(120000), redirect: "error" });
      return { method, url, status: response.status, elapsedMs: Date.now() - started, body: await response.json() };
    } catch { throw new Error(input.operation === "create" ? "接口调用失败或超时；创建结果可能尚未确认，请先检查会话列表，不要直接重复创建。" : "接口查询失败或超时。"); }
    finally { if (trackingId) trackedCreations.delete(trackingId); }
  }
  return { status, start, stop, configure, invoke, revealToken: () => config.token,
    resetToken: () => {
      const previous = config.token;
      config.token = randomBytes(32).toString("hex");
      try { save(); } catch (err) { config.token = previous; throw err; }
      changed();
      return config.token;
    } };
}

module.exports = { createSessionApiService };
