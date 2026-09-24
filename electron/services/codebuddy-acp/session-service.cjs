const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { mergeEnvironment } = require("../environment/index.cjs");
const { toWslHostPath } = require("../../core/wsl-paths.cjs");

const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const quoteBash = value => `'${String(value).replace(/'/g, "'\\''")}'`;
function safeStderr(stderr, environment) {
  let detail = String(stderr || "");
  for (const [name, value] of Object.entries({ ...process.env, ...environment })) {
    if (!/(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name) || value == null) continue;
    const secret = String(value);
    if (secret.length >= 4) detail = detail.split(secret).join("[已隐藏]");
  }
  return detail.slice(-500);
}

function buildInvocation(session, runtime, environment, provider = "codebuddy") {
  const commandName = provider === "opencode" ? "opencode" : "codebuddy";
  const args = runtime.acpArgs || (provider === "opencode" ? "acp" : "--acp");
  const before = runtime.localBridge ? "" : String(session.initialCommand || "").trim();
  const cwd = runtime.workspaceCwd || session.cwd;
  if (session.type === "wsl") {
    const script = `${before ? `{ ${before}; } 1>&2 && ` : ""}exec ${commandName} ${args}`;
    const inherited = String(process.env.WSLENV || "").split(":").filter(Boolean);
    const names = new Set(inherited.map(value => value.split("/")[0]));
    for (const name of Object.keys(environment)) if (!names.has(name)) inherited.push(`${name}/u`);
    return { executable: "wsl.exe", args: ["-d", session.wslDistro, "--cd", session.cwd, "--", "bash", "-lic", script],
      cwd: process.cwd(), env: { ...process.env, ...environment, WSLENV: inherited.join(":") } };
  }
  const shell = runtime.shell || session.shell || "powershell.exe";
  const command = `${commandName} ${args}`;
  const env = mergeEnvironment([process.env, environment], true);
  if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)) {
    const script = `${before ? `& { ${before} } 1>&2; if (-not $?) { exit 1 }; ` : ""}& ${command}`;
    return { executable: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], cwd, env };
  }
  return { executable: shell, args: ["/d", "/s", "/c", `${before ? `(${before}) 1>&2 && ` : ""}${command}`], cwd, env };
}

async function createRemoteChild(transportService, session, environment, provider = "codebuddy") {
  if (!transportService) throw new Error("SSH ACP 通道不可用。");
  const exports = Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error(`无效的远端环境变量：${name}`);
    return `export ${name}=${quoteBash(value)}`;
  });
  const before = String(session.initialCommand || "").trim();
  const commandName = provider === "opencode" ? "opencode acp" : "codebuddy --acp";
  const script = [...exports, `cd ${quoteBash(session.cwd)}`, ...(before ? [`{ ${before}; } 1>&2`] : []), `exec ${commandName}`].join(" && ");
  const transport = await transportService.createStdioTransport(session.id, { actionName: `${provider === "opencode" ? "OpenCode" : "CodeBuddy"} ACP connection`, command: `bash -lic ${quoteBash(script)}` });
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.on("data", chunk => transport.write(chunk));
  transport.on("stdout", chunk => child.stdout.write(chunk));
  transport.on("stderr", chunk => child.stderr.write(chunk));
  transport.on("error", error => { child.emit("error", error); transport.close(); });
  transport.on("close", code => { child.stdin.end(); child.stdout.end(); child.stderr.end(); child.emit("exit", code); });
  child.kill = () => transport.close();
  return child;
}

