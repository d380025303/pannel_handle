const http = require("node:http");
const https = require("node:https");

const originalRequest = https.request.bind(https);
const bridgeOrigin = String(process.env.PANNEL_HANDLE_CODEBUDDY_BRIDGE_URL || "");
const bridgeToken = String(process.env.PANNEL_HANDLE_CODEBUDDY_BRIDGE_TOKEN || "");
const bridgeRequestId = String(process.env.PANNEL_HANDLE_CODEBUDDY_REQUEST_ID || "");
const allowedHosts = new Set(["copilot.tencent.com", "www.codebuddy.ai", "staging-copilot.tencent.com", "staging-codebuddy.tencent.com"]);

function requestUrl(input, options = {}) {
  if (input instanceof URL || typeof input === "string") return new URL(input);
  const value = input || options;
  const protocol = value.protocol || "https:";
  const hostname = value.hostname || value.host;
  const port = value.port ? `:${value.port}` : "";
  return new URL(`${protocol}//${hostname}${port}${value.path || value.pathname || "/"}`);
}

https.request = function patchedRequest(input, options, callback) {
  let requestOptions = options;
  let responseCallback = callback;
  if (typeof options === "function") {
    responseCallback = options;
    requestOptions = undefined;
  }
  let target;
  try { target = requestUrl(input, requestOptions); } catch { return originalRequest(input, options, callback); }
  if (!bridgeOrigin || !bridgeToken || !bridgeRequestId || !allowedHosts.has(target.hostname) || !/\/chat\/completions$/i.test(target.pathname)) {
    return originalRequest(input, options, callback);
  }
  const source = (input && typeof input === "object" && !(input instanceof URL)) ? input : (requestOptions || {});
  const headers = { ...(source.headers || {}), "x-pannel-bridge-token": bridgeToken, "x-pannel-upstream-url": target.toString() };
  delete headers.host;
  delete headers.Host;
  delete headers["content-length"];
  delete headers["Content-Length"];
  const localUrl = new URL(`/internal/codebuddy/${encodeURIComponent(bridgeRequestId)}`, bridgeOrigin);
  return http.request(localUrl, { method: source.method || "POST", headers, signal: source.signal }, responseCallback);
};
