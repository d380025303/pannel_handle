const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { mergeEnvironment } = require("../environment/index.cjs");

function quoteBash(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function isPowerShell(shell) { return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell); }

function buildInvocation(session, runtime, environment) {
  const command = `${runtime.codexCommand || "codex"} app-server`;
  const before = String(session.initialCommand || "").trim();
  if (session.type === "wsl") {
    const script = before ? `{ ${before}; } 1>&2 && exec ${command}` : `exec ${command}`;
    const configuredNames = Object.keys(environment);
    const existing = String(process.env.WSLENV || "").split(":").filter(Boolean);
    const names = new Set(existing.map(entry => entry.split("/")[0]));
    for (const name of configuredNames) if (!names.has(name)) existing.push(`${name}/u`);
    return {
      executable: "wsl.exe",
      args: ["-d", session.wslDistro, "--cd", session.cwd, "--", "bash", "-lc", script],
      cwd: process.cwd(),
      env: { ...process.env, ...environment, WSLENV: existing.join(":") }
    };
  }
  if (isPowerShell(session.shell)) {
    const script = before ? `& { ${before} } 1>&2; if (-not $?) { exit 1 }; & ${command}` : `& ${command}`;
    return { executable: session.shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], cwd: session.cwd,
      env: mergeEnvironment([process.env, environment], true) };
  }
  const script = before ? `(${before}) 1>&2 && ${command}` : command;
  return { executable: session.shell, args: ["/d", "/s", "/c", script], cwd: session.cwd,
    env: mergeEnvironment([process.env, environment], true) };
}

function displayItem(item) {
  if (item?.type !== "userMessage") return item;
  const text = item.content?.map(part => part.type === "text" ? part.text
    : part.type === "localImage" ? `[图片：${path.basename(part.path || "")}]` : part.type === "image" ? "[图片]" : "")
    .filter(Boolean).join("\n");
  return { ...item, text: text || item.text || "" };
}

function historyItems(thread) {
  return (thread?.turns || []).flatMap(turn => turn.items || []).map(displayItem).filter(item => item?.id);
}

