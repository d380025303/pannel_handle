const crypto = require("node:crypto");
const http = require("node:http");
const { spawnSync: defaultSpawnSync } = require("node:child_process");
const { responsesToChat, createResponseAccumulator } = require("./responses-chat-completions-protocol.cjs");

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function readBody(request, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error("请求正文过大。"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function writeSse(response, event) {
  if (!response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function errorResponse(response, statusCode, message, type = "responses_chat_bridge_error") {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    writeSse(response, { type: "error", error: { type, message } });
    response.end();
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: { message, type } }));
}

async function pipeWebStream(stream, onChunk) {
  if (!stream) return;
  if (typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) onChunk(Buffer.from(chunk));
    return;
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function createResponsesChatCompletionsBridgeService({
  providerId,
  providerName,
  upstreamUrl,
  apiKeyEnv,
  ignoredToolTypes = [],
  requestAdapter = request => request,
  allowFinishReasonAsDone = false,
  fetchImpl = globalThis.fetch,
  localFetchImpl = globalThis.fetch,
  spawnSync = defaultSpawnSync
}) {
  const listeners = new Map();
  const pendingListeners = new Map();
  const registrations = new Map();
  let shutdownPromise;

  function findRegistration(token) {
    for (const registration of registrations.values()) {
      if (registration.token === token) return registration;
    }
    return undefined;
  }

  async function handleResponses(request, response) {
    const auth = String(request.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const registration = findRegistration(token);
    if (!registration) {
      errorResponse(response, 401, `Invalid ${providerName} bridge session token.`);
      return;
    }

    let body;
    try {
      body = JSON.parse((await readBody(request)).toString("utf-8"));
      const model = String(body?.model || "").trim();
      if (!model || (registration.models.size && !registration.models.has(model))) {
        throw Object.assign(new Error(`${providerName} 模型不可用：${model || "unknown"}`), { statusCode: 400 });
      }
      const converted = responsesToChat(body, { ignoredToolTypes });
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once("close", abort);
      try {
        const upstream = await fetchImpl(upstreamUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${registration.apiKey}`,
            Accept: "text/event-stream",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(requestAdapter(converted.request)),
          signal: controller.signal
        });
        if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
        if (!upstream.ok) {
          const payload = await upstream.text();
          if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
          const requestId = upstream.headers.get("x-request-id") || upstream.headers.get("cf-ray");
          response.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
            ...(requestId ? { "x-request-id": requestId } : {})
          });
          response.end(payload);
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        const accumulator = createResponseAccumulator({
          model,
          customTools: converted.customTools,
          toolAliases: converted.toolAliases,
          toolKinds: converted.toolKinds,
          toolNamespaces: converted.toolNamespaces,
          requireDone: true,
          allowFinishReasonAsDone,
          emit: event => writeSse(response, event)
        });
        accumulator.start();
        try {
          await pipeWebStream(upstream.body, chunk => accumulator.push(chunk));
        } catch (error) {
          if (!controller.signal.aborted) accumulator.fail(error);
        }
        if (!response.destroyed && !response.writableEnded) {
          accumulator.finish();
          response.end();
        }
      } finally {
        response.off("close", abort);
      }
    } catch (error) {
      errorResponse(response, error.statusCode || 502, error.message || `${providerName} bridge failed.`);
    }
  }

  async function route(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname === "/v1/responses") return handleResponses(request, response);
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, provider: providerId }));
      return;
    }
    errorResponse(response, 404, "Not found.");
  }

  function listen(host) {
    if (shutdownPromise) return Promise.reject(new Error(`${providerName} bridge is shutting down.`));
    if (listeners.has(host)) return Promise.resolve(listeners.get(host));
    if (pendingListeners.has(host)) return pendingListeners.get(host);
    const pending = new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => void route(request, response).catch(error => errorResponse(response, 500, error.message)));
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        const address = server.address();
        const entry = { server, origin: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
        listeners.set(host, entry);
        resolve(entry);
      });
    });
    pendingListeners.set(host, pending);
    void pending.then(() => pendingListeners.delete(host), () => pendingListeners.delete(host));
    return pending;
  }

  function resolveWslHost(distro) {
    const result = spawnSync("wsl.exe", ["-d", distro, "--", "sh", "-lc", "ip route show default | awk '{print $3; exit}'"], { encoding: "utf-8", windowsHide: true, timeout: 10000 });
    const host = String(result.stdout || "").trim();
    if (result.error || result.status !== 0 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) throw new Error(`无法确定 WSL 到 ${providerName} 桥的 Windows 主机地址。`);
    return host;
  }

  function canUseWslLocalhost(distro, origin) {
    const port = new URL(origin).port;
    const result = spawnSync("wsl.exe", ["-d", distro, "--", "bash", "-lc", `timeout 2 bash -c '</dev/tcp/127.0.0.1/${port}'`], { encoding: "utf-8", windowsHide: true, timeout: 5000 });
    return !result.error && result.status === 0;
  }

  async function listenerFor(session) {
    const internal = await listen("127.0.0.1");
    if (session?.type !== "wsl" || canUseWslLocalhost(session.wslDistro, internal.origin)) return internal;
    return listen(resolveWslHost(session.wslDistro));
  }

  function register(key, apiKey, models) {
    if (shutdownPromise) throw new Error(`${providerName} bridge is shutting down.`);
    const token = randomToken();
    registrations.set(key, { token, apiKey, models: new Set(models || []) });
    return token;
  }

  async function fetchResponses({ apiKey, body, signal }) {
    const listener = await listen("127.0.0.1");
    const registrationId = `verify:${crypto.randomUUID()}`;
    const token = register(registrationId, apiKey, [body.model]);
    try {
      return await localFetchImpl(`${listener.origin}/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal
      });
    } finally {
      registrations.delete(registrationId);
    }
  }

  async function getLaunchConfig(session, config) {
    const listener = await listenerFor(session);
    const registrationId = `launch:${crypto.randomUUID()}`;
    const token = register(registrationId, config.apiKey, [config.model]);
    return {
      ...config,
      apiKey: token,
      apiKeyEnv,
      baseUrl: `${listener.origin}/v1`,
      registrationId
    };
  }

  function bindSession(sessionId, registrationId) {
    const registration = registrations.get(registrationId);
    if (!registration) throw new Error(`${providerName} bridge launch token expired before the terminal started.`);
    registrations.delete(registrationId);
    registrations.set(sessionId, registration);
  }

  function releaseRegistration(registrationId) {
    registrations.delete(registrationId);
  }

  function disconnect(sessionId) {
    registrations.delete(sessionId);
  }

  function shutdown() {
    if (!shutdownPromise) shutdownPromise = (async () => {
      await Promise.allSettled([...pendingListeners.values()]);
      await Promise.all([...listeners.values()].map(({ server }) => new Promise(resolve => server.close(resolve))));
      listeners.clear();
      registrations.clear();
    })();
    return shutdownPromise;
  }

  return { fetchResponses, getLaunchConfig, bindSession, releaseRegistration, disconnect, shutdown };
}

module.exports = {
  MAX_REQUEST_BYTES,
  randomToken,
  readBody,
  pipeWebStream,
  createResponsesChatCompletionsBridgeService
};
