const path = require("node:path");

const JOB_ACTIONS = new Set(["reply", "stop", "respawn", "rename", "delete"]);
const PERMISSIONS = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const ISOLATION = new Set(["none", "worktree"]);
const text = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const unwrap = value => value && typeof value === "object" && Object.hasOwn(value, "data") ? value.data : value;
const rows = value => Array.isArray(value) ? value : Array.isArray(value?.jobs) ? value.jobs
  : Array.isArray(value?.items) ? value.items : Array.isArray(value?.sessions) ? value.sessions
    : Array.isArray(value?.candidates) ? value.candidates : [];
const sameCwd = (left, right) => typeof left === "string" && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();

function createCodeBuddyJobsService({ spawnProcess, resolveHttpEndpoint, httpTransportFactory, buildInvocation, stopAgentChild, broadcast }) {
  const gateways = new Map();
  const starting = new Map();
  let closing = false;
  const keyFor = context => path.win32.normalize(context.cwd).toLowerCase();

  async function gatewayFor(context) {
    if (closing) throw new Error("后台智能体服务正在关闭。");
    const key = keyFor(context);
    if (gateways.has(key)) return gateways.get(key);
    if (starting.has(key)) return starting.get(key);
    const pending = (async () => {
      const invocation = buildInvocation(context.session, { ...context.runtime, jobsGateway: true, workspaceCwd: context.cwd }, context.environment, "codebuddy");
      const child = spawnProcess(invocation.executable, invocation.args,
        { cwd: invocation.cwd, env: invocation.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      try {
        const { endpoint, password } = await resolveHttpEndpoint(child);
        if (closing) throw new Error("后台智能体服务正在关闭。");
        child.stdout?.on("data", () => {});
        child.stderr?.on("data", () => {});
        const transport = httpTransportFactory({ endpoint, password });
        const gateway = { key, cwd: context.cwd, child, transport, watchers: new Map(), cancelEvents: null, retry: null };
        gateways.set(key, gateway);
        child.once("exit", () => {
          if (gateways.get(key) === gateway) {
            gateway.cancelEvents?.(); clearTimeout(gateway.retry);
            for (const cancel of gateway.watchers.values()) cancel();
            gateways.delete(key);
            broadcast("codebuddy-jobs:event", { cwd: gateway.cwd, type: "disconnected" });
          }
        });
        subscribeEvents(gateway);
        return gateway;
      } catch (error) { stopAgentChild(child, "codebuddy"); throw error; }
    })();
    starting.set(key, pending);
    try { return await pending; } finally { starting.delete(key); }
  }

  function subscribeEvents(gateway) {
    if (closing || gateways.get(gateway.key) !== gateway) return;
    gateway.cancelEvents = gateway.transport.subscribeRest("/api/v1/jobs/events", event => {
      if (event.type !== "keepalive") broadcast("codebuddy-jobs:event", { cwd: gateway.cwd, type: event.type });
    }, () => {
      gateway.cancelEvents?.(); gateway.cancelEvents = null;
      clearTimeout(gateway.retry);
      gateway.retry = setTimeout(() => subscribeEvents(gateway), 2000);
    });
  }

  async function call(context, method, route, body) {
    const gateway = await gatewayFor(context);
    const value = unwrap(await gateway.transport.rest(method, route, body));
    if (value?.error) throw new Error(value.error.message || "CodeBuddy 后台智能体操作失败。");
    return value;
  }
  async function list(context) {
    const value = await call(context, "GET", `/api/v1/jobs?all=1&cwd=${encodeURIComponent(context.cwd)}`);
    return rows(value).filter(job => sameCwd(job.cwd, context.cwd));
  }
  async function requireJob(context, id) {
    if (!text(id, 200) || id.length > 200) throw new Error("后台智能体 ID 无效。");
    const job = (await list(context)).find(item => item.id === id);
    if (!job) throw new Error("后台智能体不属于当前项目或已不存在。");
    return job;
  }
  async function dispatchContext(context) { return call(context, "GET", "/api/v1/jobs/dispatch-context"); }
  async function resumable(context) {
    const found = [];
    let offset = 0;
    for (let page = 0; page < 50; page += 1) {
      const value = await call(context, "GET", `/api/v1/jobs/resumable?cwd=${encodeURIComponent(context.cwd)}&offset=${offset}`);
      found.push(...rows(value).filter(item => !item.cwd || sameCwd(item.cwd, context.cwd))
        .map(item => ({ ...item, cwd: context.cwd, title: item.title || item.label || item.firstUserMessage || item.sessionId })));
      if (!value?.hasMore || !Number.isSafeInteger(value.nextOffset) || value.nextOffset <= offset) break;
      offset = value.nextOffset;
    }
    return found;
  }
  async function dispatch(context, input) {
    const prompt = text(input?.prompt, 16000);
    if (!prompt) throw new Error("请输入后台智能体任务。");
    const body = { prompt, cwd: context.cwd };
    if (text(input?.name, 120)) body.name = text(input.name, 120);
    if (text(input?.agent, 120)) body.agent = text(input.agent, 120);
    if (text(input?.model, 200)) body.model = text(input.model, 200);
    if (input?.effort) { if (!EFFORTS.has(input.effort)) throw new Error("思考强度无效。"); body.effort = input.effort; }
    if (input?.permissionMode) { if (!PERMISSIONS.has(input.permissionMode)) throw new Error("权限模式无效。"); body.permissionMode = input.permissionMode; }
    if (input?.bgIsolation) { if (!ISOLATION.has(input.bgIsolation)) throw new Error("隔离模式无效。"); body.bgIsolation = input.bgIsolation; }
    if (body.agent === "minimal" && body.permissionMode === "plan") throw new Error("极简 Agent 不支持 Plan 权限模式。");
    return call(context, "POST", "/api/v1/jobs", body);
  }
  async function resume(context, sessionId) {
    if (!text(sessionId, 200) || sessionId.length > 200) throw new Error("历史会话 ID 无效。");
    if (!(await resumable(context)).some(item => item.sessionId === sessionId)) throw new Error("只能恢复当前项目可恢复的历史会话。");
    return call(context, "POST", `/api/v1/jobs/resume?cwd=${encodeURIComponent(context.cwd)}`, { sessionId });
  }
  async function transcript(context, id) {
    await requireJob(context, id);
    const value = await call(context, "GET", `/api/v1/jobs/${encodeURIComponent(id)}/transcript`);
    return { sessionId: value?.sessionId || null, updates: Array.isArray(value?.updates) ? value.updates : [] };
  }
  async function action(context, id, kind, input) {
    if (!JOB_ACTIONS.has(kind)) throw new Error("后台智能体操作无效。");
    await requireJob(context, id);
    const route = `/api/v1/jobs/${encodeURIComponent(id)}`;
    let result;
    if (kind === "reply") {
      const value = text(input?.text, 16000);
      if (!value) throw new Error("请输入回复内容。");
      result = await call(context, "POST", `${route}/reply`, { text: value, bash: false });
    } else if (kind === "rename") {
      const name = text(input?.name, 120);
      if (!name) throw new Error("请输入名称。");
      result = await call(context, "PATCH", `${route}/name`, { name });
    } else result = await call(context, kind === "delete" ? "DELETE" : "POST", kind === "delete" ? route : `${route}/${kind}`);
    if (kind === "delete" && result?.deleted === false) throw new Error(result.reason || "CodeBuddy 拒绝删除此后台智能体。");
    return result;
  }
  async function watch(context, id) {
    await requireJob(context, id);
    const gateway = await gatewayFor(context);
    gateway.watchers.get(id)?.();
    let active = true;
    let cancel;
    let retry;
    const connect = () => {
      if (!active || closing || gateways.get(gateway.key) !== gateway) return;
      broadcast("codebuddy-jobs:transcript", { cwd: gateway.cwd, jobId: id, reset: true });
      cancel = gateway.transport.subscribeRest(`/api/v1/jobs/${encodeURIComponent(id)}/stream`, event => {
        broadcast("codebuddy-jobs:transcript", { cwd: gateway.cwd, jobId: id, event: event.data });
      }, error => {
        cancel?.();
        broadcast("codebuddy-jobs:transcript", { cwd: gateway.cwd, jobId: id, error: error.message });
        retry = setTimeout(connect, 2000);
      });
    };
    gateway.watchers.set(id, () => { active = false; clearTimeout(retry); cancel?.(); });
    connect();
  }
  async function unwatch(context, id) {
    const gateway = gateways.get(keyFor(context));
    gateway?.watchers.get(id)?.(); gateway?.watchers.delete(id);
  }
  function shutdown() {
    closing = true;
    for (const gateway of gateways.values()) {
      gateway.cancelEvents?.(); clearTimeout(gateway.retry);
      for (const cancel of gateway.watchers.values()) cancel();
      void gateway.transport.close().catch(() => {});
      stopAgentChild(gateway.child, "codebuddy");
    }
    gateways.clear();
  }
  return { list, dispatchContext, resumable, dispatch, resume, transcript, action, watch, unwatch, shutdown };
}

module.exports = { createCodeBuddyJobsService };
