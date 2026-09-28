const http = require("node:http");
const { StringDecoder } = require("node:string_decoder");

function createOpenCodeFormTransport({ port, password, agent, requestTimeoutMs = 10000 }) {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const controllers = new Set();
  let closed = false;
  let stream = null;
  let retry = null;

  function call(method, pathname, body) {
    if (closed) return Promise.reject(new Error("OpenCode Form 连接已关闭。"));
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const request = http.request({ hostname: "127.0.0.1", port, path: pathname, method, agent,
        headers: { Authorization: authorization, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, response => {
        let content = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { content += chunk; if (content.length > 1024 * 1024) request.destroy(new Error("OpenCode Form 响应过大。")); });
        response.on("end", () => {
          controllers.delete(request);
          let result;
          try { result = content ? JSON.parse(content) : undefined; }
          catch { reject(new Error("OpenCode Form 响应无效。")); return; }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(result?.message || result?.error?.message || `OpenCode Form 请求失败（${response.statusCode}）。`));
          } else resolve(result?.data ?? result);
        });
      });
      controllers.add(request);
      request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("OpenCode Form 请求超时。")));
      request.on("error", error => { controllers.delete(request); reject(error); });
      request.end(payload || undefined);
    });
  }

  function subscribe(onEvent, onReconnect) {
    if (closed) return;
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let data = [];
    const schedule = () => {
      stream = null;
      if (!closed && !retry) retry = setTimeout(() => { retry = null; onReconnect(); subscribe(onEvent, onReconnect); }, 1000);
    };
    const request = http.request({ hostname: "127.0.0.1", port, path: "/api/event", method: "GET", agent,
      headers: { Authorization: authorization, Accept: "text/event-stream" } }, response => {
      if (response.statusCode !== 200) { response.resume(); schedule(); return; }
      response.on("data", chunk => {
        buffer += decoder.write(chunk);
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (!line) {
            if (data.length) { try { onEvent(JSON.parse(data.join("\n"))); } catch {} data = []; }
          } else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
      });
      response.on("end", schedule);
      response.on("error", schedule);
    });
    stream = request;
    request.on("error", schedule);
    request.end();
  }

  return {
    list: sessionId => call("GET", `/api/session/${encodeURIComponent(sessionId)}/form`),
    reply: (sessionId, formId, answer) => call("POST", `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`, { answer }),
    cancel: (sessionId, formId) => call("DELETE", `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`),
    subscribe,
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      stream?.destroy();
      for (const request of controllers) request.destroy();
      controllers.clear();
    }
  };
}

module.exports = { createOpenCodeFormTransport };
