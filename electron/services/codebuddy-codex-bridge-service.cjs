const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { responsesToChat, createResponseAccumulator } = require("./codebuddy-codex-protocol.cjs");

const SUPPORTED_CODEBUDDY_MINOR = "2.142";
const API_KEY_ENV = "PANNEL_HANDLE_CODEBUDDY_CODEX_KEY";
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const ALLOWED_UPSTREAM_HOSTS = new Set(["copilot.tencent.com", "www.codebuddy.ai", "staging-copilot.tencent.com", "staging-codebuddy.tencent.com"]);

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function readBody(request, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求正文过大。"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseCodeBuddyVersion(output) {
  return String(output || "").match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1];
}

function parseCodeBuddyModels(output) {
  const match = String(output || "").match(/Currently supported:\s*\(([^)]+)\)/i);
  if (!match) return [];
  return match[1].split(",").map(value => value.trim()).filter(value => value && value !== "auto" && /^[a-z0-9][a-z0-9._-]*$/i.test(value));
}

function buildModelCatalog(models) {
  return {
    models: models.map((model, index) => ({
      slug: model.id,
      display_name: model.name || model.id,
      description: `CodeBuddy ${model.id} through the experimental Codex bridge`,
      base_instructions: "You are Codex, an agentic coding assistant. Follow the developer and user instructions provided in the conversation.",
      context_window: 128000,
      max_context_window: 128000,
      default_reasoning_level: null,
      supported_reasoning_levels: [],
      input_modalities: ["text"],
      supports_parallel_tool_calls: true,
      apply_patch_tool_type: "freeform",
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: index + 1,
      supports_reasoning_summaries: false,
      supports_reasoning_summary_parameter: false,
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: []
    }))
  };
}

