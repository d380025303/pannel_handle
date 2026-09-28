const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { mergeEnvironment } = require("../environment/index.cjs");
const { toWslHostPath } = require("../../core/wsl-paths.cjs");
const { waitForEndpoint, createCodeBuddyHttpTransport, sanitizeDiagnostic } = require("./http-transport.cjs");
const { getPromotionDisplay } = require("../workbuddy/model-catalog-values.cjs");
const { codeBuddyInheritanceArgs } = require("./codex-inheritance.cjs");
const { createAcpProviderPolicy } = require("./provider-policy.cjs");

const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const PUBLISH_COALESCE_MS = 50;
const PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const quoteBash = value => `'${String(value).replace(/'/g, "'\\''")}'`;
function createConversationRequestId() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString("hex");
}
function readAvailableCommands(commands) {
  if (!Array.isArray(commands)) return [];
  const seen = new Set();
  return commands.flatMap(command => {
    const name = typeof command?.name === "string" ? command.name.replace(/^\//, "").trim() : "";
    if (!name || /\s|\//.test(name) || seen.has(name.toLowerCase())) return [];
    seen.add(name.toLowerCase());
    return [{ name, description: typeof command.description === "string" ? command.description : "" }];
  });
}
function safeStderr(stderr, environment) {
  let detail = String(stderr || "").split(/\r?\n/).filter(line => !/^\s*Password\s+\S+\s*$/i.test(line)).join("\n");
  const secrets = [];
  for (const [name, value] of Object.entries({ ...process.env, ...environment })) {
    if (!/(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name) || value == null) continue;
    secrets.push(value);
  }
  return sanitizeDiagnostic(detail, secrets).trim().slice(-500);
}

function stopAgentChild(child, provider) {
  if ((provider === "codebuddy" || provider === "claude") && process.platform === "win32" && Number.isInteger(child.pid)) {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => child.kill());
  } else child.kill();
}

function buildInvocation(session, runtime, environment, provider = "codebuddy") {
  const commandName = provider === "claude" ? "claude-agent-acp" : provider === "opencode" ? "opencode" : "codebuddy";
  const shell = runtime.shell || session.shell || "powershell.exe";
  const inheritedArgs = provider === "codebuddy" ? codeBuddyInheritanceArgs(runtime.inheritance,
    session.type === "wsl" ? "bash" : /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell) ? "powershell" : "cmd") : "";
  const args = provider === "claude" ? "" : provider === "opencode" ? (runtime.acpArgs || "acp")
    : `${inheritedArgs ? `${inheritedArgs} ` : ""}${runtime.acpArgs || "--acp"} --serve --acp-transport streamable-http --auth password`;
  const before = runtime.localBridge ? "" : String(session.initialCommand || "").trim();
  const cwd = runtime.workspaceCwd || session.cwd;
  if (provider === "codebuddy") environment = { ...environment, CODEBUDDY_GATEWAY_AUTH: "password" };
  if (session.type === "wsl") {
    const script = `${before ? `{ ${before}; } 1>&2 && ` : ""}exec ${commandName} ${args}`;
    const inherited = String(process.env.WSLENV || "").split(":").filter(Boolean);
    const names = new Set(inherited.map(value => value.split("/")[0]));
    for (const name of Object.keys(environment)) if (!names.has(name)) inherited.push(`${name}/u`);
    return { executable: "wsl.exe", args: ["-d", session.wslDistro, "--cd", session.cwd, "--", "bash", "-lic", script],
      cwd: process.cwd(), env: { ...process.env, ...environment, WSLENV: inherited.join(":") } };
  }
  const command = `${commandName}${args ? ` ${args}` : ""}`;
  const env = mergeEnvironment([process.env, environment], true);
  if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)) {
    const script = `${before ? `& { ${before} } 1>&2; if (-not $?) { exit 1 }; ` : ""}& ${command}`;
    return { executable: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], cwd, env };
  }
  return { executable: shell, args: ["/d", "/s", "/c", `${before ? `(${before}) 1>&2 && ` : ""}${command}`], cwd, env };
}

async function createRemoteChild(transportService, session, environment, provider = "codebuddy", runtime = {}) {
  if (!transportService) throw new Error("SSH ACP 通道不可用。");
  if (provider === "codebuddy") environment = { ...environment, CODEBUDDY_GATEWAY_AUTH: "password" };
  const exports = Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error(`无效的远端环境变量：${name}`);
    return `export ${name}=${quoteBash(value)}`;
  });
  const before = String(session.initialCommand || "").trim();
  const inheritedArgs = provider === "codebuddy" ? codeBuddyInheritanceArgs(runtime.inheritance) : "";
  const commandName = provider === "claude" ? "claude-agent-acp" : provider === "opencode" ? "opencode acp" : `codebuddy ${inheritedArgs ? `${inheritedArgs} ` : ""}${runtime.acpArgs || "--acp"} --serve --acp-transport streamable-http --auth password`;
  const openCodeVersionCheck = provider === "opencode"
    ? [`version=$(opencode --version) && [[ "$version" =~ ([0-9]+)\\.[0-9]+\\.[0-9]+ ]] && (( BASH_REMATCH[1] >= 2 )) || { echo 'OpenCode V2 is required.' >&2; exit 1; }`]
    : [];
  const script = [...exports, `cd ${quoteBash(session.cwd)}`, ...openCodeVersionCheck, ...(before ? [`{ ${before}; } 1>&2`] : []), `exec ${commandName}`].join(" && ");
  const transport = await transportService.createStdioTransport(session.id, { actionName: `${provider === "claude" ? "Claude" : provider === "opencode" ? "OpenCode" : "CodeBuddy"} ACP connection`, command: `bash -lic ${quoteBash(script)}` });
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

