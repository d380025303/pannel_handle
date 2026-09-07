const fs = require("node:fs");
const path = require("node:path");
const { getMobileHostname } = require("./mobile-network.cjs");
const { PROTOCOL_VERSION } = require("./mobile-protocol.cjs");

function createMobileHttpHandler({ accessStore, getAddress, getStaticRoot }) {
  function verifyRequestHost(request) {
    const config = accessStore.getConfig();
    const allowed = new Set([`${getAddress()}:${config.port}`, `${getMobileHostname()}:${config.port}`]);
    const host = String(request.headers.host || "").toLowerCase();
    if (!allowed.has(host)) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  function setSecurityHeaders(response) {
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
  }

  function contentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" })[extension] || "application/octet-stream";
  }

  function handleHttp(request, response) {
    setSecurityHeaders(response);
    if (!verifyRequestHost(request)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Forbidden");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
    if (requestUrl.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
      return;
    }
    const staticRoot = path.resolve(getStaticRoot());
    const relative = requestUrl.pathname === "/" ? "index.html" : decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    const candidate = path.resolve(staticRoot, relative);
    const target = candidate.startsWith(`${staticRoot}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(staticRoot, "index.html");
    if (!target.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(target)) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("移动端资源尚未构建，请先在项目根目录执行 corepack pnpm build:mobile。");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType(target),
      "Cache-Control": path.basename(target) === "index.html" ? "no-store" : "public, max-age=31536000, immutable"
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(target).pipe(response);
  }
  return { verifyRequestHost, handleHttp };
}

module.exports = { createMobileHttpHandler };