function createCodeBuddyAcpSessionService({ environmentService, terminalManager, broadcast, sshAgentTransport, sshFileSystem,
  spawnProcess = spawn, provider = "codebuddy" }) {
  const sessions = new Map();
  const agentName = provider === "opencode" ? "OpenCode" : "CodeBuddy";
  function applySessionOptions(entry, result) {
    entry.configOptions = result.configOptions || [];
    const modeOption = entry.configOptions.find(option => option.id === "mode" && option.type === "select");
    entry.modes = result.modes?.availableModes || modeOption?.options?.map(option => ({ id: option.value, name: option.name, description: option.description })) || entry.modes;
    entry.nativeMode = result.modes?.currentModeId || modeOption?.currentValue || entry.nativeMode;
    reflectNativeMode(entry);
    updateCapabilities(entry);
  }
  async function enforceRequiredMode(entry) {
    const modeId = entry.runtime.requiredMode;
    if (!modeId) return;
    if (!entry.modes.some(mode => mode.id === modeId)) throw new Error(`${agentName} 未提供受限远程 Agent 模式。`);
    const configOption = entry.configOptions.find(option => option.id === "mode" && option.type === "select");
    const result = await request(entry, configOption ? "session/set_config_option" : "session/set_mode",
      configOption ? { sessionId: entry.threadId, configId: "mode", value: modeId } : { sessionId: entry.threadId, modeId });
    if (result?.configOptions) entry.configOptions = result.configOptions;
    entry.nativeMode = modeId;
    reflectNativeMode(entry);
  }
  function updateCapabilities(entry) {
    entry.capabilities.plan = entry.modes.some(mode => /plan/i.test(mode.id));
    entry.capabilities.multitask = provider === "codebuddy" && entry.multitaskSupport === true;
    if (provider === "opencode") {
      entry.capabilities.supportedPermissions = [];
      return;
    }
    entry.capabilities.supportedPermissions = [
      ...(entry.modes.some(mode => mode.id === "plan") ? ["readOnly"] : []),
      ...(entry.modes.some(mode => mode.id === "default") ? ["askApproval"] : []),
      ...(entry.modes.some(mode => mode.id === "bypassPermissions") ? ["fullAccess"] : [])
    ];
  }
  function reflectNativeMode(entry) {
    entry.mode = /plan/i.test(entry.nativeMode || "") ? "plan" : "default";
    if (provider === "opencode") { entry.executionPermission = "askApproval"; return; }
    entry.executionPermission = entry.nativeMode === "bypassPermissions" || entry.nativeMode === "fullAccess"
      ? "fullAccess" : entry.mode === "plan" ? "readOnly" : "askApproval";
  }
  const isRemote = entry => entry.session.type === "ssh" && !entry.runtime.localBridge;
  const workspace = entry => entry.runtime.workspaceCwd || entry.session.cwd;
  function entryFor(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error(`${agentName} ACP 会话不存在。`);
    return entry;
  }
  function snapshot(id) {
    const entry = entryFor(id);
    return { threadId: entry.threadId, mode: entry.mode, executionPermission: entry.executionPermission,
      busy: entry.busy, error: entry.error, pendingPlan: entry.pendingPlan, model: entry.model,
      nativeMode: entry.nativeMode, nativeModes: entry.runtime.requiredMode
        ? entry.modes.filter(mode => mode.id === entry.runtime.requiredMode) : entry.modes,
      acpOptions: entry.configOptions.filter(option => !entry.runtime.requiredMode || option.id !== "mode"),
      items: [...entry.items], approvals: [...entry.approvals.values()].map(value => value.display),
      questions: [], capabilities: entry.capabilities, provider };
  }
  function publish(id) { if (sessions.has(id)) broadcast("codex-app-server:changed", { id, snapshot: snapshot(id) }); }
  function status(id, entry, state, summary) {
    terminalManager.broadcastAgentStatus({ id, provider, status: state, eventName: "AcpTurn", activitySummary: summary || undefined });
  }
  function send(entry, message) {
    if (!entry.child.stdin.writable) throw new Error(`${agentName} ACP 已退出。`);
    entry.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  function request(entry, method, params, timeoutMs = 30000) {
    const id = ++entry.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { entry.pending.delete(id); reject(new Error(`${method} 超时。`)); }, timeoutMs);
      entry.pending.set(id, { resolve, reject, timer });
      try { send(entry, { id, method, params }); }
      catch (error) { clearTimeout(timer); entry.pending.delete(id); reject(error); }
    });
  }
  function appendText(entry, type, text, messageId, turnId = entry.turnId) {
    if (!text) return;
    const existing = messageId ? entry.items.find(item => item.id === messageId) : entry.items.at(-1);
    if (existing?.type === type && existing.turnId === turnId && (messageId || existing.streaming)) existing.text += text;
    else entry.items.push({ id: messageId || randomUUID(), type, turnId, text, streaming: true });
  }
  function onUpdate(id, entry, value) {
    const update = value?.update || {};
    if (value.sessionId !== entry.threadId && value.sessionId !== entry.loadingThreadId) return;
    const kind = update.sessionUpdate;
    const unsolicited = provider === "codebuddy" && kind === "session_info_update"
      ? update._meta?.["codebuddy.ai/unsolicitedTurn"] : null;
    if (unsolicited?.reason === "background_drain" && typeof unsolicited.requestId === "string" && unsolicited.requestId) {
      if (!entry.unsolicitedTurns.has(unsolicited.requestId)) {
        entry.unsolicitedTurns.add(unsolicited.requestId);
        entry.items.push({ id: `background-turn:${unsolicited.requestId}`, type: "backgroundTurn", turnId: unsolicited.requestId });
        entry.busy = true;
        status(id, entry, "running", "后台任务汇总");
      }
    }
    const requestId = update._meta?.["codebuddy.ai/requestId"];
    const turnId = entry.unsolicitedTurns.has(requestId) ? requestId : entry.turnId;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      if (kind !== "user_message_chunk" || entry.loadingThreadId) appendText(entry,
        kind === "user_message_chunk" ? "userMessage" : kind === "agent_message_chunk" ? "agentMessage" : "reasoning",
        update.content?.text, update.messageId, turnId);
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const toolId = update.toolCallId;
      if (toolId) {
        let item = entry.items.find(existing => existing.id === toolId);
        if (!item) { item = { id: toolId, type: "toolCall", turnId }; entry.items.push(item); }
        item.toolName = update.title || item.toolName || "工具调用";
        item.toolKind = update.kind || item.toolKind || "other";
        item.status = update.status || item.status;
        const output = update.content?.map(block => block.content?.text || block.content?.uri || block.text || "").filter(Boolean).join("\n");
        if (output) item.output = output;
        if (Array.isArray(update.locations)) item.locations = update.locations.map(location => ({ path: location.path, uri: location.uri }));
      }
    } else if (kind === "plan") {
      const steps = (update.entries || []).map(step => ({ step: step.content || "", status: step.status === "completed" ? "completed" : step.status === "in_progress" ? "inProgress" : "pending" }));
      const last = entry.items.findLast(item => item.type === "turnPlan" && item.turnId === turnId);
      if (last) last.plan = steps;
      else entry.items.push({ id: randomUUID(), type: "turnPlan", turnId, plan: steps });
    } else if (kind === "session_end" && entry.unsolicitedTurns.delete(requestId)) {
      for (const item of entry.items) if (item.turnId === requestId) delete item.streaming;
      entry.busy = entry.foregroundBusy || entry.unsolicitedTurns.size > 0;
      status(id, entry, "completed");
    } else if (kind === "current_mode_update") {
      entry.nativeMode = update.currentModeId;
      reflectNativeMode(entry);
    } else if (kind === "available_modes_update") {
      entry.modes = update.availableModes || [];
      updateCapabilities(entry);
    } else if (kind === "config_option_update") {
      entry.configOptions = update.configOptions || [];
    }
    publish(id);
  }
  function onMessage(id, entry, message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = entry.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); entry.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.data?.details || message.error.message || "ACP 请求失败。"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") return onUpdate(id, entry, message.params);
    if (message.method === "session/request_permission") {
      const options = message.params?.options || [];
      const allowed = options.find(option => option.kind === "allow_once");
      const declined = options.find(option => /reject/i.test(option.kind || ""));
      if (!options.length || message.params?.sessionId !== entry.threadId) {
        send(entry, { id: message.id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const call = message.params.toolCall || {};
      entry.approvals.set(message.id, { allowed: allowed?.optionId, declined: declined?.optionId,
        options: new Set(options.map(option => option.optionId)),
        display: { requestId: message.id, method: "session/request_permission", params: { itemId: call.toolCallId,
          reason: call.title || `${agentName} 请求选择`, command: call.title, changes: call.content,
          choices: options.map(option => ({ id: option.optionId, label: option.name || option.optionId })) } } });
      status(id, entry, "e_prompt", call.title);
      publish(id);
      return;
    }
    if (Object.hasOwn(message, "id")) send(entry, { id: message.id, error: { code: -32601, message: "Unsupported client method" } });
  }
  async function start(session, runtime = {}) {
    const environment = { ...environmentService.resolve(session), ...(runtime.runtimeEnv || {}) };
    const child = isRemote({ session, runtime })
      ? await createRemoteChild(sshAgentTransport, session, environment, provider)
      : (() => { const invocation = buildInvocation(session, runtime, environment, provider);
        return spawnProcess(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); })();
    const entry = { child, session, runtime, nextId: 0, pending: new Map(), approvals: new Map(), allowedFiles: new Set(), pastedImages: new Set(), uploadedFiles: new Set(),
      threadId: null, loadingThreadId: runtime.resumeThreadId || null, turnId: null, mode: "default", nativeMode: null, modes: [], executionPermission: "askApproval", busy: false, foregroundBusy: false, unsolicitedTurns: new Set(), multitaskSupport: false,
      error: null, pendingPlan: null, items: [], model: null, configOptions: [], capabilities: { history: false, plan: false, attachments: true, permissions: provider !== "opencode" } };
    entry.listedThreadIds = new Set();
    sessions.set(session.id, entry);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    readline.createInterface({ input: child.stdout }).on("line", line => {
      try { onMessage(session.id, entry, JSON.parse(line)); }
      catch { if (sessions.get(session.id) === entry) { entry.error = `${agentName} 返回了无效 ACP 消息。`; publish(session.id); } }
    });
    function fail(error) {
      if (sessions.get(session.id) !== entry) return;
      entry.busy = false; entry.error = error.message;
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      entry.pending.clear(); entry.approvals.clear(); publish(session.id);
      status(session.id, entry, "exited", error.message);
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(session.id, "disconnected");
    }
    child.on("error", fail);
    child.on("exit", code => fail(new Error(`${agentName} ACP 已退出（代码 ${code ?? "未知"}）。${stderr ? `启动输出：${safeStderr(stderr, environment)}` : ""}`)));
    try {
      const initialized = await request(entry, "initialize", { protocolVersion: 1, clientInfo: { name: "pannel_handle", version: "1.0.0" }, clientCapabilities: provider === "codebuddy" ? { session: { configOptions: { boolean: {} } } } : {} });
      entry.multitaskSupport = initialized?.agentCapabilities?.multitaskSupport === true;
      if (runtime.resumeThreadId && initialized?.agentCapabilities?.loadSession !== true)
        throw new Error(`当前 ${agentName} CLI 不支持恢复断开的会话。`);
      entry.capabilities.history = initialized?.agentCapabilities?.loadSession === true
        && Boolean(initialized?.agentCapabilities?.sessionCapabilities?.list);
      const result = await request(entry, runtime.resumeThreadId ? "session/load" : "session/new", runtime.resumeThreadId
        ? { sessionId: runtime.resumeThreadId, cwd: workspace(entry), mcpServers: [] }
        : { cwd: workspace(entry), mcpServers: [] });
      entry.threadId = result.sessionId || runtime.resumeThreadId;
      if (!entry.threadId) throw new Error(`${agentName} ACP 未返回会话 ID。`);
      entry.loadingThreadId = null;
      applySessionOptions(entry, result);
      await enforceRequiredMode(entry);
      publish(session.id);
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(session.id, "connected");
    } catch (error) { close(session.id); throw error; }
  }
  function close(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("会话已关闭。")); }
    entry.pending.clear(); entry.child.kill();
    for (const file of [...entry.pastedImages, ...entry.uploadedFiles]) {
      const hostPath = entry.session.type === "wsl" && file.startsWith("/") ? toWslHostPath(entry.session.wslDistro, file) : file;
      void (isRemote(entry) && file.startsWith("/") ? sshFileSystem.remove(id, file) : fs.promises.rm(hostPath, { force: true })).catch(() => {});
    }
  }
  function shutdown() { for (const id of [...sessions.keys()]) close(id); }
  async function restart(id) {
    const entry = entryFor(id);
    const session = terminalManager.getSession(id);
    terminalManager.setAppServerConnectionState?.(id, "reconnecting");
    const runtime = { ...entry.runtime, resumeThreadId: entry.threadId };
    close(id);
    await start(session, runtime);
    return terminalManager.listSessions().find(value => value.id === id);
  }
  async function listHistory(id, cursor = null) {
    const entry = entryFor(id);
    if (!entry.capabilities.history) throw new Error(`当前 ${agentName} CLI 不支持历史会话恢复。`);
    const result = await request(entry, "session/list", { cwd: workspace(entry), ...(cursor ? { cursor } : {}) });
    const matching = (result.sessions || []).filter(value => value.cwd === workspace(entry));
    for (const value of matching) entry.listedThreadIds.add(value.sessionId);
    return { data: matching.map(value => ({ id: value.sessionId, title: value.title || "未命名会话",
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : value.updatedAt ? Date.parse(value.updatedAt) / 1000 || 0 : 0,
      source: agentName, status: "saved" })), nextCursor: result.nextCursor || null };
  }
  async function resume(id, threadId) {
    const entry = entryFor(id);
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    if (entry.approvals.size) throw new Error("请先处理当前会话的待确认请求。");
    if (!entry.capabilities.history || !entry.listedThreadIds.has(threadId)) throw new Error("只能恢复当前项目列出的历史会话。");
    if ([...sessions.values()].some(other => other !== entry && other.threadId === threadId)) throw new Error("该历史会话已在其他窗口打开。");
    entry.loadingThreadId = threadId;
    entry.items = [];
    let result;
    try { result = await request(entry, "session/load", { sessionId: threadId, cwd: workspace(entry), mcpServers: [] }); }
    finally { entry.loadingThreadId = null; }
    entry.threadId = result.sessionId || threadId; entry.error = null; entry.pendingPlan = null;
    applySessionOptions(entry, result);
    try { await enforceRequiredMode(entry); }
    catch (error) { close(id); throw error; }
    publish(id); return snapshot(id);
  }
  async function newThread(id) {
    const entry = entryFor(id);
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    if (entry.approvals.size) throw new Error("请先处理当前会话的待确认请求。");
    const result = await request(entry, "session/new", { cwd: workspace(entry), mcpServers: [] });
    entry.threadId = result.sessionId; entry.items = []; entry.error = null; entry.pendingPlan = null;
    applySessionOptions(entry, result);
    try { await enforceRequiredMode(entry); }
    catch (error) { close(id); throw error; }
    publish(id); return snapshot(id);
  }
  async function setMode(id, mode) {
    const entry = entryFor(id);
    if (entry.runtime.requiredMode) throw new Error("本机 SSH 桥接不允许切换受限 Agent 模式。");
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    const native = entry.modes.find(value => mode === "plan" ? /plan/i.test(value.id) : /^(default|normal|code|ask|build)$/i.test(value.id));
    if (!native) throw new Error(`当前 ${agentName} CLI 不支持${mode === "plan" ? "计划" : "执行"}模式。`);
    if (provider === "opencode" && entry.configOptions.some(option => option.id === "mode")) return setConfigOption(id, "mode", native.id);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId: native.id });
    entry.mode = mode; entry.nativeMode = native.id; entry.pendingPlan = null;
    reflectNativeMode(entry);
    publish(id); return snapshot(id);
  }
  async function setNativeMode(id, modeId) {
    const entry = entryFor(id);
    if (entry.runtime.requiredMode && modeId !== entry.runtime.requiredMode) throw new Error("本机 SSH 桥接不允许切换受限 Agent 模式。");
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    if (!entry.modes.some(mode => mode.id === modeId)) throw new Error(`当前 ${agentName} CLI 不支持此模式。`);
    if (provider === "opencode" && entry.configOptions.some(option => option.id === "mode")) return setConfigOption(id, "mode", modeId);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId });
    entry.nativeMode = modeId; entry.pendingPlan = null;
    reflectNativeMode(entry); publish(id);
    return snapshot(id);
  }
  async function setExecutionPermission(id, permission) {
    if (provider === "opencode") throw new Error("OpenCode ACP 不支持通过此控件切换执行权限。");
    const entry = entryFor(id);
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    const nativeMode = { readOnly: "plan", askApproval: "default", fullAccess: "bypassPermissions" }[permission];
    if (!nativeMode) throw new Error("无效的执行权限。");
    const candidate = entry.modes.find(mode => mode.id === nativeMode);
    if (!candidate) throw new Error(`当前 ${agentName} CLI 不支持此权限模式。`);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId: candidate.id });
    entry.executionPermission = permission;
    entry.nativeMode = candidate.id;
    reflectNativeMode(entry);
    publish(id); return snapshot(id);
  }
  async function setConfigOption(id, optionId, value) {
    const entry = entryFor(id);
    if (entry.runtime.requiredMode && optionId === "mode" && value !== entry.runtime.requiredMode) throw new Error("本机 SSH 桥接不允许切换受限 Agent 模式。");
    if ((provider !== "opencode" && !(provider === "codebuddy" && optionId === "model")) || entry.busy)
      throw new Error("当前会话无法切换配置。");
    const option = entry.configOptions.find(item => item.id === optionId && item.type === "select");
    if (!option?.options?.some(item => item.value === value)) throw new Error(`当前 ${agentName} 会话不支持此选项。`);
    const result = await request(entry, "session/set_config_option", { sessionId: entry.threadId, configId: optionId, value });
    entry.configOptions = result?.configOptions || entry.configOptions.map(item => item.id === optionId ? { ...item, currentValue: value } : item);
    if (optionId === "mode") {
      entry.nativeMode = value;
      reflectNativeMode(entry);
    }
    publish(id);
    return snapshot(id);
  }
  function setModel(id, value) { return setConfigOption(id, "model", value); }
  function setEffort(id, value) { return setConfigOption(id, "effort", value); }
  async function setMultitask(id, enabled) {
    const entry = entryFor(id);
    const option = entry.configOptions.find(item => item.id === "multitask" && item.type === "boolean");
    if (provider !== "codebuddy" || !entry.multitaskSupport || !option || typeof enabled !== "boolean")
      throw new Error("当前 CodeBuddy 会话不支持 Multitask 配置。");
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    const result = await request(entry, "session/set_config_option", { sessionId: entry.threadId, configId: "multitask", type: "boolean", value: enabled });
    if (Array.isArray(result?.configOptions)) entry.configOptions = result.configOptions;
    publish(id);
    return snapshot(id);
  }
  function allowFiles(id, files) { const entry = entryFor(id); for (const file of files) entry.allowedFiles.add(file); }
  function allowPastedImage(id, file) { entryFor(id).pastedImages.add(file); }
  async function discardPastedImage(id, file) {
    const entry = entryFor(id);
    if (!entry.pastedImages.delete(file)) return;
    entry.allowedFiles.delete(file);
    if (isRemote(entry) && file.startsWith("/")) await sshFileSystem.remove(id, file);
    else await fs.promises.rm(entry.session.type === "wsl" && file.startsWith("/") ? toWslHostPath(entry.session.wslDistro, file) : file, { force: true });
  }
  async function previewAttachment(id, file) {
    const entry = entryFor(id);
    if (!entry.allowedFiles.has(file) && !entry.items.some(item => item.attachments?.some(value => value.path === file))) throw new Error("只能预览当前会话的附件。");
    const remote = isRemote(entry) && file.startsWith("/");
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
    const limit = mime ? IMAGE_LIMIT : PREVIEW_LIMIT;
    const hostPath = entry.session.type === "wsl" && file.startsWith("/") ? toWslHostPath(entry.session.wslDistro, file) : file;
    const stat = remote ? await sshFileSystem.stat(id, file) : await fs.promises.stat(hostPath);
    if (stat.size > limit) return { kind: "too_large", size: stat.size, limit };
    const data = remote ? await sshFileSystem.get(id, file) : await fs.promises.readFile(hostPath);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (mime) return { kind: "image", dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
    if (buffer.subarray(0, 4096).includes(0)) return { kind: "unsupported" };
    try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) }; }
    catch { return { kind: "unsupported" }; }
  }
  async function submit(id, text, files = []) {
    const entry = entryFor(id);
    if (!entry.threadId || entry.busy) throw new Error(`${agentName} 会话未就绪或正在运行。`);
    if (!String(text || "").trim() && !files.length) throw new Error("请输入消息或添加附件。");
    if (files.some(file => !entry.allowedFiles.has(file) && !entry.pastedImages.has(file))) throw new Error("附件未授权。");
    const prompt = [{ type: "text", text: String(text || "").trim() }];
    const attachments = [];
    for (const file of files) {
      let agentPath = file;
      if (isRemote(entry) && path.win32.isAbsolute(file)) {
        const directory = path.posix.join(await sshFileSystem.cwd(id), ".cache", "pannel-handle", "acp", randomUUID());
        await sshFileSystem.mkdir(id, directory, true);
        await sshFileSystem.chmod(id, directory, 0o700);
        agentPath = path.posix.join(directory, path.win32.basename(file));
        await sshFileSystem.fastPut(id, file, agentPath);
        entry.uploadedFiles.add(directory);
      } else if (entry.session.type === "wsl" && path.win32.isAbsolute(file)) {
        const drive = file[0].toLowerCase();
        agentPath = `/mnt/${drive}/${file.slice(3).replace(/\\/g, "/")}`;
      }
      const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
      if (mime) {
        const hostPath = entry.session.type === "wsl" && agentPath.startsWith("/") ? toWslHostPath(entry.session.wslDistro, agentPath) : file;
        const data = isRemote(entry) && agentPath.startsWith("/") ? await sshFileSystem.get(id, agentPath) : await fs.promises.readFile(hostPath);
        if (data.length > IMAGE_LIMIT) throw new Error("图片超过 10 MB。");
        prompt.push({ type: "image", mimeType: mime, data: Buffer.from(data).toString("base64") });
      } else prompt.push({ type: "text", text: `\n请读取以下附件文件：${JSON.stringify(agentPath)}` });
      attachments.push({ path: agentPath, name: path.basename(file) });
      entry.allowedFiles.delete(file);
    }
    entry.error = null; entry.busy = true; entry.foregroundBusy = true; entry.turnId = randomUUID(); entry.pendingPlan = null;
    entry.items.push({ id: randomUUID(), type: "userMessage", turnId: entry.turnId, text: String(text || "").trim(), attachments });
    publish(id); status(id, entry, "running", text);
    try {
      const result = await request(entry, "session/prompt", { sessionId: entry.threadId, prompt }, 60 * 60 * 1000);
      entry.foregroundBusy = false; entry.busy = entry.unsolicitedTurns.size > 0;
      for (const item of entry.items) if (item.turnId === entry.turnId) delete item.streaming;
      status(id, entry, result?.stopReason === "end_turn" ? "completed" : "failed"); publish(id);
    } catch (error) { entry.foregroundBusy = false; entry.busy = entry.unsolicitedTurns.size > 0; entry.error = error.message; status(id, entry, "failed", error.message); publish(id); throw error; }
  }
  function interrupt(id) { const entry = entryFor(id); send(entry, { method: "session/cancel", params: { sessionId: entry.threadId } }); }
  function resolveApproval(id, requestId, approved) {
    const entry = entryFor(id); const approval = entry.approvals.get(requestId);
    if (!approval) throw new Error("确认请求已失效。");
    const selected = typeof approved === "string" ? approved : approved ? approval.allowed : approval.declined;
    if (selected && !approval.options.has(selected)) throw new Error("无效的选择。");
    entry.approvals.delete(requestId);
    send(entry, { id: requestId, result: { outcome: selected ? { outcome: "selected", optionId: selected } : { outcome: "cancelled" } } });
    publish(id); status(id, entry, "running");
  }
  function answerQuestion() { throw new Error(`当前 ${agentName} ACP 不支持此提问格式。`); }
  function dismissPlan(id) { const entry = entryFor(id); entry.pendingPlan = null; publish(id); return snapshot(id); }
  async function executePlan(id, itemId) {
    const entry = entryFor(id);
    if (entry.pendingPlan?.itemId !== itemId) throw new Error("计划确认已失效。");
    await setMode(id, "default");
    await submit(id, "按上述计划执行。", []);
  }
  return { start, restart, close, shutdown, snapshot, getWorkspaceCwd: id => workspace(entryFor(id)), listHistory, resume, newThread,
    setMode, setNativeMode, setModel, setEffort, setMultitask, setExecutionPermission, dismissPlan, executePlan, allowFiles, allowPastedImage, discardPastedImage, previewAttachment,
    submit, interrupt, resolveApproval, answerQuestion };
}

module.exports = { createCodeBuddyAcpSessionService, buildInvocation };