function createCodeBuddyAcpSessionService({ environmentService, terminalManager, sessionStore, broadcast, sshAgentTransport, sshFileSystem, codexInheritanceManager,
  spawnProcess = spawn, provider = "codebuddy", resolveHttpEndpoint = waitForEndpoint,
  httpTransportFactory = createCodeBuddyHttpTransport, workBuddyModelCatalogService,
  onTokenUsageCheckpoint = () => {} }) {
  const sessions = new Map();
  const publishTimers = new Map();
  const policy = createAcpProviderPolicy(provider);
  const agentName = policy.agentName;
  function savedOptions(entry) {
    if (provider !== "codebuddy") return {};
    return (entry.session.templateId && sessionStore?.getTemplate(entry.session.templateId)?.codeBuddyGraphicalOptions)
      || entry.session.codeBuddyGraphicalOptions || {};
  }
  function saveOption(entry, key, value) {
    if (provider !== "codebuddy") return;
    const options = { ...savedOptions(entry), [key]: value };
    entry.session.codeBuddyGraphicalOptions = options;
    const running = terminalManager.getSession?.(entry.session.id);
    if (running) running.codeBuddyGraphicalOptions = options;
    if (entry.session.templateId) sessionStore?.updateLibrary(entry.session.templateId, { codeBuddyGraphicalOptions: options });
  }
  async function restoreOptions(entry) {
    if (provider !== "codebuddy") return;
    const saved = savedOptions(entry);
    for (const [key, optionId] of [["model", "model"], ["contextWindow", "context_window"], ["multitask", "multitask"]]) {
      const option = entry.configOptions.find(item => item.id === optionId);
      const value = saved[key];
      if (!option || value === undefined || option.currentValue === value
        || optionId === "multitask" && !entry.multitaskSupport
        || optionId === "multitask" && (option.type !== "boolean" || typeof value !== "boolean")
        || optionId !== "multitask" && (option.type !== "select" || !option.options?.some(item => item.value === value))) continue;
      try {
        const result = await request(entry, "session/set_config_option", { sessionId: entry.threadId, configId: optionId,
          ...(optionId === "multitask" ? { type: "boolean" } : {}), value });
        entry.configOptions = Array.isArray(result?.configOptions) ? result.configOptions
          : entry.configOptions.map(item => item.id === optionId ? { ...item, currentValue: value } : item);
      } catch (error) { console.error(`Failed to restore CodeBuddy ${optionId}:`, error); }
    }
  }
  function applySessionOptions(entry, result) {
    entry.configOptions = result.configOptions || [];
    const modeOption = entry.configOptions.find(option => option.id === "mode" && option.type === "select");
    entry.modes = result.modes?.availableModes || modeOption?.options?.map(option => ({ id: option.value, name: option.name, description: option.description })) || entry.modes;
    entry.nativeMode = result.modes?.currentModeId || modeOption?.currentValue || entry.nativeMode;
    reflectNativeMode(entry);
    updateCapabilities(entry);
  }
  async function enforceRequiredMode(entry, restoreSavedMode = false) {
    const requiredMode = entry.runtime.requiredMode;
    const modeId = requiredMode || (restoreSavedMode && provider === "codebuddy" ? savedOptions(entry).mode : undefined);
    if (!modeId) return;
    if (!entry.modes.some(mode => mode.id === modeId)) {
      if (!requiredMode) return;
      throw new Error(`${agentName} 未提供所需的 ${modeId} 模式。`);
    }
    if (entry.nativeMode === modeId) return;
    const configOption = entry.configOptions.find(option => option.id === "mode" && option.type === "select");
    let result;
    try {
      result = await request(entry, configOption ? "session/set_config_option" : "session/set_mode",
        configOption ? { sessionId: entry.threadId, configId: "mode", value: modeId } : { sessionId: entry.threadId, modeId });
    } catch (error) {
      if (requiredMode) throw error;
      console.error("Failed to restore CodeBuddy mode:", error);
      return;
    }
    if (result?.configOptions) entry.configOptions = result.configOptions;
    entry.nativeMode = modeId;
    reflectNativeMode(entry);
  }
  function updateCapabilities(entry) {
    policy.updateCapabilities(entry);
  }
  function reflectNativeMode(entry) {
    policy.reflectNativeMode(entry);
  }
  const isRemote = entry => entry.session.type === "ssh" && !entry.runtime.localBridge;
  const workspace = entry => entry.runtime.workspaceCwd || entry.session.cwd;
  function sessionParams(entry, threadId) {
    const params = { ...(threadId ? { sessionId: threadId } : {}), cwd: workspace(entry), mcpServers: [] };
    if (provider === "claude" && entry.runtime.remoteBridge) {
      const bridge = entry.runtime.remoteBridge;
      params.mcpServers = [{ name: "pannel_handle_remote", type: "http", url: bridge.url,
        headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }] }];
      params._meta = { claudeCode: { options: {
        settingSources: [], allowDangerouslySkipPermissions: false,
        disallowedTools: ["Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "Agent", "Task", "Skill", "WebFetch", "WebSearch"],
        systemPrompt: { type: "preset", preset: "claude_code", append: bridge.instructions }
      } } };
    }
    return params;
  }
  async function recordTokenUsage(entry, options = {}) {
    if (provider !== "codebuddy" || !entry.threadId) return;
    try {
      await onTokenUsageCheckpoint({ threadId: entry.threadId, session: entry.session,
        cwd: workspace(entry), model: entry.model, ...options });
    } catch (error) {
      console.error("Failed to record CodeBuddy ACP token statistics:", error);
    }
  }
  function resetUsageBaselines() {
    if (provider !== "codebuddy") return;
    for (const entry of sessions.values()) void recordTokenUsage(entry, { baseline: true });
  }
  function entryFor(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error(`${agentName} ACP 会话不存在。`);
    return entry;
  }
  function snapshot(id) {
    const entry = entryFor(id);
    return { threadId: entry.threadId, mode: entry.mode, executionPermission: entry.executionPermission,
      busy: entry.busy, error: entry.error, pendingPlan: entry.pendingPlan
        ? { itemId: entry.pendingPlan.itemId } : null, model: entry.model,
      nativeMode: entry.nativeMode, nativeModes: entry.runtime.requiredMode
        ? entry.modes.filter(mode => mode.id === entry.runtime.requiredMode) : entry.modes,
      acpOptions: entry.configOptions.filter(option => !entry.runtime.requiredMode || option.id !== "mode"),
      ...(provider === "codebuddy" ? { availableCommands: entry.availableCommands } : {}),
      ...(provider === "codebuddy" ? { codexInheritance: {
        skills: entry.runtime.inheritance?.skillNames || [],
        mcpServers: Object.keys(entry.runtime.inheritance?.mcpServers || {}),
        warnings: entry.runtime.inheritance?.warnings || []
      } } : {}),
      contextUsage: entry.contextUsage,
      items: [...entry.items], team: entry.team && { name: entry.team.name, isAutoTeam: entry.team.isAutoTeam,
        hasLiveMembers: entry.team.hasLiveMembers, members: [...entry.team.members.values()].map(member => ({ ...member, items: [...member.items] })) },
      approvals: [...entry.approvals.values()].map(value => value.display),
      questions: [...entry.questions.values()].map(({ requestId, params, submitting }) => ({ requestId, params, submitting })), capabilities: entry.capabilities, provider };
  }
  async function listModelMetadata(id) {
    const entry = entryFor(id);
    if (provider !== "codebuddy" || entry.session.type !== "windows" || !workBuddyModelCatalogService) return [];
    const catalog = await workBuddyModelCatalogService.readCatalog();
    return catalog.map(model => ({
      id: model.id,
      ...(model.creditMultiplier ? { creditMultiplier: model.creditMultiplier } : {}),
      promotions: getPromotionDisplay(model.promotions)
    }));
  }
  function publish(id) { if (sessions.has(id)) broadcast("codex-app-server:changed", { id, snapshot: snapshot(id) }); }
  // 会话重放/流式输出会密集触发 session/update；逐条全量广播会让主进程与渲染进程
  // 陷入 O(N^2) 的序列化与重渲染，导致窗口冻结。此处将 onUpdate 的广播按短窗口合并。
  function schedulePublish(id) {
    if (!sessions.has(id) || publishTimers.has(id)) return;
    const timer = setTimeout(() => { publishTimers.delete(id); publish(id); }, PUBLISH_COALESCE_MS);
    publishTimers.set(id, timer);
  }
  function clearPendingPublish(id) {
    const timer = publishTimers.get(id);
    if (timer) { clearTimeout(timer); publishTimers.delete(id); }
  }
  function status(id, entry, state, summary) {
    terminalManager.broadcastAgentStatus({ id, provider, status: state, eventName: "AcpTurn", activitySummary: summary || undefined });
  }
  function send(entry, message) {
    if (entry.httpTransport) {
      void entry.httpTransport.send({ jsonrpc: "2.0", ...message }).catch(error => entry.transportError?.(error));
      return;
    }
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
  function appendText(items, type, text, messageId, turnId) {
    if (!text) return;
    const existing = messageId ? items.find(item => item.id === messageId) : items.at(-1);
    if (existing?.type === type && existing.turnId === turnId && (messageId || existing.streaming)) existing.text += text;
    else items.push({ id: messageId || randomUUID(), type, turnId, text, streaming: true });
  }
  function appendTurnError(entry, turnId, detail) {
    if ((provider !== "codebuddy" && provider !== "claude") || !turnId || typeof detail !== "string" || !detail.trim()) return false;
    const id = `turn-error:${turnId}`;
    const existing = entry.items.find(item => item.id === id);
    if (existing) existing.text = detail;
    else entry.items.push({ id, type: "turnError", turnId, text: detail });
    return true;
  }
  function memberFor(entry, name) {
    if (!entry.team) entry.team = { name: null, isAutoTeam: false, hasLiveMembers: false, members: new Map() };
    let member = entry.team.members.get(name);
    if (!member) { member = { name, status: "unknown", items: [] }; entry.team.members.set(name, member); }
    return member;
  }
  function updateTeam(entry, value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "team_deleted") {
      if (!entry.team || !value.teamName || entry.team.name === value.teamName) entry.team = null;
      return;
    }
    if (typeof value.teamName !== "string" || !value.teamName) return;
    if (!entry.team || entry.team.name && entry.team.name !== value.teamName)
      entry.team = { name: value.teamName, isAutoTeam: false, hasLiveMembers: false, members: new Map() };
    entry.team.name = value.teamName;
    if (typeof value.isAutoTeam === "boolean") entry.team.isAutoTeam = value.isAutoTeam;
    if (typeof value.hasLiveMembers === "boolean") entry.team.hasLiveMembers = value.hasLiveMembers;
    if (value.type !== "member_status_change" || !Array.isArray(value.members)) return;
    const seen = new Set();
    for (const item of value.members) {
      if (typeof item?.name !== "string" || !item.name) continue;
      seen.add(item.name);
      const member = memberFor(entry, item.name);
      for (const key of ["color", "description", "status", "taskId", "sessionId", "tokenUsage", "toolCallCount"])
        if (item[key] !== undefined) member[key] = item[key];
    }
    for (const [name, member] of entry.team.members) if (!seen.has(name)) {
      if (member.items.length) member.status = "removed";
      else entry.team.members.delete(name);
    }
  }
  function onUpdate(id, entry, value) {
    const update = value?.update || {};
    if (provider === "codebuddy" && update.sessionUpdate === "available_commands_update") {
      const commands = readAvailableCommands(update.availableCommands);
      if (entry.awaitingSession && value.sessionId) entry.earlyCommands.set(value.sessionId, commands);
      else if (value.sessionId === entry.threadId) { entry.availableCommands = commands; schedulePublish(id); }
      return;
    }
    if (value.sessionId !== entry.threadId && value.sessionId !== entry.loadingThreadId) return;
    const kind = update.sessionUpdate;
    if (provider === "codebuddy" && kind === "session_info_update")
      updateTeam(entry, update._meta?.["codebuddy.ai/teamUpdate"]);
    const memberName = provider === "codebuddy" ? update._meta?.["codebuddy.ai/memberEvent"] : null;
    const member = typeof memberName === "string" && memberName ? memberFor(entry, memberName) : null;
    const items = member ? member.items : entry.items;
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
    const conversationRequestId = update._meta?.["codebuddy.ai/conversationRequestId"];
    const turnId = entry.unsolicitedTurns.has(requestId) ? requestId : conversationRequestId || entry.turnId;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      if (kind !== "user_message_chunk" || entry.loadingThreadId || member) appendText(items,
        kind === "user_message_chunk" ? "userMessage" : kind === "agent_message_chunk" ? "agentMessage" : "reasoning",
        update.content?.text, update.messageId, turnId);
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const toolId = update.toolCallId;
      if (toolId) {
        let item = items.find(existing => existing.id === toolId);
        if (!item) { item = { id: toolId, type: "toolCall", turnId }; items.push(item); }
        item.toolName = update.title || item.toolName || "工具调用";
        item.toolKind = update.kind || item.toolKind || "other";
        item.status = update.status || item.status;
        const output = update.content?.map(block => block.content?.text || block.content?.uri || block.text || "").filter(Boolean).join("\n");
        if (output) item.output = output;
        if (Array.isArray(update.locations)) item.locations = update.locations.map(location => ({ path: location.path, uri: location.uri }));
      }
    } else if (kind === "plan") {
      const steps = (update.entries || []).map(step => ({ step: step.content || "", status: step.status === "completed" ? "completed" : step.status === "in_progress" ? "inProgress" : "pending" }));
      const last = items.findLast(item => item.type === "turnPlan" && item.turnId === turnId);
      if (last) last.plan = steps;
      else items.push({ id: randomUUID(), type: "turnPlan", turnId, plan: steps });
    } else if (kind === "session_end" && member) {
      for (const item of items) delete item.streaming;
    } else if (kind === "session_end" && entry.unsolicitedTurns.delete(requestId)) {
      for (const item of entry.items) if (item.turnId === requestId) delete item.streaming;
      entry.busy = entry.foregroundBusy || entry.unsolicitedTurns.size > 0;
      status(id, entry, "completed");
      void recordTokenUsage(entry);
    } else if (kind === "current_mode_update") {
      entry.nativeMode = update.currentModeId;
      reflectNativeMode(entry);
      if (entry.executePlanInFullAccess && entry.nativeMode !== "plan")
        void promoteApprovedPlan(id, entry);
    } else if (kind === "available_modes_update") {
      entry.modes = update.availableModes || [];
      updateCapabilities(entry);
    } else if (kind === "config_option_update") {
      const before = entry.configOptions;
      entry.configOptions = update.configOptions || [];
      if (provider === "codebuddy" && ["model", "context_window"].some(key =>
        before.find(option => option.id === key)?.currentValue !== entry.configOptions.find(option => option.id === key)?.currentValue)) entry.contextUsage = null;
    } else if (provider === "codebuddy" && kind === "usage_update") {
      const used = update.used;
      const size = update.size;
      if (Number.isFinite(used) && used >= 0 && Number.isFinite(size) && size > 0) {
        const raw = update._meta?.["codebuddy.ai/usageByCategory"];
        const categories = {};
        for (const key of ["systemPrompt", "tools", "conversation", "mcp", "skills"]) {
          if (Number.isFinite(raw?.[key]) && raw[key] >= 0) categories[key] = raw[key];
        }
        entry.contextUsage = { used, size, categories, updatedAt: Date.now() };
      }
    }
    schedulePublish(id);
  }
  async function promoteApprovedPlan(id, entry) {
    if (!entry.executePlanInFullAccess || entry.promotingPlanMode || sessions.get(id) !== entry) return;
    const mode = entry.modes.find(value => value.id === "bypassPermissions" || value.id === "fullAccess");
    entry.executePlanInFullAccess = false;
    if (!mode) { entry.error = "当前 CodeBuddy CLI 不支持 Full Access 模式。"; publish(id); return; }
    if (entry.nativeMode === mode.id) return;
    entry.promotingPlanMode = true;
    try {
      await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId: mode.id });
      if (sessions.get(id) !== entry) return;
      entry.nativeMode = mode.id;
      reflectNativeMode(entry);
      saveOption(entry, "mode", mode.id);
      publish(id);
    } catch (error) { if (sessions.get(id) === entry) { entry.error = error.message; publish(id); } }
    finally { entry.promotingPlanMode = false; }
  }
  function onMessage(id, entry, message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = entry.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); entry.pending.delete(message.id);
      if (message.error) pending.reject(new Error(safeStderr(message.error.data?.details || message.error.message || "ACP 请求失败。", entry.environment)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") return onUpdate(id, entry, message.params);
    if (provider === "codebuddy" && message.method === "_codebuddy.ai/question") {
      const params = message.params || {};
      const prompts = params.schema?.questions;
      if ((typeof message.id !== "number" && typeof message.id !== "string")
        || params.sessionId !== entry.threadId || !Array.isArray(prompts) || !prompts.length
        || !prompts.every((prompt, index) => prompt && prompt.id === `q_${index}` && typeof prompt.question === "string" && prompt.question.trim())) {
        if (message.id !== undefined) send(entry, { id: message.id, result: { outcome: "cancelled" } });
        return;
      }
      entry.questions.set(message.id, { requestId: message.id, submitting: false, params: {
        threadId: entry.threadId, turnId: entry.turnId || "", itemId: params.toolCallId,
        questions: prompts.map(prompt => ({ id: prompt.id, header: prompt.header || "", question: prompt.question,
          multiSelect: prompt.multiSelect === true, isOther: true,
          options: Array.isArray(prompt.options) ? prompt.options.filter(option => typeof option?.label === "string" && option.label.trim())
            .map(option => ({ label: option.label, description: typeof option.description === "string" ? option.description : "" })) : null }))
      } });
      status(id, entry, "e_prompt", prompts[0].question);
      publish(id);
      return;
    }
    if (provider === "claude" && message.method === "elicitation/create") {
      const params = message.params || {};
      const properties = params.requestedSchema?.properties;
      if (params.mode !== "form" || params.sessionId !== entry.threadId || !properties || typeof properties !== "object" || Array.isArray(properties)) {
        send(entry, { id: message.id, result: { action: "cancel" } });
        return;
      }
      const customFields = Object.fromEntries(Object.entries(properties).flatMap(([key, schema]) => {
        const custom = schema?._meta?._askUserQuestionCustomAnswer;
        return custom?.isCustomAnswer && typeof custom.questionId === "string" ? [[custom.questionId, key]] : [];
      }));
      const questionEntries = Object.entries(properties).filter(([, schema]) => !schema?._meta?._askUserQuestionCustomAnswer?.isCustomAnswer);
      const questions = questionEntries.map(([key, schema]) => ({
        id: key, header: schema.title || key, question: schema.description || (questionEntries.length === 1 ? params.message : null) || schema.title || key,
        multiSelect: schema.type === "array", isOther: Boolean(customFields[key]) || !schema.enum && !schema.oneOf && !schema.anyOf && !schema.items?.enum && !schema.items?.oneOf && !schema.items?.anyOf,
        options: (schema.oneOf || schema.anyOf || schema.enum || schema.items?.oneOf || schema.items?.anyOf || schema.items?.enum || []).map(option => typeof option === "object"
          ? { label: option.title || String(option.const), description: option.description || "", value: option.const }
          : { label: String(option), description: "", value: option })
      }));
      if (!questions.length) { send(entry, { id: message.id, result: { action: "cancel" } }); return; }
      entry.questions.set(message.id, { requestId: message.id, submitting: false, elicitation: { properties, customFields, required: params.requestedSchema.required || [] },
        params: { threadId: entry.threadId, turnId: entry.turnId || "", itemId: params.toolCallId, questions } });
      status(id, entry, "e_prompt", params.message || questions[0].question);
      publish(id);
      return;
    }
    if (message.method === "session/request_permission") {
      const options = message.params?.options || [];
      const allowed = options.find(option => option.kind === "allow_once" || option.optionId === "allow-once");
      const declined = options.find(option => /reject/i.test(option.kind || "") || option.optionId === "reject");
      if (!options.length || message.params?.sessionId !== entry.threadId) {
        send(entry, { id: message.id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const call = message.params.toolCall || {};
      if (provider === "codebuddy" && call._meta?.["codebuddy.ai/toolName"] === "ExitPlanMode") {
        const plan = call._meta["codebuddy.ai/plan"];
        if (entry.mode !== "plan" || typeof plan !== "string" || !plan.trim() || !allowed?.optionId) {
          entry.error = "CodeBuddy 未提供可审阅的计划，无法批准执行。";
          send(entry, { id: message.id, result: { outcome: { outcome: "cancelled" } } });
          publish(id);
          return;
        }
        const itemId = `codebuddy-plan:${message.id}`;
        entry.items.push({ id: itemId, type: "plan", turnId: entry.turnId, text: plan });
        entry.pendingPlan = { itemId, requestId: message.id, threadId: entry.threadId,
          allowedOptionId: allowed.optionId, declinedOptionId: declined?.optionId };
        status(id, entry, "e_prompt", "审阅执行计划");
        publish(id);
        return;
      }
      if (provider === "codebuddy" && call._meta?.["codebuddy.ai/toolName"] === "AskUserQuestion") {
        const raw = typeof call.rawInput === "string" ? (() => { try { return JSON.parse(call.rawInput); } catch { return null; } })() : call.rawInput;
        const prompts = raw?.questions;
        if (!call.toolCallId || !Array.isArray(prompts) || !prompts.length
          || !prompts.every(prompt => typeof prompt?.question === "string" && prompt.question.trim())) {
          entry.error = "CodeBuddy 提问数据无效，无法显示问题。";
          send(entry, { id: message.id, result: { outcome: { outcome: "cancelled" } } });
          publish(id);
          return;
        }
        entry.questions.set(message.id, { requestId: message.id, submitting: false,
          permissionRequest: { toolCallId: call.toolCallId, allowedOptionId: allowed?.optionId },
          params: { threadId: entry.threadId, turnId: entry.turnId || "", itemId: call.toolCallId,
            questions: prompts.map((prompt, index) => ({ id: `q_${index}`, header: prompt.header || "", question: prompt.question,
              multiSelect: prompt.multiSelect === true, isOther: true,
              options: Array.isArray(prompt.options) ? prompt.options.filter(option => typeof option?.label === "string" && option.label.trim())
                .map(option => ({ label: option.label, description: typeof option.description === "string" ? option.description : "" })) : null })) } });
        status(id, entry, "e_prompt", prompts[0].question);
        publish(id);
        return;
      }
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
    if (provider === "claude" && runtime.localBridge && (!runtime.remoteBridge?.url || !runtime.remoteBridge?.token || !runtime.remoteBridge?.instructions))
      throw new Error("Claude SSH 本机桥接缺少受限远端工具配置。");
    if (provider === "codebuddy" && codexInheritanceManager && !runtime.inheritance) {
      runtime = { ...runtime, inheritance: await codexInheritanceManager.prepare(session, {
        projectCwd: runtime.workspaceCwd || session.cwd, localBridge: runtime.localBridge === true
      }) };
    }
    const environment = { ...environmentService.resolve(session), ...(runtime.runtimeEnv || {}) };
    const child = isRemote({ session, runtime })
      ? await createRemoteChild(sshAgentTransport, session, environment, provider, runtime)
      : (() => { const invocation = buildInvocation(session, runtime, environment, provider);
        return spawnProcess(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); })();
    const entry = { child, session, runtime, environment, nextId: 0, pending: new Map(), approvals: new Map(), questions: new Map(), allowedFiles: new Set(), pastedImages: new Set(), uploadedFiles: new Set(),
      threadId: null, loadingThreadId: runtime.resumeThreadId || null, turnId: null, mode: "default", nativeMode: null, modes: [], executionPermission: "askApproval", busy: false, foregroundBusy: false, unsolicitedTurns: new Set(), multitaskSupport: false,
      error: null, pendingPlan: null, items: [], team: null, model: null, configOptions: [], availableCommands: [], earlyCommands: new Map(), awaitingSession: true,
      contextUsage: null, capabilities: { history: false, plan: false, attachments: true, permissions: provider !== "opencode" } };
    entry.listedThreadIds = new Set();
    sessions.set(session.id, entry);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    if (provider !== "codebuddy") readline.createInterface({ input: child.stdout }).on("line", line => {
      try { onMessage(session.id, entry, JSON.parse(line)); }
      catch { if (sessions.get(session.id) === entry) { entry.error = `${agentName} 返回了无效 ACP 消息。`; publish(session.id); } }
    });
    function fail(error) {
      if (sessions.get(session.id) !== entry) return;
      entry.busy = false; entry.error = error.message;
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      entry.pending.clear(); entry.approvals.clear(); entry.questions.clear(); entry.pendingPlan = null; publish(session.id);
      status(session.id, entry, "exited", error.message);
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(session.id, "disconnected");
    }
    const withStderr = error => {
      const detail = safeStderr(stderr, environment);
      return detail && !String(error.message).includes(detail)
        ? new Error(`${error.message} ${entry.threadId ? "错误输出" : "启动输出"}：${detail}`) : error;
    };
    child.on("error", error => fail(withStderr(error)));
    child.on("exit", code => fail(withStderr(new Error(`${agentName} ACP 已退出（代码 ${code ?? "未知"}）。`))));
    try {
      if (provider === "codebuddy") {
        const { endpoint, password } = await resolveHttpEndpoint(child);
        child.stdout.on("data", () => {});
        if (sessions.get(session.id) !== entry) throw new Error("会话已关闭。");
        let forwarder;
        if (isRemote(entry)) {
          forwarder = await sshAgentTransport.createHttpForwarder(session.id, Number(endpoint.port));
          entry.httpForwarder = forwarder;
        }
        const transport = httpTransportFactory({ endpoint, password, agent: forwarder?.agent, closeAgent: !forwarder, child });
        entry.httpTransport = transport;
        entry.transportError = fail;
        transport.on("message", message => onMessage(session.id, entry, message));
        transport.on("error", fail);
        await transport.connect();
      }
      const initialized = await request(entry, "initialize", { protocolVersion: 1, clientInfo: { name: "pannel_handle", version: "1.0.0" }, clientCapabilities: provider === "codebuddy" ? { session: { configOptions: { boolean: {} } }, _meta: { "codebuddy.ai": { question: true } } } : provider === "claude" ? { elicitation: { form: {} } } : {} });
      entry.supportsLoad = initialized?.agentCapabilities?.loadSession === true;
      entry.multitaskSupport = initialized?.agentCapabilities?.multitaskSupport === true;
      if (runtime.resumeThreadId && initialized?.agentCapabilities?.loadSession !== true)
        throw new Error(`当前 ${agentName} CLI 不支持恢复断开的会话。`);
      entry.capabilities.history = initialized?.agentCapabilities?.loadSession === true;
      const result = await request(entry, runtime.resumeThreadId ? "session/load" : "session/new", sessionParams(entry, runtime.resumeThreadId));
      entry.threadId = result.sessionId || runtime.resumeThreadId;
      if (!entry.threadId) throw new Error(`${agentName} ACP 未返回会话 ID。`);
      entry.availableCommands = entry.earlyCommands.get(entry.threadId) || [];
      entry.earlyCommands.clear(); entry.awaitingSession = false;
      entry.loadingThreadId = null;
      applySessionOptions(entry, result);
      await enforceRequiredMode(entry, true);
      publish(session.id);
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(session.id, "connected");
      await restoreOptions(entryFor(session.id));
      if (runtime.resumeThreadId) await recordTokenUsage(entry, { resumed: true });
    } catch (error) { const failure = provider === "codebuddy" || provider === "claude" ? withStderr(error) : error; close(session.id); throw failure; }
  }
  function close(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    clearPendingPublish(id);
    sessions.delete(id);
    disposeEntry(entry);
  }
  function disposeEntry(entry) {
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("会话已关闭。")); }
    entry.pending.clear();
    entry.questions.clear();
    const finish = () => {
      entry.httpForwarder?.close();
      stopAgentChild(entry.child, provider);
    };
    if (entry.httpTransport) {
      void Promise.resolve(entry.httpTransport.close()).catch(() => {}).finally(finish);
    } else finish();
    for (const file of [...entry.pastedImages, ...entry.uploadedFiles]) {
      const hostPath = entry.session.type === "wsl" && file.startsWith("/") ? toWslHostPath(entry.session.wslDistro, file) : file;
      void (isRemote(entry) && file.startsWith("/") ? sshFileSystem.remove(entry.session.id, file) : fs.promises.rm(hostPath, { force: true })).catch(() => {});
    }
  }
  function shutdown() { for (const id of [...sessions.keys()]) close(id); }
  async function restart(id) {
    const entry = entryFor(id);
    const session = terminalManager.getSession(id);
    terminalManager.setAppServerConnectionState?.(id, "reconnecting");
    const runtime = { ...entry.runtime, resumeThreadId: entry.threadId };
    close(id);
    if (provider === "codebuddy" && codexInheritanceManager) {
      if (runtime.refreshInheritance) Object.assign(runtime, await runtime.refreshInheritance());
      else {
        await codexInheritanceManager.cleanup(id);
        delete runtime.inheritance;
      }
    }
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
    if (entry.busy || entry.pendingPlan) throw new Error("当前轮次尚未结束。");
    if (entry.approvals.size || entry.questions.size) throw new Error("请先处理当前会话的待确认请求。");
    if (!entry.capabilities.history || !entry.listedThreadIds.has(threadId)) throw new Error("只能恢复当前项目列出的历史会话。");
    if ([...sessions.values()].some(other => other !== entry && other.threadId === threadId)) throw new Error("该历史会话已在其他窗口打开。");
    const previousCommands = entry.availableCommands;
    entry.loadingThreadId = threadId;
    entry.availableCommands = []; entry.earlyCommands.clear(); entry.awaitingSession = true;
    entry.items = [];
    entry.team = null;
    entry.contextUsage = null;
    let result;
    try { result = await request(entry, "session/load", sessionParams(entry, threadId)); }
    catch (error) {
      entry.availableCommands = previousCommands;
      entry.earlyCommands.clear(); entry.awaitingSession = false;
      publish(id);
      throw error;
    } finally { entry.loadingThreadId = null; }
    entry.threadId = result.sessionId || threadId; entry.error = null; entry.pendingPlan = null;
    entry.availableCommands = entry.earlyCommands.get(entry.threadId) || [];
    entry.earlyCommands.clear(); entry.awaitingSession = false;
    applySessionOptions(entry, result);
    try { await enforceRequiredMode(entry); }
    catch (error) { close(id); throw error; }
    publish(id);
    await recordTokenUsage(entry, { resumed: true });
    return snapshot(id);
  }
  async function newThread(id) {
    const entry = entryFor(id);
    if (entry.busy || entry.pendingPlan) throw new Error("当前轮次尚未结束。");
    if (entry.approvals.size || entry.questions.size) throw new Error("请先处理当前会话的待确认请求。");
    const previousCommands = entry.availableCommands;
    entry.availableCommands = []; entry.earlyCommands.clear(); entry.awaitingSession = true;
    let result;
    try { result = await request(entry, "session/new", sessionParams(entry)); }
    catch (error) {
      entry.availableCommands = previousCommands;
      entry.earlyCommands.clear(); entry.awaitingSession = false;
      publish(id);
      throw error;
    }
    entry.threadId = result.sessionId; entry.items = []; entry.team = null; entry.error = null; entry.pendingPlan = null; entry.contextUsage = null;
    entry.availableCommands = entry.earlyCommands.get(entry.threadId) || [];
    entry.earlyCommands.clear(); entry.awaitingSession = false;
    applySessionOptions(entry, result);
    try { await enforceRequiredMode(entry, true); }
    catch (error) { close(id); throw error; }
    publish(id);
    await restoreOptions(entryFor(id));
    return snapshot(id);
  }
  async function setMode(id, mode) {
    const entry = entryFor(id);
    if (entry.runtime.requiredMode) throw new Error("本机 SSH 桥接不允许切换受限 Agent 模式。");
    if (entry.busy || entry.pendingPlan) throw new Error("当前轮次尚未结束。");
    const native = policy.findMode(entry, mode);
    if (!native) throw new Error(`当前 ${agentName} CLI 不支持${mode === "plan" ? "计划" : "执行"}模式。`);
    if (native.id === entry.nativeMode) return snapshot(id);
    if (provider === "opencode" && entry.configOptions.some(option => option.id === "mode")) return setConfigOption(id, "mode", native.id);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId: native.id });
    entry.mode = mode; entry.nativeMode = native.id; entry.pendingPlan = null;
    reflectNativeMode(entry);
    saveOption(entry, "mode", native.id);
    publish(id); return snapshot(id);
  }
  async function setNativeMode(id, modeId) {
    const entry = entryFor(id);
    if (entry.runtime.requiredMode && modeId !== entry.runtime.requiredMode) throw new Error("本机 SSH 桥接不允许切换受限 Agent 模式。");
    if (entry.busy || entry.pendingPlan) throw new Error("当前轮次尚未结束。");
    if (!entry.modes.some(mode => mode.id === modeId)) throw new Error(`当前 ${agentName} CLI 不支持此模式。`);
    if (modeId === entry.nativeMode) return snapshot(id);
    if (provider === "opencode" && entry.configOptions.some(option => option.id === "mode")) return setConfigOption(id, "mode", modeId);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId });
    entry.nativeMode = modeId; entry.pendingPlan = null;
    reflectNativeMode(entry); saveOption(entry, "mode", modeId); publish(id);
    return snapshot(id);
  }
  async function setExecutionPermission(id, permission) {
    if (provider === "opencode") throw new Error("OpenCode ACP 不支持通过此控件切换执行权限。");
    const entry = entryFor(id);
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    const nativeMode = { readOnly: "plan", askApproval: "default", fullAccess: "bypassPermissions" }[permission];
    if (!nativeMode) throw new Error("无效的执行权限。");
    const candidate = entry.modes.find(mode => mode.id === nativeMode || permission === "fullAccess" && mode.id === "fullAccess");
    if (!candidate) throw new Error(`当前 ${agentName} CLI 不支持此权限模式。`);
    if (provider === "codebuddy") return setNativeMode(id, candidate.id);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId: candidate.id });
    entry.executionPermission = permission;
    entry.nativeMode = candidate.id;
    reflectNativeMode(entry);
    saveOption(entry, "mode", candidate.id);
    publish(id); return snapshot(id);
  }
  async function setConfigOption(id, optionId, value) {
    const entry = entryFor(id);
    if (entry.runtime.requiredMode && optionId === "mode" && value !== entry.runtime.requiredMode) throw new Error("本机 SSH 桥接不允许切换受限 Agent 模式。");
    if ((provider !== "opencode" && !(provider === "codebuddy" && (optionId === "model" || optionId === "context_window"))
      && !(provider === "claude" && (optionId === "model" || optionId === "effort"))) || entry.busy)
      throw new Error("当前会话无法切换配置。");
    const option = entry.configOptions.find(item => item.id === optionId && item.type === "select");
    if (!option?.options?.some(item => item.value === value)) throw new Error(`当前 ${agentName} 会话不支持此选项。`);
    const result = await request(entry, "session/set_config_option", { sessionId: entry.threadId, configId: optionId, value });
    entry.configOptions = result?.configOptions || entry.configOptions.map(item => item.id === optionId ? { ...item, currentValue: value } : item);
    if (provider === "codebuddy" && (optionId === "model" || optionId === "context_window")) entry.contextUsage = null;
    if (provider === "codebuddy") saveOption(entry, optionId === "context_window" ? "contextWindow" : optionId, value);
    if (optionId === "mode") {
      entry.nativeMode = value;
      reflectNativeMode(entry);
    }
    publish(id);
    return snapshot(id);
  }
  function setModel(id, value) { return setConfigOption(id, "model", value); }
  function setContextWindow(id, value) { return setConfigOption(id, "context_window", value); }
  function setEffort(id, value) { return setConfigOption(id, "effort", value); }
  async function sendTeamMessage(id, teamName, memberName, text) {
    const entry = entryFor(id);
    if (provider !== "codebuddy" || !entry.httpTransport?.sendTeamMessage) throw new Error("当前会话不支持团队消息。");
    const team = entry.team;
    const member = team?.members.get(memberName);
    if (!team?.name || team.name !== teamName || !member || member.status === "removed") throw new Error("团队成员已失效，请刷新会话状态。");
    const content = String(text || "").trim();
    if (!content) throw new Error("请输入发送给成员的消息。");
    if (content.length > 20000) throw new Error("团队消息不能超过 20000 字符。");
    await entry.httpTransport.sendTeamMessage({ teamName, recipient: memberName,
      message: { from: "user", text: content, summary: content.slice(0, 50), timestamp: new Date().toISOString() } });
  }
  async function setMultitask(id, enabled) {
    const entry = entryFor(id);
    const option = entry.configOptions.find(item => item.id === "multitask" && item.type === "boolean");
    if (provider !== "codebuddy" || !entry.multitaskSupport || !option || typeof enabled !== "boolean")
      throw new Error("当前 CodeBuddy 会话不支持 Multitask 配置。");
    if (entry.busy) throw new Error("当前轮次尚未结束。");
    const result = await request(entry, "session/set_config_option", { sessionId: entry.threadId, configId: "multitask", type: "boolean", value: enabled });
    if (Array.isArray(result?.configOptions)) entry.configOptions = result.configOptions;
    else entry.configOptions = entry.configOptions.map(item => item.id === "multitask" ? { ...item, currentValue: enabled } : item);
    saveOption(entry, "multitask", enabled);
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
  async function submit(id, text, files = [], _references = [], orderedContent) {
    const entry = entryFor(id);
    if (!entry.threadId || entry.busy || entry.pendingPlan) throw new Error(`${agentName} 会话未就绪或正在运行。`);
    if (!String(text || "").trim() && !files.length) throw new Error("请输入消息或添加附件。");
    if (files.some(file => !entry.allowedFiles.has(file) && !entry.pastedImages.has(file))) throw new Error("附件未授权。");
    if (orderedContent !== undefined && (!Array.isArray(orderedContent) || orderedContent.length > 40
      || orderedContent.some(part => !part || (part.type !== "text" && part.type !== "image")
        || part.type === "text" && typeof part.text !== "string"
        || part.type === "image" && typeof part.path !== "string"))) throw new Error("无效的消息内容顺序。");
    const imageFiles = files.filter(file => IMAGE_MIME[path.extname(file).toLowerCase()]);
    const suppliedImages = orderedContent?.filter(part => part.type === "image").map(part => part.path);
    if (orderedContent && (orderedContent.filter(part => part.type === "text").map(part => part.text).join("").trim() !== String(text || "").trim()
      || suppliedImages.length !== imageFiles.length || new Set(suppliedImages).size !== imageFiles.length
      || suppliedImages.some(file => !imageFiles.includes(file)))) throw new Error("图片顺序与附件不一致。");
    const prompt = orderedContent ? [] : [{ type: "text", text: String(text || "").trim() }];
    const attachments = [];
    const imageBlocks = new Map();
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
        const block = { type: "image", mimeType: mime, data: Buffer.from(data).toString("base64") };
        if (orderedContent) imageBlocks.set(file, block);
        else prompt.push(block);
      } else prompt.push({ type: "text", text: `\n请读取以下附件文件：${JSON.stringify(agentPath)}` });
      attachments.push({ path: agentPath, name: path.basename(file) });
    }
    if (orderedContent) prompt.unshift(...orderedContent.map(part => part.type === "text" ? { type: "text", text: part.text } : imageBlocks.get(part.path)));
    entry.error = null; entry.busy = true; entry.foregroundBusy = true;
    entry.turnId = provider === "codebuddy" ? createConversationRequestId() : randomUUID(); entry.pendingPlan = null;
    entry.items.push({ id: randomUUID(), type: "userMessage", turnId: entry.turnId, text: String(text || "").trim(), attachments,
      ...(orderedContent ? { parts: orderedContent.map(part => part.type === "text" ? part : {
        type: "image", path: attachments[files.indexOf(part.path)].path, name: attachments[files.indexOf(part.path)].name }) } : {}) });
    publish(id); status(id, entry, "running", text);
    try {
      const result = await request(entry, "session/prompt", { sessionId: entry.threadId, prompt,
        ...(provider === "codebuddy" ? { _meta: { "codebuddy.ai/conversationRequestId": entry.turnId } } : {}) }, 60 * 60 * 1000);
      for (const file of files) entry.allowedFiles.delete(file);
      entry.foregroundBusy = false; entry.busy = entry.unsolicitedTurns.size > 0;
      for (const item of entry.items) if (item.turnId === entry.turnId) delete item.streaming;
      if (provider === "codebuddy") {
        const detail = typeof result?.errorMessage === "string" && result.errorMessage.trim()
          ? result.errorMessage : result?.stopReason && !["end_turn", "cancelled", "refusal"].includes(result.stopReason)
            ? `CodeBuddy 本轮未完成（${result.stopReason}）。` : "";
        appendTurnError(entry, entry.turnId, detail);
      }
      status(id, entry, result?.stopReason === "end_turn" ? "completed" : "failed"); publish(id);
      if (entry.executePlanInFullAccess) void promoteApprovedPlan(id, entry);
      void recordTokenUsage(entry);
    } catch (error) { entry.foregroundBusy = false; entry.busy = entry.unsolicitedTurns.size > 0;
      entry.error = appendTurnError(entry, entry.turnId, error.message) ? null : error.message;
      status(id, entry, "failed", error.message); publish(id); void recordTokenUsage(entry); throw error; }
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
  async function answerQuestion(id, requestId, answers) {
    if (provider !== "codebuddy" && provider !== "claude") throw new Error(`当前 ${agentName} ACP 不支持此提问格式。`);
    const entry = entryFor(id);
    const question = entry.questions.get(requestId);
    if (!question || question.submitting || question.params.threadId !== entry.threadId) throw new Error("问题请求已失效。");
    const prompts = question.params.questions;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)
      || Object.keys(answers).length !== prompts.length || prompts.some(prompt => {
        const values = answers[prompt.id]?.answers;
        return !Array.isArray(values) || !values.length || values.some(value => typeof value !== "string" || !value.trim())
          || (!prompt.multiSelect && values.length > 1);
      })) throw new Error("问题答案无效。");
    question.submitting = true; publish(id);
    try {
      if (question.elicitation) {
        const content = {};
        for (const prompt of prompts) {
          const schema = question.elicitation.properties[prompt.id];
          const values = answers[prompt.id].answers;
          const choices = schema.oneOf || schema.anyOf || schema.enum || schema.items?.oneOf || schema.items?.anyOf || schema.items?.enum || [];
          const customField = question.elicitation.customFields[prompt.id];
          const chosen = values.filter(value => choices.some(item => typeof item === "object" ? (item.title || String(item.const)) === value : String(item) === value));
          const custom = values.find(value => !chosen.includes(value));
          if (choices.length && custom && !customField) throw new Error("问题答案不在可用选项中。");
          if ((schema.type === "integer" || schema.type === "number") && values.some(value => !Number.isFinite(Number(value))))
            throw new Error("问题答案必须是数字。");
          if (customField && custom) {
            content[customField] = custom;
            continue;
          }
          const convert = value => {
            const choice = choices.find(item => typeof item === "object" ? (item.title || String(item.const)) === value : String(item) === value);
            const selected = choice === undefined ? value : typeof choice === "object" ? choice.const : choice;
            if (schema.type === "boolean") return selected === true || selected === "true";
            if (schema.type === "integer" || schema.type === "number") return Number(selected);
            return selected;
          };
          content[prompt.id] = schema.type === "array" ? chosen.length ? chosen.map(convert) : values.map(convert) : convert(values[0]);
        }
        send(entry, { id: requestId, result: { action: "accept", content } });
      } else if (question.permissionRequest) {
        const { toolCallId, allowedOptionId } = question.permissionRequest;
        const result = await request(entry, "_codebuddy.ai/resolveInterruption", { sessionId: entry.threadId, toolCallId,
          decision: "allow", answers: Object.fromEntries(prompts.map(prompt => [prompt.id, answers[prompt.id].answers])) });
        if (result?.resolved !== true) throw new Error("CodeBuddy 提问请求已失效。");
        send(entry, { id: requestId, result: { outcome: allowedOptionId
          ? { outcome: "selected", optionId: allowedOptionId } : { outcome: "cancelled" } } });
      } else {
        const result = { id: requestId, result: { outcome: "submitted",
          answers: Object.fromEntries(prompts.map(prompt => [prompt.id, answers[prompt.id].answers])) } };
        if (entry.httpTransport) await entry.httpTransport.send({ jsonrpc: "2.0", ...result });
        else send(entry, result);
      }
      if (sessions.get(id) !== entry) return;
      entry.questions.delete(requestId);
      entry.items.push({ id: `question-answer:${question.params.turnId}:${requestId}`, type: "questionAnswer", status: "submitted",
        turnId: question.params.turnId, questions: prompts.map(prompt => ({ id: prompt.id, header: prompt.header,
          question: prompt.question, answers: answers[prompt.id].answers })) });
      publish(id); status(id, entry, "running");
    } catch (error) { question.submitting = false; publish(id); throw error; }
  }
  async function cancelQuestion(id, requestId) {
    if (provider !== "codebuddy" && provider !== "claude") throw new Error(`当前 ${agentName} ACP 不支持此提问格式。`);
    const entry = entryFor(id);
    const question = entry.questions.get(requestId);
    if (!question || question.submitting || question.params.threadId !== entry.threadId) throw new Error("问题请求已失效。");
    question.submitting = true; publish(id);
    try {
      if (question.elicitation) {
        send(entry, { id: requestId, result: { action: "cancel" } });
      } else if (question.permissionRequest) {
        const result = await request(entry, "_codebuddy.ai/resolveInterruption", { sessionId: entry.threadId,
          toolCallId: question.permissionRequest.toolCallId, decision: "deny" });
        if (result?.resolved !== true && result?.queued !== true) throw new Error("CodeBuddy 提问请求已失效。");
        send(entry, { id: requestId, result: { outcome: { outcome: "cancelled" } } });
      } else {
        const result = { id: requestId, result: { outcome: "cancelled" } };
        if (entry.httpTransport) await entry.httpTransport.send({ jsonrpc: "2.0", ...result });
        else send(entry, result);
      }
      if (sessions.get(id) !== entry) return;
      entry.questions.delete(requestId);
      publish(id); status(id, entry, "running");
    } catch (error) { question.submitting = false; publish(id); throw error; }
  }
  function dismissPlan(id, itemId) {
    const entry = entryFor(id);
    const plan = entry.pendingPlan;
    if (provider !== "codebuddy" || !plan || plan.itemId !== itemId || plan.threadId !== entry.threadId)
      throw new Error("计划确认已失效。");
    send(entry, { id: plan.requestId, result: { outcome: plan.declinedOptionId
      ? { outcome: "selected", optionId: plan.declinedOptionId } : { outcome: "cancelled" } } });
    entry.pendingPlan = null;
    publish(id);
    status(id, entry, "running");
    return snapshot(id);
  }
  async function executePlan(id, itemId) {
    const entry = entryFor(id);
    const plan = entry.pendingPlan;
    if (provider !== "codebuddy" || !plan || plan.itemId !== itemId || plan.threadId !== entry.threadId)
      throw new Error("计划确认已失效。");
    send(entry, { id: plan.requestId, result: { outcome: { outcome: "selected", optionId: plan.allowedOptionId } } });
    entry.pendingPlan = null;
    entry.executePlanInFullAccess = true;
    publish(id);
    status(id, entry, "running");
  }
  return { start, restart, close, shutdown, snapshot, listModelMetadata, getWorkspaceCwd: id => workspace(entryFor(id)), resetUsageBaselines, listHistory, resume, newThread,
    setMode, setNativeMode, setModel, setContextWindow, setEffort, setMultitask, sendTeamMessage, setExecutionPermission, dismissPlan, executePlan, allowFiles, allowPastedImage, discardPastedImage, previewAttachment,
    submit, interrupt, resolveApproval, answerQuestion, cancelQuestion };
}

module.exports = { createCodeBuddyAcpSessionService, buildInvocation };