function createCodexAppServerSessionService({ environmentService, terminalManager, broadcast, spawnProcess = spawn, spawnSyncProcess = spawnSync }) {
  const sessions = new Map();

  function snapshot(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    return { threadId: entry.threadId, mode: entry.mode, busy: entry.busy, error: entry.error,
      items: [...entry.items], approvals: [...entry.approvals.values()].map(({ requestId, method, params }) => ({ requestId, method, params })) };
  }
  function publish(id) { broadcast("codex-app-server:changed", { id, snapshot: snapshot(id) }); }
  function send(entry, value) {
    if (!entry.child.stdin.writable) throw new Error("Codex App Server 已退出。");
    entry.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  function request(entry, method, params) {
    const id = ++entry.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { entry.pending.delete(id); reject(new Error(`${method} 超时。`)); }, 30000);
      entry.pending.set(id, { resolve, reject, timer });
      try { send(entry, { id, method, params }); }
      catch (error) { clearTimeout(timer); entry.pending.delete(id); reject(error); }
    });
  }
  function close(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    entry.child.kill();
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("会话已关闭。")); }
    entry.pending.clear();
  }
  function onMessage(id, entry, message) {
    if (sessions.get(id) !== entry) return;
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = entry.pending.get(message.id);
      if (!pending) return;
      entry.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "App Server 请求失败。"));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      const method = message.method;
      if (message.params?.threadId && message.params.threadId !== entry.threadId) return;
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
        if (entry.mode === "plan") send(entry, { id: message.id, result: method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" } : { decision: "decline" } });
        else { entry.approvals.set(message.id, { requestId: message.id, method, params: message.params || {} }); publish(id); }
      } else {
        const result = method === "item/tool/requestUserInput" ? { answers: {} }
          : method === "mcpServer/elicitation/request" ? { action: "decline", content: null } : { decision: "decline" };
        send(entry, { id: message.id, result });
      }
      return;
    }
    const params = message.params || {};
    if (params.threadId && params.threadId !== entry.threadId) return;
    if (message.method === "serverRequest/resolved") entry.approvals.delete(params.requestId);
    if (message.method === "turn/started") { entry.turnId = params.turn?.id; entry.busy = true; }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = displayItem(params.item);
      if (item?.id) {
        if (item.type === "userMessage") entry.items = entry.items.filter(value => !String(value.id).startsWith("local-"));
        const index = entry.items.findIndex(value => value.id === item.id);
        if (index < 0) entry.items.push(item); else entry.items[index] = item;
      }
    }
    if (message.method === "item/agentMessage/delta") {
      const item = entry.items.find(value => value.id === params.itemId);
      if (item) item.text = (item.text || "") + (params.delta || "");
    }
    if (message.method === "item/commandExecution/outputDelta") {
      const item = entry.items.find(value => value.id === params.itemId);
      if (item) item.output = ((item.output || "") + (params.delta || "")).slice(-16000);
    }
    if (message.method === "error") entry.error = params.error?.message || "Codex 运行失败。";
    if (message.method === "turn/completed") {
      entry.busy = false; entry.turnId = null;
      terminalManager.broadcastAgentStatus({ id, provider: "codex", status: params.turn?.status === "completed" ? "completed" : "failed", eventName: "AppServerTurn" });
    }
    publish(id);
  }

  async function start(session, runtime = {}) {
    const id = session.id;
    const environment = { ...environmentService.resolve(session), ...(runtime.runtimeEnv || {}) };
    const invocation = buildInvocation(session, runtime, environment);
    const child = spawnProcess(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const entry = { child, session, nextId: 0, pending: new Map(), approvals: new Map(), allowedFiles: new Set(), threadId: null,
      turnId: null, mode: "default", model: session.codexModel || null, busy: false, error: null, items: [] };
    sessions.set(id, entry);
    const lines = readline.createInterface({ input: child.stdout });
    child.stderr.resume();
    lines.on("line", line => {
      try { onMessage(id, entry, JSON.parse(line)); }
      catch { if (sessions.get(id) === entry) { entry.error = "App Server 返回了无效协议消息。"; publish(id); } }
    });
    child.on("error", error => {
      if (sessions.get(id) !== entry) return;
      entry.error = error.message;
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      entry.pending.clear(); publish(id);
    });
    child.on("exit", code => {
      if (sessions.get(id) !== entry) return;
      entry.busy = false;
      entry.error ||= `Codex App Server 已退出（代码 ${code ?? "未知"}）。`;
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(entry.error)); }
      entry.pending.clear(); publish(id);
      terminalManager.broadcastAgentStatus({ id, provider: "codex", status: "exited", eventName: "AppServerExit" });
    });
    try {
      await request(entry, "initialize", { clientInfo: { name: "pannel_handle", title: "Pannel Handle", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      send(entry, { method: "initialized", params: {} });
      const result = await request(entry, "thread/start", { cwd: session.cwd, approvalPolicy: "on-request", sandbox: "workspace-write", serviceName: "pannel_handle_session" });
      entry.threadId = result.thread.id;
      entry.model = result.thread.model || entry.model;
      publish(id);
      return snapshot(id);
    } catch (error) { close(id); throw error; }
  }
  function ready(id) {
    const entry = sessions.get(id);
    if (!entry?.threadId || entry.busy) throw new Error("Codex 会话未就绪或正在运行。");
    return entry;
  }
  function allowFiles(id, filePaths) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    for (const filePath of filePaths) entry.allowedFiles.add(filePath);
  }
  async function listHistory(id, cursor = null) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    const result = await request(entry, "thread/list", { cwd: entry.session.cwd, sourceKinds: ["cli", "vscode", "appServer"],
      sortKey: "updated_at", sortDirection: "desc", limit: 25, ...(cursor ? { cursor } : {}) });
    return { data: (result.data || []).map(thread => ({ id: thread.id, title: thread.name || thread.preview || "未命名会话",
      updatedAt: thread.updatedAt, source: typeof thread.source === "string" ? thread.source : "unknown",
      status: thread.status?.type || "notLoaded" })), nextCursor: result.nextCursor || null };
  }
  async function resume(id, threadId) {
    const entry = ready(id);
    if (typeof threadId !== "string" || !threadId.trim()) throw new Error("无效的历史会话。");
    if ([...sessions.entries()].some(([otherId, other]) => otherId !== id && other.threadId === threadId)) throw new Error("该历史会话已在其他窗口打开。");
    if (threadId === entry.threadId) return snapshot(id);
    const detail = await request(entry, "thread/read", { threadId, includeTurns: false });
    if (detail.thread?.cwd !== entry.session.cwd) throw new Error("只能恢复当前项目的历史会话。");
    const result = await request(entry, "thread/resume", { threadId, cwd: entry.session.cwd });
    const previousThreadId = entry.threadId;
    entry.threadId = result.thread.id;
    entry.model = result.thread.model || entry.session.codexModel || null;
    entry.items = historyItems(result.thread);
    const lastTurn = result.thread.turns?.at(-1);
    entry.busy = lastTurn?.status === "inProgress";
    entry.turnId = entry.busy ? lastTurn.id : null;
    entry.mode = "default";
    entry.error = null;
    entry.approvals.clear();
    entry.allowedFiles.clear();
    if (previousThreadId) void request(entry, "thread/unsubscribe", { threadId: previousThreadId }).catch(() => {});
    publish(id);
    return snapshot(id);
  }
  async function newThread(id) {
    const entry = ready(id);
    const result = await request(entry, "thread/start", { cwd: entry.session.cwd, approvalPolicy: "on-request",
      sandbox: "workspace-write", serviceName: "pannel_handle_session" });
    const previousThreadId = entry.threadId;
    entry.threadId = result.thread.id;
    entry.model = result.thread.model || entry.session.codexModel || null;
    entry.mode = "default";
    entry.items = [];
    entry.error = null;
    entry.approvals.clear();
    entry.allowedFiles.clear();
    if (previousThreadId) void request(entry, "thread/unsubscribe", { threadId: previousThreadId }).catch(() => {});
    publish(id);
    return snapshot(id);
  }
  function setMode(id, mode) {
    const entry = ready(id);
    if (mode !== "plan" && mode !== "default") throw new Error("无效的 Codex 模式。");
    entry.mode = mode;
    publish(id);
    return snapshot(id);
  }
  function fileInput(entry, filePath) {
    if (typeof filePath !== "string" || !path.win32.isAbsolute(filePath)) throw new Error("只能附加本地绝对路径文件。");
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("只能附加文件。");
    let targetPath = filePath;
    if (entry.session.type === "wsl") {
      const distro = entry.session.wslDistro;
      const converted = spawnSyncProcess("wsl.exe", ["-d", distro, "--", "wslpath", "-a", "-u", filePath], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      if (converted.status !== 0 || !converted.stdout?.trim()) throw new Error(`WSL 无法访问文件：${filePath}`);
      targetPath = converted.stdout.trim();
      const checked = spawnSyncProcess("wsl.exe", ["-d", distro, "--", "test", "-f", targetPath], { windowsHide: true, timeout: 10000 });
      if (checked.status !== 0) throw new Error(`WSL 无法访问文件：${filePath}`);
    }
    return { path: targetPath, image: /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath) };
  }
  async function submit(id, text, filePaths = []) {
    const entry = sessions.get(id);
    if (!entry?.threadId || entry.busy || typeof text !== "string" || !Array.isArray(filePaths) || filePaths.length > 10
      || (!text.trim() && filePaths.length === 0)) throw new Error("Codex 会话未就绪或正在运行。");
    if (filePaths.some(filePath => !entry.allowedFiles.has(filePath))) throw new Error("只能发送通过文件选择器附加的文件。");
    const files = filePaths.map(filePath => fileInput(entry, filePath));
    const fileReferences = files.filter(file => !file.image).map(file => JSON.stringify(file.path));
    const messageText = [text.trim(), ...(fileReferences.length ? [`请读取以下附件文件：${fileReferences.join("、")}`] : [])].filter(Boolean).join("\n\n");
    if (!entry.model) {
      const models = await request(entry, "model/list", {});
      entry.model = models.data?.find(model => model.isDefault)?.id || models.data?.[0]?.id;
    }
    if (!entry.model) throw new Error("无法确定 Codex 模型，不能切换协作模式。");
    entry.error = null;
    entry.busy = true;
    entry.items.push({ id: `local-${Date.now()}`, type: "userMessage",
      text: messageText || files.filter(file => file.image).map(file => `[图片：${path.basename(file.path)}]`).join("\n") });
    publish(id);
    terminalManager.broadcastAgentStatus({ id, provider: "codex", status: "running", eventName: "AppServerTurn" });
    try {
      const input = [...(messageText ? [{ type: "text", text: messageText }] : []),
        ...files.filter(file => file.image).map(file => ({ type: "localImage", path: file.path }))];
      const result = await request(entry, "turn/start", { threadId: entry.threadId, input,
        approvalPolicy: entry.mode === "plan" ? "never" : "on-request",
        sandboxPolicy: entry.mode === "plan" ? { type: "readOnly" }
          : { type: "workspaceWrite", writableRoots: [entry.session.cwd], networkAccess: false },
        collaborationMode: { mode: entry.mode, settings: { model: entry.model, developer_instructions: null } } });
      for (const filePath of filePaths) entry.allowedFiles.delete(filePath);
      if (entry.busy) entry.turnId = result.turn?.id || entry.turnId;
    }
    catch (error) { entry.busy = false; entry.error = error.message; publish(id); throw error; }
  }
  async function interrupt(id) {
    const entry = sessions.get(id);
    if (entry?.turnId) await request(entry, "turn/interrupt", { threadId: entry.threadId, turnId: entry.turnId });
  }
  function resolveApproval(id, requestId, approved) {
    const entry = sessions.get(id);
    const approval = entry?.approvals.get(requestId);
    if (!approval) throw new Error("确认请求已失效。");
    entry.approvals.delete(requestId);
    const result = approval.method === "item/permissions/requestApproval"
      ? { permissions: approved ? approval.params.permissions || {} : {}, scope: "turn" }
      : { decision: approved ? "accept" : "decline" };
    send(entry, { id: requestId, result });
    publish(id);
  }
  function shutdown() { for (const id of sessions.keys()) close(id); }
  return { start, snapshot, allowFiles, listHistory, resume, newThread, setMode, submit, interrupt, resolveApproval, close, shutdown };
}

module.exports = { createCodexAppServerSessionService, buildInvocation };
