const http = require("node:http");
const { EventEmitter } = require("node:events");
const { StringDecoder } = require("node:string_decoder");

const START_TIMEOUT_MS = 60000;
const RESPONSE_LIMIT = 1024 * 1024;
const ERROR_DETAIL_LIMIT = 4096;

function sanitizeDiagnostic(value, secrets = []) {
  let detail = String(value || "");
  for (const secret of secrets) if (secret && String(secret).length >= 4)
    detail = detail.split(String(secret)).join("[已隐藏]");
  return detail.replace(/\b(Authorization\s*:\s*Bearer\s+)\S+/gi, "$1[已隐藏]")
    .replace(/\b((?:Password|Token|Secret|API[_-]?Key)\s*(?:[:=]|\s)\s*)\S+/gi, "$1[已隐藏]");
}

function httpErrorDetail(body, headers, password) {
  let detail = String(body || "").trim();
  try {
    const data = JSON.parse(detail);
    if (data && typeof data === "object") {
      const error = data.error && typeof data.error === "object" ? data.error : {};
      const requestId = error.requestId || data.requestId || headers["x-request-id"];
      detail = [error.message || (typeof data.error === "string" ? data.error : data.message),
        error.details || error.detail || data.details || data.detail,
        requestId ? `请求 ID：${requestId}` : "",
        error.resetAt || data.resetAt ? `重置时间：${error.resetAt || data.resetAt}` : ""].filter(value => typeof value === "string" && value.trim()).join("；");
    }
  } catch {}
  if (headers["x-request-id"] && !detail.includes(headers["x-request-id"]))
    detail += `${detail ? "；" : ""}请求 ID：${headers["x-request-id"]}`;
  const retryAfter = headers["retry-after"];
  if (retryAfter) detail += `${detail ? "；" : ""}Retry-After：${retryAfter}`;
  return sanitizeDiagnostic(detail, [password]).slice(0, ERROR_DETAIL_LIMIT);
}

function parseStartupLine(line, state) {
  const plain = String(line).replace(/\x1b\[[0-9;]*m/g, "");
  const endpoint = plain.match(/\bEndpoint\s+(https?:\/\/\S+)/i);
  const password = plain.match(/\bPassword\s+(\S+)/i);
  if (endpoint) {
    const url = new URL(endpoint[1]);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("CodeBuddy HTTP ACP 未绑定回环地址。");
    state.endpoint = url;
  }
  if (password) state.password = password[1];
}

function waitForEndpoint(child, { timeoutMs = START_TIMEOUT_MS, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const state = { endpoint: null, password: null };
    const buffers = new Map();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderrData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(state);
    };
    const consume = (key, chunk) => {
      const content = (buffers.get(key) || "") + chunk.toString("utf8");
      const lines = content.split(/\r?\n/);
      buffers.set(key, lines.pop().slice(-4096));
      for (const line of lines) {
        try { parseStartupLine(line, state); }
        catch (error) { finish(error); return; }
      }
      if (state.endpoint && state.password) finish();
    };
    const onStdout = chunk => consume("stdout", chunk);
    const onStderrData = chunk => { onStderr?.(chunk); consume("stderr", chunk); };
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`CodeBuddy HTTP ACP 启动失败（退出代码 ${code ?? "未知"}）。请升级 CodeBuddy CLI 并确认支持 --acp-transport streamable-http。`));
    const timer = setTimeout(() => finish(new Error("等待 CodeBuddy HTTP ACP 地址超时。请升级 CodeBuddy CLI 并确认支持 --acp-transport streamable-http。")), timeoutMs);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderrData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function createSseParser(onMessage) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let data = [];
  const line = value => {
    if (!value) {
      if (data.length) {
        const payload = data.join("\n");
        data = [];
        onMessage(JSON.parse(payload));
      }
    } else if (value.startsWith("data:")) data.push(value.slice(5).trimStart());
  };
  return {
    push(chunk) {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const current = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        line(current);
      }
    },
    end() {
      buffer += decoder.end();
      if (buffer) line(buffer.replace(/\r$/, ""));
      line("");
    }
  };
}

