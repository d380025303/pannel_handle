const { SESSION_TOOLS } = require("./session-tool-definitions.cjs");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { Readable } = require("node:stream");
const { createMcpHandler, McpServer } = require("@modelcontextprotocol/server");
const { sessionOverview } = require("../mobile-remote/mobile-session-overview.cjs");

const PORT = 43124;
const MAX_BODY_BYTES = 256 * 1024;

function workState(overview, agentStatus) {
  if (overview.status === "连接中") return "connecting";
  if (overview.status === "重连中") return "reconnecting";
  if (overview.status === "已断开") return "disconnected";
  if (overview.detail === "需要用户输入") return "waiting_for_input";
  if (overview.detail === "等待授权") return "waiting_for_permission";
  if (overview.detail === "等待确认计划") return "waiting_for_plan";
  if (agentStatus?.status === "waiting_for_permission") return "waiting_for_permission";
  if (agentStatus?.resolution === "provide_input" || agentStatus?.eventName === "AppServerQuestion") return "waiting_for_input";
  if (agentStatus?.eventName === "AppServerPlanPending") return "waiting_for_plan";
  if (agentStatus?.status === "failed") return "failed";
  if (["e_prompt", "completed"].includes(agentStatus?.status)) return "idle";
  if (agentStatus?.status === "running") return "running";
  if (overview.status === "错误" || overview.detail === "执行失败") return "failed";
  if (overview.status === "处理中" || overview.status === "运行中") return "running";
  if (overview.status === "空闲") return "idle";
  return "unknown";
}