function createCodeBuddyCodexBridgeService({
  verificationFile,
  catalogFile,
  preloadFile,
  spawn = defaultSpawn,
  spawnSync = defaultSpawnSync,
  now = Date.now
}) {
  const listeners = new Map();
  const sessionTokens = new Map();
  const pending = new Map();
  const internalToken = randomToken();
  let verifications = {};
  let versionCache;
  let modelCache;
  let shuttingDown = false;

  try { verifications = JSON.parse(fs.readFileSync(verificationFile, "utf-8")); } catch {}

  function inspectCli({ refresh = false } = {}) {
    if (!refresh && versionCache && modelCache) return { version: versionCache, models: modelCache };
    const versionResult = spawnSync("cmd.exe", ["/d", "/s", "/c", "codebuddy --version"], { encoding: "utf-8", windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
    const version = parseCodeBuddyVersion(versionResult.stdout || versionResult.stderr);
    if (versionResult.error || versionResult.status !== 0 || !version) throw new Error("无法读取 CodeBuddy CLI 版本，请确认 Windows 已安装 CodeBuddy。");
    if (!version.startsWith(`${SUPPORTED_CODEBUDDY_MINOR}.`)) throw new Error(`CodeBuddy Codex 实验桥仅兼容 ${SUPPORTED_CODEBUDDY_MINOR}.x，当前版本为 ${version}。`);
    const helpResult = spawnSync("cmd.exe", ["/d", "/s", "/c", "codebuddy --help"], { encoding: "utf-8", windowsHide: true, timeout: 10000, maxBuffer: 512 * 1024 });
    const ids = parseCodeBuddyModels(helpResult.stdout || helpResult.stderr);
    if (helpResult.error || helpResult.status !== 0 || !ids.length) throw new Error("无法读取 CodeBuddy 模型列表。");
    versionCache = version;
    modelCache = ids.map(id => ({ id, name: id, verification: verifications[`${version}:${id}`] }));
    return { version, models: modelCache };
  }

  function getStatus() {
    try {
      const result = inspectCli();
      return { available: true, version: result.version, supportedMinor: SUPPORTED_CODEBUDDY_MINOR, experimental: true };
    } catch (error) {
      return { available: false, supportedMinor: SUPPORTED_CODEBUDDY_MINOR, experimental: true, error: error.message };
    }
  }

  function listModels() {
    return inspectCli({ refresh: true }).models;
  }

  function saveVerifications() {
    fs.mkdirSync(path.dirname(verificationFile), { recursive: true });
    const temporaryFile = `${verificationFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(verifications, null, 2), "utf-8");
    fs.renameSync(temporaryFile, verificationFile);
  }

  function writeCatalog() {
    const { version, models } = inspectCli();
    const passed = models.filter(model => verifications[`${version}:${model.id}`]?.status === "passed");
    if (!passed.length) throw new Error("尚无通过 Codex 工具协议检测的 CodeBuddy 模型。");
    fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
    const temporaryFile = `${catalogFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(buildModelCatalog(passed), null, 2), "utf-8");
    fs.renameSync(temporaryFile, catalogFile);
    return catalogFile;
  }

  function writeSse(response, event) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  function errorResponse(response, statusCode, message) {
    if (response.headersSent) {
      writeSse(response, { type: "error", error: { type: "invalid_request_error", message } });
      response.end();
      return;
    }
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { message, type: "codebuddy_bridge_error" } }));
  }

  async function forwardCodeBuddyRequest(request, response, requestId) {
    const record = pending.get(requestId);
    if (!record || record.claims >= 2) {
      errorResponse(response, 404, "CodeBuddy bridge request expired.");
      return;
    }
    if (request.headers["x-pannel-bridge-token"] !== internalToken) {
      errorResponse(response, 401, "Unauthorized bridge request.");
      return;
    }
    record.claims += 1;
    await readBody(request).catch(() => Buffer.alloc(0));
    let target;
    try { target = new URL(String(request.headers["x-pannel-upstream-url"] || "")); } catch {}
    if (!target || target.protocol !== "https:" || !ALLOWED_UPSTREAM_HOSTS.has(target.hostname) || !/\/chat\/completions$/i.test(target.pathname)) {
      errorResponse(response, 403, "CodeBuddy upstream target was rejected.");
      errorResponse(record.codexResponse, 502, "CodeBuddy 上游地址不在允许范围内。");
      cleanupPending(requestId);
      return;
    }
    const headers = { ...request.headers };
    for (const name of ["host", "connection", "content-length", "transfer-encoding", "content-encoding", "x-pannel-bridge-token", "x-pannel-upstream-url"]) delete headers[name];
    const payload = Buffer.from(JSON.stringify(record.chatRequest), "utf-8");
    headers.host = target.host;
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
    const upstreamRequest = https.request(target, { method: "POST", headers }, upstreamResponse => {
      const statusCode = upstreamResponse.statusCode || 502;
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      if (statusCode === 401 && record.claims < 2) {
        record.awaitingRetry = true;
        upstreamResponse.pipe(response);
        return;
      }
      record.awaitingRetry = false;
      if (statusCode < 200 || statusCode >= 300) {
        record.codexResponse.writeHead(statusCode, { "content-type": upstreamResponse.headers["content-type"] || "application/json" });
        upstreamResponse.on("data", chunk => { response.write(chunk); record.codexResponse.write(chunk); });
        upstreamResponse.on("end", () => { response.end(); record.codexResponse.end(); cleanupPending(requestId); });
        return;
      }
      record.codexResponse.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      const accumulator = createResponseAccumulator({ model: record.model, customTools: record.customTools, toolAliases: record.toolAliases, emit: event => writeSse(record.codexResponse, event) });
      accumulator.start();
      upstreamResponse.on("data", chunk => { response.write(chunk); accumulator.push(chunk); });
      upstreamResponse.on("end", () => {
        response.end();
        accumulator.finish();
        record.codexResponse.end();
        cleanupPending(requestId);
      });
      upstreamResponse.on("error", error => {
        response.destroy(error);
        errorResponse(record.codexResponse, 502, `CodeBuddy 模型流中断：${error.message}`);
        cleanupPending(requestId);
      });
    });
    record.upstreamRequest = upstreamRequest;
    upstreamRequest.on("error", error => {
      errorResponse(response, 502, "CodeBuddy upstream request failed.");
      errorResponse(record.codexResponse, 502, `CodeBuddy 模型请求失败：${error.message}`);
      cleanupPending(requestId);
    });
    upstreamRequest.end(payload);
  }

  function cleanupPending(requestId) {
    const record = pending.get(requestId);
    if (!record) return;
    pending.delete(requestId);
    clearTimeout(record.timeout);
    if (record.child && !record.child.killed) record.child.kill();
  }

  async function handleResponses(request, response) {
    const auth = String(request.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (![...sessionTokens.values()].some(value => value === token)) {
      errorResponse(response, 401, "Invalid CodeBuddy Codex session token.");
      return;
    }
    let body;
    try { body = JSON.parse((await readBody(request)).toString("utf-8")); } catch (error) {
      errorResponse(response, error.statusCode || 400, error.message || "Invalid JSON body.");
      return;
    }
    const { models } = inspectCli();
    const model = String(body.model || "");
    if (!models.some(item => item.id === model)) {
      errorResponse(response, 400, `CodeBuddy 模型不可用：${model}`);
      return;
    }
    const converted = responsesToChat(body);
    const requestId = crypto.randomUUID();
    const nodeOptions = `${process.env.NODE_OPTIONS || ""} --require=${JSON.stringify(preloadFile)}`.trim();
    const env = {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      PANNEL_HANDLE_CODEBUDDY_BRIDGE_URL: listeners.get("127.0.0.1").origin,
      PANNEL_HANDLE_CODEBUDDY_BRIDGE_TOKEN: internalToken,
      PANNEL_HANDLE_CODEBUDDY_REQUEST_ID: requestId
    };
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `codebuddy -p --output-format text --model ${model} --tools "" --no-session-persistence --max-turns 1 "Reply OK"`], {
      cwd: os.homedir(), env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"]
    });
    const timeout = setTimeout(() => {
      errorResponse(response, 504, "CodeBuddy 未在 30 秒内建立模型请求，请检查登录状态。");
      cleanupPending(requestId);
    }, 30000);
    pending.set(requestId, { child, timeout, codexResponse: response, chatRequest: converted.request, customTools: converted.customTools, toolAliases: converted.toolAliases, model, claims: 0, awaitingRetry: false });
    child.on("exit", code => {
      const record = pending.get(requestId);
      if (!record || (record.claims > 0 && !record.awaitingRetry)) return;
      const message = record.awaitingRetry
        ? `CodeBuddy 刷新登录凭据失败（code ${code ?? "unknown"}）。`
        : `CodeBuddy 在建立模型请求前退出（code ${code ?? "unknown"}）。`;
      errorResponse(response, 502, message);
      cleanupPending(requestId);
    });
    response.on("close", () => {
      if (!response.writableEnded) {
        const record = pending.get(requestId);
        record?.upstreamRequest?.destroy();
        cleanupPending(requestId);
      }
    });
  }

  async function route(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "POST" && url.pathname === "/v1/responses") return await handleResponses(request, response);
      const internalMatch = request.method === "POST" && url.pathname.match(/^\/internal\/codebuddy\/([^/]+)$/);
      if (internalMatch) return await forwardCodeBuddyRequest(request, response, decodeURIComponent(internalMatch[1]));
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      errorResponse(response, 404, "Not found.");
    } catch (error) {
      errorResponse(response, 500, error.message || "CodeBuddy bridge failed.");
    }
  }

  function listen(host) {
    if (listeners.has(host)) return Promise.resolve(listeners.get(host));
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => void route(request, response));
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        const entry = { server, origin: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
        listeners.set(host, entry);
        resolve(entry);
      });
    });
  }

  async function ensureInternalListener() {
    return listen("127.0.0.1");
  }

  function resolveWslHost(distro) {
    const result = spawnSync("wsl.exe", ["-d", distro, "--", "sh", "-lc", "ip route show default | awk '{print $3; exit}'"], { encoding: "utf-8", windowsHide: true, timeout: 10000 });
    const host = String(result.stdout || "").trim();
    if (result.error || result.status !== 0 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      throw new Error("无法确定 WSL 到 Windows 的主机地址，请检查 WSL 网络配置。");
    }
    return host;
  }

  function canUseWslLocalhost(distro, origin) {
    const port = new URL(origin).port;
    const result = spawnSync("wsl.exe", ["-d", distro, "--", "bash", "-lc", `timeout 2 bash -c '</dev/tcp/127.0.0.1/${port}'`], { encoding: "utf-8", windowsHide: true, timeout: 5000 });
    return !result.error && result.status === 0;
  }

  function toWslPath(windowsPath, distro) {
    const result = spawnSync("wsl.exe", ["-d", distro, "--", "wslpath", "-a", "-u", windowsPath], { encoding: "utf-8", windowsHide: true, timeout: 10000 });
    const converted = String(result.stdout || "").trim();
    if (result.error || result.status !== 0 || !converted.startsWith("/")) throw new Error("无法转换 CodeBuddy Codex 模型目录的 WSL 路径。");
    return converted;
  }

  async function requestProbe(modelId, body) {
    const listener = await ensureInternalListener();
    const token = randomToken();
    const key = `verify:${crypto.randomUUID()}`;
    sessionTokens.set(key, token);
    try {
      const response = await fetch(`${listener.origin}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: modelId, stream: true, ...body }) });
      const text = await response.text();
      if (!response.ok) throw new Error(text.slice(0, 500) || `HTTP ${response.status}`);
      const completedLine = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).reverse().find(line => line.includes('"response.completed"'));
      if (!completedLine) throw new Error("Codex Responses 流未完成。");
      return JSON.parse(completedLine).response;
    } finally {
      sessionTokens.delete(key);
    }
  }

  async function verifyModel(input = {}) {
    const modelId = String(input.modelId || "").trim();
    const { version, models } = inspectCli({ refresh: true });
    if (!models.some(item => item.id === modelId)) throw new Error(`CodeBuddy 模型不存在：${modelId}`);
    const cacheKey = `${version}:${modelId}`;
    const cached = verifications[cacheKey];
    if (!input.force && cached?.status === "passed" && now() - cached.checkedAt < VERIFICATION_TTL_MS) return { modelId, ...cached };
    const stages = [];
    try {
      const textResponse = await requestProbe(modelId, { input: "Reply only OK." });
      if (!textResponse.output?.some(item => item.type === "message" && item.content?.some(part => part.text))) throw new Error("模型未返回文本输出。");
      stages.push({ stage: "responses", status: "passed" });
      const functionResponse = await requestProbe(modelId, { input: "Call codex_probe exactly once with value OK.", tool_choice: { type: "function", name: "codex_probe" }, tools: [{ type: "function", name: "codex_probe", description: "Compatibility probe", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] });
      if (!functionResponse.output?.some(item => item.type === "function_call" && item.name === "codex_probe")) throw new Error("模型未返回函数工具调用。");
      stages.push({ stage: "function_tools", status: "passed" });
      const customResponse = await requestProbe(modelId, { input: "Call codex_probe_custom exactly once with input OK.", tool_choice: { type: "custom", name: "codex_probe_custom" }, tools: [{ type: "custom", name: "codex_probe_custom", description: "Codex custom tool compatibility probe", format: { type: "text" } }] });
      if (!customResponse.output?.some(item => item.type === "custom_tool_call" && item.name === "codex_probe_custom")) throw new Error("模型未返回 Codex custom 工具调用。");
      stages.push({ stage: "codex_tools", status: "passed" });
      verifications[cacheKey] = { status: "passed", checkedAt: now(), stages };
    } catch (error) {
      stages.push({ stage: stages.length === 0 ? "responses" : stages.length === 1 ? "function_tools" : "codex_tools", status: "failed", error: String(error.message || error).slice(0, 500) });
      verifications[cacheKey] = { status: "failed", checkedAt: now(), stages, error: stages.at(-1).error };
    }
    saveVerifications();
    modelCache = undefined;
    return { modelId, ...verifications[cacheKey] };
  }

  async function getLaunchConfig(session) {
    if (session.agentProvider !== "codex" || session.codexBackend !== "codebuddy") return null;
    if (session.type === "ssh") throw new Error("CodeBuddy Codex 实验桥首期仅支持 Windows 和 WSL 会话。");
    const { version, models } = inspectCli({ refresh: true });
    const model = String(session.codexModel || "").trim();
    if (!models.some(item => item.id === model)) throw new Error("请选择当前 CodeBuddy CLI 提供的具体模型。");
    const verification = verifications[`${version}:${model}`];
    if (verification?.status !== "passed") throw new Error(`CodeBuddy 模型 ${model} 尚未通过 Codex 工具协议检测。`);
    if (session.codexExperimentalAcknowledged !== true) throw new Error("请先确认 CodeBuddy Codex 私有桥的实验性风险。");
    const internal = await ensureInternalListener();
    let listener = internal;
    if (session.type === "wsl" && !canUseWslLocalhost(session.wslDistro, internal.origin)) {
      listener = await listen(resolveWslHost(session.wslDistro));
    }
    const token = randomToken();
    const registrationId = `launch:${crypto.randomUUID()}`;
    sessionTokens.set(registrationId, token);
    const windowsCatalogPath = writeCatalog();
    return {
      apiKey: token,
      apiKeyEnv: API_KEY_ENV,
      baseUrl: `${listener.origin}/v1`,
      model,
      registrationId,
      catalogPath: session.type === "wsl" ? toWslPath(windowsCatalogPath, session.wslDistro) : windowsCatalogPath
    };
  }

  function bindSession(sessionId, registrationId) {
    const token = sessionTokens.get(registrationId);
    if (!token) throw new Error("CodeBuddy Codex launch token expired before the terminal started.");
    sessionTokens.delete(registrationId);
    sessionTokens.set(sessionId, token);
  }

  function releaseRegistration(registrationId) {
    sessionTokens.delete(registrationId);
  }

  function disconnect(sessionId) {
    sessionTokens.delete(sessionId);
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const requestId of [...pending.keys()]) cleanupPending(requestId);
    await Promise.all([...listeners.values()].map(({ server }) => new Promise(resolve => server.close(resolve))));
    listeners.clear();
    sessionTokens.clear();
  }

  return { getStatus, listModels, verifyModel, getLaunchConfig, bindSession, releaseRegistration, disconnect, shutdown, writeCatalog };
}

module.exports = {
  SUPPORTED_CODEBUDDY_MINOR,
  API_KEY_ENV,
  VERIFICATION_TTL_MS,
  parseCodeBuddyVersion,
  parseCodeBuddyModels,
  buildModelCatalog,
  createCodeBuddyCodexBridgeService
};