function createCodeBuddyHttpTransport({ endpoint, password, agent = new http.Agent({ keepAlive: true }), closeAgent = true }) {
  const events = new EventEmitter();
  const requests = new Set();
  const base = new URL(endpoint);
  const path = new URL("/api/v1/acp", base).pathname;
  let connectionId = null;
  let sessionToken = null;
  let closed = false;
  let subscription = null;

  function headers(extra = {}) {
    return { "X-CodeBuddy-Request": "1", Authorization: `Bearer ${password}`,
      ...(connectionId ? { "acp-connection-id": connectionId } : {}),
      ...(sessionToken ? { "acp-session-token": sessionToken } : {}), ...extra };
  }
  function request(method, route, body, { subscribe = false, rawJson = false } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new Error("CodeBuddy HTTP ACP 已关闭。")); return; }
      const payload = body == null ? null : JSON.stringify(body);
      const req = http.request({ hostname: base.hostname, port: base.port, path: route, method, agent,
        headers: headers({ Accept: "application/json, text/event-stream", ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) }) }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = "";
          res.on("data", chunk => { if (detail.length < ERROR_DETAIL_LIMIT) detail += chunk.toString("utf8").slice(0, ERROR_DETAIL_LIMIT - detail.length); });
          res.on("end", () => {
            const explanation = httpErrorDetail(detail, res.headers, password);
            reject(new Error(`CodeBuddy HTTP ACP 返回 HTTP ${res.statusCode}${res.statusCode === 401 ? "（认证失败）" : ""}。${explanation ? ` ${explanation}` : ""}`));
          });
          return;
        }
        const type = String(res.headers["content-type"] || "");
        if (subscribe && !type.includes("text/event-stream")) { reject(new Error("CodeBuddy 未提供 ACP SSE 推送。")); res.resume(); return; }
        if (subscribe) { subscription = req; resolve(); }
        const parser = createSseParser(value => events.emit("message", value));
        let json = "";
        res.on("data", chunk => {
          try {
            if (type.includes("text/event-stream")) parser.push(chunk);
            else {
              json += chunk.toString("utf8");
              if (json.length > RESPONSE_LIMIT) throw new Error("CodeBuddy HTTP ACP 响应过大。");
            }
          } catch (error) { req.destroy(error); }
        });
        res.on("end", () => {
          requests.delete(req);
          if (subscribe) { if (!closed) events.emit("error", new Error("CodeBuddy ACP SSE 推送已断开。")); return; }
          try {
            if (type.includes("text/event-stream")) parser.end();
            else if (json.trim()) {
              const value = JSON.parse(json);
              if (route.endsWith("/connect") || rawJson) resolve(value);
              else { events.emit("message", value); resolve(); }
              return;
            }
            resolve();
          } catch (error) { reject(error); }
        });
      });
      requests.add(req);
      req.on("error", error => {
        requests.delete(req);
        if (subscribe && subscription === req) { if (!closed) events.emit("error", error); }
        else reject(error);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    on: (name, listener) => events.on(name, listener),
    async connect() {
      const value = await request("POST", `${path}/connect`, {});
      connectionId = value?.connectionId || value?.data?.connectionId;
      sessionToken = value?.sessionToken || value?.data?.sessionToken;
      if (!connectionId) throw new Error("CodeBuddy HTTP ACP 未返回连接 ID。");
      await request("GET", path, null, { subscribe: true });
    },
    send(message) { return request("POST", path, message); },
    sendTeamMessage(message) { return request("POST", "/api/v1/team/messages/send", message, { rawJson: true }); },
    close() {
      if (closed) return Promise.resolve();
      const deleteHeaders = headers();
      closed = true;
      for (const req of requests) req.destroy();
      requests.clear();
      return new Promise(resolve => {
        let finished = false;
        let deleteRequest;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (closeAgent) agent.destroy();
          resolve();
        };
        const timer = setTimeout(() => { deleteRequest?.destroy(); finish(); }, 1000);
        if (!connectionId) { finish(); return; }
        try {
          deleteRequest = http.request({ hostname: base.hostname, port: base.port, path, method: "DELETE", agent, headers: deleteHeaders }, res => {
            res.resume(); res.once("end", finish);
          });
          deleteRequest.once("error", finish);
          deleteRequest.end();
        } catch { finish(); }
      });
    }
  };
}

module.exports = { parseStartupLine, waitForEndpoint, createSseParser, createCodeBuddyHttpTransport, sanitizeDiagnostic };