function createSessionStatusServer({ userData, terminalManager, graphicalService, stateHub, sessionStore, agentSessionLauncher, broadcast = () => {}, port = PORT }) {
  const instances = require("./session-instance-service.cjs").createSessionInstanceService({ sessionStore, agentSessionLauncher, terminalManager, graphicalService });
  const file = path.join(userData, "session-status-mcp.json");
  const agentStatuses = new Map();
  let enabled = false;
  let token = "";
  let server = null;
  let handler = null;
  let lastError = "";
  let lifecycleQueue = Promise.resolve();
  const address = () => `http://127.0.0.1:${server?.address()?.port || port}/mcp`;

  function enqueueLifecycle(operation) {
    const pending = lifecycleQueue.then(operation);
    // Keep later operations runnable even if an earlier operation rejects.
    lifecycleQueue = pending.catch(() => {});
    return pending;
  }

  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      enabled = value.enabled === true;
      token = /^[a-f0-9]{64}$/.test(value.token) ? value.token : "";
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Failed to load session status MCP settings:", error);
    }
  }

  function save() {
    fs.mkdirSync(userData, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ enabled, token }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function status() {
    return { enabled, running: Boolean(server?.listening), url: address(), error: lastError };
  }

  function changed() { broadcast("mcp-session-status:changed", status()); }

  async function getInstance(session) {
    const agentStatus = agentStatuses.get(session.id) || (session.agentStatus ? { status: session.agentStatus } : null);
    // Overview and completed-close checks share one snapshot for this query only.
    let snapshotRead = false;
    let snapshot;
    let snapshotError;
    const queryGraphicalService = { snapshot: () => {
      if (!snapshotRead) {
        snapshotRead = true;
        try { snapshot = graphicalService?.snapshot(session.id); }
        catch (error) { snapshotError = { error }; }
      }
      if (snapshotError) throw snapshotError.error;
      return snapshot;
    } };
    const overview = await sessionOverview(session, queryGraphicalService, stateHub, agentStatus);
    if (!terminalManager.getSession(session.id)) return null;
    return {
      sessionId: session.id,
      title: session.title,
      templateId: session.templateId || null,
      runtimeMode: session.runtimeMode === "app-server" ? "app-server" : "terminal",
      type: session.type,
      agentProvider: session.agentProvider || null,
      sshConnectionState: session.type === "ssh" ? session.sshConnectionState || "connecting" : null,
      workState: workState(overview, agentStatus),
      summary: overview.summary,
      queriedAt: Date.now()
    };
  }

  async function listInstances() {
    return { sessions: (await Promise.all(terminalManager.listSessions().map(getInstance))).filter(Boolean) };
  }

  async function getInstanceStatus(sessionId) {
    const session = terminalManager.listSessions().find(item => item.id === sessionId);
    return session ? getInstance(session) : null;
  }

  function mcpHandler() {
    return createMcpHandler(() => {
      const mcp = new McpServer({ name: "pannel-handle-sessions", version: "1.0.0" });
      mcp.registerTool("list_session_instances", SESSION_TOOLS.list_session_instances, async () => {
        return { content: [{ type: "text", text: JSON.stringify(await listInstances()) }] };
      });
      mcp.registerTool("get_session_instance_status", SESSION_TOOLS.get_session_instance_status, async ({ sessionId }) => {
        const instance = await getInstanceStatus(sessionId);
        return instance
          ? { content: [{ type: "text", text: JSON.stringify(instance) }] }
          : { isError: true, content: [{ type: "text", text: "会话实例不存在或已经结束。" }] };
      });
      mcp.registerTool("list_session_templates", SESSION_TOOLS.list_session_templates, async () => ({ content: [{ type: "text", text: JSON.stringify(instances.listTemplates()) }] }));
      mcp.registerTool("create_session_instance", SESSION_TOOLS.create_session_instance, async args => ({ content: [{ type: "text", text: JSON.stringify(await instances.create(args)) }] }));
      return mcp;
    }, { legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES });
  }

  function authorized(request) {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(String(request.headers.authorization || ""))?.[1] || "";
    const left = Buffer.from(supplied);
    const right = Buffer.from(token);
    return right.length === 64 && left.length === right.length && timingSafeEqual(left, right);
  }

  async function route(request, response) {
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    const origin = address().replace(/\/mcp$/, "");
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(403).end(); return;
    }
    if (!authorized(request)) { response.writeHead(401).end(); return; }
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") { response.writeHead(405).end(); return; }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const webRequest = new Request(address(), {
      method: request.method,
      headers: request.headers,
      ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {})
    });
    const result = await handler.fetch(webRequest);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) await new Promise((resolve, reject) => Readable.fromWeb(result.body).pipe(response).on("finish", resolve).on("error", reject));
    else response.end();
  }

  async function start() {
    if (server?.listening) return status();
    if (!token) { token = randomBytes(32).toString("hex"); save(); }
    handler = mcpHandler();
    const next = http.createServer((request, response) => void route(request, response).catch(error => {
      console.error("Session status MCP request failed:", error);
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    }));
    try {
      await new Promise((resolve, reject) => {
        next.once("error", reject);
        next.listen(port, "127.0.0.1", resolve);
      });
      server = next;
      lastError = "";
    } catch (error) {
      await handler.close();
      handler = null;
      lastError = error.code === "EADDRINUSE" ? `端口 ${port} 已被占用。` : error.message;
    }
    changed();
    return status();
  }

  async function stop() {
    const current = server;
    server = null;
    if (current) {
      current.closeAllConnections?.();
      await new Promise(resolve => current.close(resolve));
    }
    if (handler) await handler.close();
    handler = null;
    changed();
    return status();
  }

  async function setEnabled(value) {
    if (typeof value !== "boolean") throw new Error("MCP 启用状态无效。");
    return enqueueLifecycle(() => {
      enabled = value;
      if (enabled && !token) token = randomBytes(32).toString("hex");
      save();
      return enabled ? start() : stop();
    });
  }

  function handleDesktopEvent(channel, payload) {
    if (channel === "agent:status" && payload?.id) {
      if (payload.status === "cleared") agentStatuses.delete(payload.id);
      else agentStatuses.set(payload.id, payload);
    } else if (channel === "sessions:changed") {
      const ids = new Set(payload.map(item => item.id));
      for (const id of agentStatuses.keys()) if (!ids.has(id)) agentStatuses.delete(id);
    }
  }

  load();
  return { listInstances, getInstanceStatus, status, revealToken: () => token, setEnabled,
    start: () => enqueueLifecycle(() => enabled ? start() : status()),
    stop: () => enqueueLifecycle(stop), handleDesktopEvent };
}

module.exports = { createSessionStatusServer, workState };
