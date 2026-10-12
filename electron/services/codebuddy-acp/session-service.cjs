const { applyCompaction, interruptCompactions } = require("../opencode-acp/compaction.cjs");
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
const { createAcpProviderPolicy } = require("./provider-policy.cjs");
const { normalizeCwd } = require("../conversation-history/history-values.cjs");
const { runOpenCodeHistoryControl, isOpenCodeMessageId } = require("../opencode-acp/history-control.cjs");
const { isRewindMessageId, runRewindControl } = require("./rewind-control.cjs");
const { emptyGoalState, applyGoalUpdate } = require("./goal-state.cjs");
const { readFormQuestions, formAnswerContent } = require("../opencode-acp/form-questions.cjs");
const { readAuthMethods, createOpenCodeAuthService } = require("../opencode-acp/auth-service.cjs");
const { normalizeAdditionalDirectories } = require("../opencode-acp/additional-directories.cjs");
const { fileResourceLink, applyStructuredToolUpdate, resourceAttachment } = require("../opencode-acp/content-values.cjs");
const { createScheduledTasksService } = require("./scheduled-tasks-service.cjs");
const { createMcpApps } = require("./mcp-apps.cjs");
const { createCodeBuddySideQuestionService } = require("./side-question-service.cjs");
const { createCodeBuddyJobsService } = require("./jobs-service.cjs");
const { cloneTokens } = require("../token-usage/token-usage-values.cjs");

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

function stopAgentChild(child, provider, { platform = process.platform, spawnKiller = spawn, onError = console.error } = {}) {
  if (child.exitCode != null || child.signalCode != null) return;
  const usesProcessTree = ["codebuddy", "opencode", "claude", "qoder", "gemini", "grok"].includes(provider);
  if (!usesProcessTree || platform !== "win32" || !Number.isInteger(child.pid)) {
    child.kill();
    return;
  }
  let failed = false;
  const fallback = error => {
    if (failed) return;
    failed = true;
    onError(`Failed to stop ${provider} process tree ${child.pid}:`, error);
    try { child.kill(); }
    catch (killError) { onError(`Failed to stop ${provider} process ${child.pid}:`, killError); }
  };
  try {
    const killer = spawnKiller("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", fallback);
    killer.once("exit", code => { if (code !== 0 && child.exitCode == null) fallback(new Error(`taskkill exited with code ${code}`)); });
  } catch (error) { fallback(error); }
}

function buildInvocation(session, runtime, environment, provider = "codebuddy") {
  if (provider === "qoder" && runtime.localBridge && !runtime.remoteBridge?.instructions)
    throw new Error("Qoder SSH 本机桥接缺少受限远端工具配置。");
  const commandName = provider === "claude" ? "claude-agent-acp" : provider === "opencode" ? "opencode" : provider === "qoder" ? "qoder" : provider === "gemini" ? "gemini" : provider === "grok" ? "grok" : "codebuddy";
  const shell = runtime.shell || session.shell || "powershell.exe";
  const args = provider === "claude" ? "" : provider === "opencode" ? (runtime.acpArgs || "acp") : provider === "gemini" ? (runtime.acpArgs || "--acp") : provider === "grok" ? "agent stdio" : provider === "qoder" ? (runtime.localBridge
    ? `--acp --tools '' --strict-mcp-config --allowed-mcp-server-names pannel_handle_remote --append-system-prompt '${String(runtime.remoteBridge.instructions).replace(/'/g, "''")}'`
    : "--acp")
    : runtime.jobsGateway ? "--serve --auth password" : `${runtime.acpArgs || "--acp"} --serve --acp-transport streamable-http --auth password`;
  const before = runtime.localBridge ? "" : String(session.initialCommand || "").trim();
  const cwd = runtime.workspaceCwd || session.cwd;
  if (provider === "codebuddy") environment = { ...environment, CODEBUDDY_GATEWAY_AUTH: "password" };
  if (provider === "codebuddy" && session.modelSource && session.modelSource !== "native") delete environment.CODEBUDDY_AUTH_TOKEN;
  if (session.type === "wsl") {
    const script = `${before ? `{ ${before}; } 1>&2 && ` : ""}exec ${commandName} ${args}`;
    const inherited = String(process.env.WSLENV || "").split(":").filter(Boolean)
      .filter(value => !(provider === "codebuddy" && session.modelSource && session.modelSource !== "native" && value.split("/")[0] === "CODEBUDDY_AUTH_TOKEN"));
    const names = new Set(inherited.map(value => value.split("/")[0]));
    for (const name of Object.keys(environment)) if (!names.has(name)) inherited.push(`${name}/u`);
    const env = { ...process.env, ...environment, WSLENV: inherited.join(":") };
    if (provider === "codebuddy" && session.modelSource && session.modelSource !== "native") delete env.CODEBUDDY_AUTH_TOKEN;
    return { executable: "wsl.exe", args: ["-d", session.wslDistro, "--cd", session.cwd, "--", "bash", "-lic", script],
      cwd: process.cwd(), env };
  }
  const command = `${commandName}${args ? ` ${args}` : ""}`;
  const env = mergeEnvironment([process.env, environment], true);
  if (provider === "codebuddy" && session.modelSource && session.modelSource !== "native") delete env.CODEBUDDY_AUTH_TOKEN;
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
  const commandName = provider === "claude" ? "claude-agent-acp" : provider === "opencode" ? "opencode acp" : provider === "qoder" ? "qoder --acp" : provider === "gemini" ? "gemini --acp" : provider === "grok" ? "grok agent stdio" : `codebuddy ${runtime.acpArgs || "--acp"} --serve --acp-transport streamable-http --auth password`;
  const openCodeVersionCheck = provider === "opencode"
    ? [`version=$(opencode --version) && [[ "$version" =~ ([0-9]+)\\.[0-9]+\\.[0-9]+ ]] && (( BASH_REMATCH[1] >= 2 )) || { echo 'OpenCode V2 is required.' >&2; exit 1; }`]
    : [];
  const script = [...exports, `cd ${quoteBash(session.cwd)}`, ...openCodeVersionCheck, ...(before ? [`{ ${before}; } 1>&2`] : []), `exec ${commandName}`].join(" && ");
  const transport = await transportService.createStdioTransport(session.id, { actionName: `${provider === "claude" ? "Claude" : provider === "opencode" ? "OpenCode" : provider === "qoder" ? "Qoder" : provider === "gemini" ? "Gemini" : "CodeBuddy"} ACP connection`, command: `bash -lic ${quoteBash(script)}` });
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

function createCodeBuddyAcpSessionService({ environmentService, terminalManager, sessionStore, broadcast, sshAgentTransport, sshFileSystem, historyService, conversationArchive,
  spawnProcess = spawn, provider = "codebuddy", resolveHttpEndpoint = waitForEndpoint,
  httpTransportFactory = createCodeBuddyHttpTransport, workBuddyModelCatalogService,
  onTokenUsageCheckpoint = () => {}, onTokenLiveEvent = () => {}, rewindControl = runRewindControl,
  spawnAuthTerminal, clearCapabilityEndpoint, openCodeControl }) {
  const sessions = new Map();
  const closingSessions = new Map();
  const historyOperations = new Set();
  const codeBuddyOperations = new Map();
  const historyTargets = new Set();
  const activeOperations = new Set();
  const publishTimers = new Map();
  const policy = createAcpProviderPolicy(provider);
  const agentName = policy.agentName;
  const auth = provider === "opencode" ? createOpenCodeAuthService({
    spawnTerminal: spawnAuthTerminal, sshAgentTransport, broadcast, changed: publish,
    getContext(id) {
      const entry = entryFor(id);
      assertHistoryIdle(entry);
      if (historyOperations.has(id)) throw new Error("会话操作正在进行，请稍后重试。");
      return { entry, session: entry.session, runtime: entry.runtime, environment: entry.environment, authMethods: entry.authMethods };
    },
    async reconnect(id, context) {
      if (sessions.get(id) !== context.entry || !terminalManager.getSession(id)) throw new Error("原图形会话已关闭或切换。");
      clearCapabilityEndpoint?.(id);
      await restart(id, true);
      if (!entryFor(id).threadId || entryFor(id).authRequired) throw new Error("OpenCode 仍需要认证，请重新登录。");
    }
  }) : null;
  const jobs = provider === "codebuddy" ? createCodeBuddyJobsService({ spawnProcess, resolveHttpEndpoint,
    httpTransportFactory, buildInvocation, stopAgentChild, broadcast }) : null;
  const sideQuestions = provider === "codebuddy" ? createCodeBuddySideQuestionService({
    getEntry: id => sessions.get(id), changed: publish, spawnProcess,
    stopChild: child => stopAgentChild(child, "codebuddy") }) : null;
  function savedOptions(entry) {
    const key = provider === "codebuddy" ? "codeBuddyGraphicalOptions" : provider === "opencode" ? "openCodeGraphicalOptions" : null;
    if (!key) return {};
    return (entry.session.templateId && sessionStore?.getTemplate(entry.session.templateId)?.[key])
      || entry.session[key] || {};
  }
  function saveOption(entry, key, value) {
    const optionsKey = provider === "codebuddy" ? "codeBuddyGraphicalOptions" : provider === "opencode" ? "openCodeGraphicalOptions" : null;
    if (!optionsKey || provider === "opencode" && key !== "model" && key !== "mode" && key !== "effort") return;
    const options = { ...savedOptions(entry), [key]: value };
    entry.session[optionsKey] = options;
    const running = terminalManager.getSession?.(entry.session.id);
    if (running) running[optionsKey] = options;
    if (entry.session.templateId) sessionStore?.updateLibrary(entry.session.templateId, { [optionsKey]: options });
  }
  async function restoreOptions(entry) {
    if (provider !== "codebuddy" && provider !== "opencode") return;
    const saved = savedOptions(entry);
    if (provider === "opencode" && !entry.runtime.requiredMode) await enforceRequiredMode(entry, true);
    for (const [key, optionId] of [["model", "model"], ["effort", "effort"], ["contextWindow", "context_window"], ["multitask", "multitask"]]) {
      if (provider === "opencode" && key !== "model" && key !== "effort") continue;
      if (provider === "codebuddy" && key === "effort") continue;
      if (provider === "codebuddy" && optionId === "model" && entry.session.modelSource && entry.session.modelSource !== "native") continue;
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
      } catch (error) { console.error(`Failed to restore ${agentName} ${optionId}:`, error); }
    }
  }
  function applySessionOptions(entry, result) {
    entry.mainAgent = null;
    entry.configOptions = result.configOptions || [];
    if ((provider === "gemini" || provider === "grok") && result.models?.availableModels?.length) {
      entry.configOptions = [...entry.configOptions.filter(option => option.id !== "model"), {
        id: "model", name: "模型", type: "select", currentValue: result.models.currentModelId,
        options: result.models.availableModels.map(model => ({ value: model.modelId, name: model.name || model.modelId }))
      }];
    }
    const modeOption = entry.configOptions.find(option => option.id === "mode" && option.type === "select");
    entry.modes = result.modes?.availableModes || modeOption?.options?.map(option => ({ id: option.value, name: option.name, description: option.description })) || entry.modes;
    if (provider === "qoder") entry.modes = entry.modes.filter(mode => ["default", "yolo", "bypassPermissions", "bypass_permissions"].includes(mode.id));
    entry.nativeMode = result.modes?.currentModeId || modeOption?.currentValue || entry.nativeMode;
    reflectNativeMode(entry);
    updateCapabilities(entry);
  }
  async function enforceRequiredMode(entry, restoreSavedMode = false) {
    const requiredMode = entry.runtime.requiredMode;
    const modeId = requiredMode || (restoreSavedMode && (provider === "codebuddy" || provider === "opencode") ? savedOptions(entry).mode : undefined);
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
      console.error(`Failed to restore ${agentName} mode:`, error);
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
    if (provider === "opencode") {
      const session = terminalManager.getSession?.(entry.session.id) || entry.session;
      const directories = normalizeAdditionalDirectories(session.openCodeAdditionalDirectories, session, entry.runtime);
      if (entry.supportsAdditionalDirectories) params.additionalDirectories = directories;
      else if (directories.length) throw new Error("当前 OpenCode CLI 不支持额外目录授权，请升级 CLI 或清空额外目录配置。");
    }
    if ((provider === "claude" || provider === "qoder") && entry.runtime.remoteBridge) {
      const bridge = entry.runtime.remoteBridge;
      params.mcpServers = [{ name: "pannel_handle_remote", type: "http", url: bridge.url,
        headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }] }];
      if (provider === "claude") params._meta = { claudeCode: { options: {
        settingSources: [], allowDangerouslySkipPermissions: false,
        disallowedTools: ["Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "Agent", "Task", "Skill", "WebFetch", "WebSearch"],
        systemPrompt: { type: "preset", preset: "claude_code", append: bridge.instructions }
      } } };
    }
    return params;
  }
  async function recordTokenUsage(entry, options = {}) {
    if ((provider !== "codebuddy" && provider !== "opencode") || !entry.threadId) return;
    const threadId = entry.threadId;
    if (options.live && entry.liveUsagePending?.threadId === threadId) return entry.liveUsagePending.promise;
    const version = entry.usageVersion = (entry.usageVersion || 0) + 1;
    const work = async () => {
      try {
        const usage = await onTokenUsageCheckpoint({ threadId, session: entry.session,
          cwd: workspace(entry), model: entry.model, environment: entry.environment, ...options });
        if (provider === "opencode" && usage?.tokens && sessions.get(entry.session.id) === entry
          && entry.threadId === threadId && entry.usageVersion === version) {
          entry.tokenUsage = { total: cloneTokens(usage.tokens), last: cloneTokens(), modelContextWindow: null };
          entry.tokenUsageThreadId = threadId;
          entry.tokenUpdatedAt = Date.now();
          publish(entry.session.id);
        }
      } catch (error) {
        console.error(`Failed to record ${agentName} ACP token statistics:`, error);
      }
    };
    const promise = work();
    if (options.live) {
      const pending = { threadId, promise };
      entry.liveUsagePending = pending;
      void promise.finally(() => { if (entry.liveUsagePending === pending) entry.liveUsagePending = null; });
    }
    return promise;
  }
  function reportTokenLive(entry, phase, options = {}) {
    if (provider !== "codebuddy" || !entry.threadId) return;
    try {
      void Promise.resolve(onTokenLiveEvent({ phase, threadId: entry.threadId, session: entry.session,
        ...options })).catch(error => console.error("Failed to update CodeBuddy ACP live tokens:", error));
    } catch (error) { console.error("Failed to update CodeBuddy ACP live tokens:", error); }
  }
  function resetUsageBaselines() {
    if (provider !== "codebuddy" && provider !== "opencode") return;
    for (const entry of sessions.values()) void recordTokenUsage(entry, { baseline: true });
  }
  function entryFor(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error(`${agentName} ACP 会话不存在。`);
    return entry;
  }
  function coalesceClaudeMessages(items) {
    const result = [];
    for (const item of items) {
      const previous = result.at(-1);
      if (item.type === "agentMessage" && previous?.type === "agentMessage"
        && previous.turnId === item.turnId && typeof previous.text === "string" && typeof item.text === "string") {
        result[result.length - 1] = { ...previous, text: previous.text + item.text };
      } else result.push(item);
    }
    return result;
  }
  function snapshot(id) {
    const entry = entryFor(id);
    if (entry.historySnapshot) return { ...entry.historySnapshot, busy: true };
    return { threadId: entry.threadId, mode: entry.mode, executionPermission: entry.executionPermission,
      busy: entry.busy || Boolean(entry.mainAgentChanging) || historyOperations.has(id) || Boolean(auth?.isActive(id)), error: entry.error, pendingPlan: entry.pendingPlan
        ? { itemId: entry.pendingPlan.itemId } : null, model: entry.model,
      nativeMode: entry.nativeMode, nativeModes: entry.runtime.requiredMode
        ? entry.modes.filter(mode => mode.id === entry.runtime.requiredMode) : entry.modes,
      acpOptions: entry.configOptions.filter(option => !entry.runtime.requiredMode || option.id !== "mode"),
      ...(provider === "opencode" ? { openCodeRetry: entry.openCodeRetry || null, acpAuth: { ...auth.snapshot(id), required: entry.authRequired,
        methods: entry.authMethods.map(({ id, name, description }) => ({ id, name, description })) } } : {}),
      ...(provider === "codebuddy" ? { codeBuddyGoal: { ...entry.codeBuddyGoal } } : {}),
      ...(provider === "codebuddy" ? { mainAgent: entry.mainAgent ? { ...entry.mainAgent, changing: Boolean(entry.mainAgentChanging) } : null } : {}),
      ...(provider === "codebuddy" || provider === "opencode" || provider === "qoder" || provider === "gemini" || provider === "grok" ? { availableCommands: entry.availableCommands } : {}),
      ...(sideQuestions ? { sideQuestion: sideQuestions.snapshot(id) } : {}),
      contextUsage: entry.contextUsage,
      ...(provider === "opencode" ? { tokenUsage: entry.tokenUsageThreadId === entry.threadId ? entry.tokenUsage || null : null,
        tokenUpdatedAt: entry.tokenUsageThreadId === entry.threadId ? entry.tokenUpdatedAt : null,
        outputRateAvailable: false } : {}),
      ...(provider === "opencode" ? { openCodeRevert: entry.openCodeRevert || null, historyActionsError: entry.historyActionsError || null } : {}),
      items: provider === "claude" ? coalesceClaudeMessages(entry.items) : [...entry.items], team: entry.team && { name: entry.team.name, isAutoTeam: entry.team.isAutoTeam,
        hasLiveMembers: entry.team.hasLiveMembers, members: [...entry.team.members.values()].map(member => ({ ...member, items: [...member.items] })) },
      approvals: [...entry.approvals.values()].map(value => value.display),
      questions: [...entry.questions.values()].map(({ requestId, params, submitting }) => ({ requestId, params, submitting })),
      capabilities: { ...entry.capabilities, sideQuestion: provider === "codebuddy" && entry.session.type === "windows" && !entry.runtime.localBridge, rewind: provider === "codebuddy" && entry.session.type === "windows"
        && !entry.runtime.localBridge && isRewindMessageId(entry.threadId) }, provider };
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
  function status(id, entry, state, summary, eventName = "AcpTurn") {
    terminalManager.broadcastAgentStatus({ id, provider, status: state, eventName, activitySummary: summary || undefined });
  }
  function send(entry, message, onSent) {
    if (entry.httpTransport) {
      void entry.httpTransport.send({ jsonrpc: "2.0", ...message }, { onSent }).then(() => onSent?.()).catch(error => entry.transportError?.(error));
      return;
    }
    if (!entry.child.stdin.writable) throw new Error(`${agentName} ACP 已退出。`);
    entry.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    onSent?.();
  }
  function request(entry, method, params, timeoutMs = 30000, onSent) {
    const id = ++entry.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { entry.pending.delete(id); reject(new Error(`${method} 超时。`)); }, timeoutMs);
      entry.pending.set(id, { resolve, reject, timer });
      try { send(entry, { id, method, params }, onSent); }
      catch (error) { clearTimeout(timer); entry.pending.delete(id); reject(error); }
    });
  }
  function appendText(items, type, text, messageId, turnId) {
    if (!text) return;
    if (provider === "claude" && type === "agentMessage") {
      const previous = items.at(-1);
      if (previous?.type === type && previous.turnId === turnId && previous.streaming) previous.text += text;
      else items.push({ id: messageId && !items.some(item => item.id === messageId) ? messageId : randomUUID(),
        type, turnId, text, streaming: true });
      return;
    }
    const existing = messageId ? items.find(item => item.id === messageId) : items.at(-1);
    if (existing?.type === type && existing.turnId === turnId && (messageId || existing.streaming)) existing.text += text;
    else items.push({ id: messageId || randomUUID(), type, turnId, text, streaming: true });
  }
  function appendTurnError(entry, turnId, detail) {
    if ((provider !== "codebuddy" && provider !== "claude" && provider !== "qoder" && provider !== "gemini" && provider !== "grok") || !turnId || typeof detail !== "string" || !detail.trim()) return false;
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
    if (entry.forkReplay && value?.sessionId !== entry.threadId) {
      entry.forkReplay.push(value);
      return;
    }
    const update = value?.update || {};
    if (provider === "opencode" && entry.awaitingSession && update.sessionUpdate === "usage_update"
      && value.sessionId && Number.isFinite(update.used) && update.used >= 0
      && Number.isFinite(update.size) && update.size > 0) {
      entry.earlyContextUsage.set(value.sessionId, value);
      return;
    }
    if ((provider === "codebuddy" || provider === "opencode" || provider === "qoder" || provider === "gemini" || provider === "grok") && update.sessionUpdate === "available_commands_update") {
      const commands = readAvailableCommands(update.availableCommands);
      if (entry.awaitingSession && value.sessionId) entry.earlyCommands.set(value.sessionId, commands);
      else if (value.sessionId === entry.threadId) { entry.availableCommands = commands; schedulePublish(id); }
      return;
    }
    if (value.sessionId !== entry.threadId && value.sessionId !== entry.loadingThreadId) return;
    const kind = update.sessionUpdate;
    if (provider === "opencode" && kind === "session_info_update"
      && value.sessionId === entry.threadId && entry.foregroundBusy && !entry.openCodeRetryCancelled
      && Object.hasOwn(update._meta || {}, "opencode/retry")) {
      const retry = update._meta["opencode/retry"];
      if (retry === null) entry.openCodeRetry = null;
      else if (retry && Number.isInteger(retry.attempt) && retry.attempt > 0) {
        const error = retry.error || {};
        entry.openCodeRetry = { attempt: retry.attempt,
          nextRetryAt: typeof retry.nextRetryAt === "string" && Number.isFinite(Date.parse(retry.nextRetryAt)) ? retry.nextRetryAt : null,
          error: { type: typeof error.type === "string" ? safeStderr(error.type, entry.environment) : "",
            message: typeof error.message === "string" ? safeStderr(error.message, entry.environment) : "",
            ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) } };
      }
    }
    if (provider === "opencode" && applyCompaction(entry.items, update, entry.turnId)) { schedulePublish(id); return; }
    if (provider === "codebuddy" && kind === "session_info_update") {
      const interruption = update._meta?.["codebuddy.ai/interruptionRequest"];
      if (interruption?.mcpUiIntercept === true && typeof interruption.toolCallId === "string") {
        void entry.mcpApps.interruption(value.sessionId, interruption).then(handled => {
          if (handled || sessions.get(id) !== entry || entry.threadId !== value.sessionId) return;
          const key = `mcp-app:${interruption.toolCallId}`;
          entry.approvals.set(key, { interruption: interruption.toolCallId, threadId: value.sessionId,
            allowed: "allow", declined: "deny", options: new Set(["allow", "deny"]),
            display: { requestId: key, method: "MCP App", params: { itemId: interruption.toolCallId,
              command: interruption.toolName, reason: interruption.toolTitle || "MCP App 工具请求授权", changes: interruption.toolInput,
              choices: [{ id: "allow", label: "允许本次" }, { id: "deny", label: "拒绝" }] } } });
          publish(id);
        }).catch(error => { if (sessions.get(id) === entry) { entry.error = error.message; publish(id); } });
      }
      const event = update._meta?.["codebuddy.ai/mcpFirstRunStatus"];
      if (event?.event === "server" && typeof event.name === "string" && ["connecting", "ready", "failed", "timeout"].includes(event.state)) {
        entry.mcpStatuses.set(event.name, { name: event.name, status: event.state,
          error: typeof event.error === "string" ? sanitizeDiagnostic(event.error).slice(0, 4096) : null, updatedAt: Date.now() });
      }
    }
    if (provider === "codebuddy" && kind === "session_info_update")
      applyGoalUpdate(entry.codeBuddyGoal, update._meta);
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
        if (!entry.foregroundBusy && entry.unsolicitedTurns.size === 1) reportTokenLive(entry, "turnStart");
      }
    }
    const requestId = update._meta?.["codebuddy.ai/requestId"];
    const conversationRequestId = update._meta?.["codebuddy.ai/conversationRequestId"];
    const turnId = entry.unsolicitedTurns.has(requestId) ? requestId : conversationRequestId || entry.turnId;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      if (kind === "user_message_chunk" && !entry.loadingThreadId && !member) {
        const submitted = items.findLast(item => item.type === "userMessage" && item.turnId === turnId);
        if (submitted && (provider === "opencode" ? isOpenCodeMessageId(update.messageId) : isRewindMessageId(update.messageId))) submitted.rewindMessageId = update.messageId;
      } else if (kind !== "user_message_chunk" || entry.loadingThreadId || member) {
        if (provider === "opencode" && kind === "user_message_chunk") {
          const attachment = resourceAttachment(update.content);
          if (attachment) {
            let loaded = update.messageId ? items.find(item => item.id === update.messageId) : items.findLast(item => item.type === "userMessage" && item.turnId === turnId);
            if (!loaded) { loaded = { id: update.messageId || randomUUID(), type: "userMessage", turnId, text: "", attachments: [] }; items.push(loaded); }
            loaded.attachments ||= [];
            if (!loaded.attachments.some(file => file.path === attachment.path)) loaded.attachments.push(attachment);
          }
        }
        appendText(items, kind === "user_message_chunk" ? "userMessage" : kind === "agent_message_chunk" ? "agentMessage" : "reasoning",
          update.content?.text, update.messageId, turnId);
        if (kind === "user_message_chunk" && (provider === "opencode" ? isOpenCodeMessageId(update.messageId) : isRewindMessageId(update.messageId))) {
          const loaded = items.findLast(item => item.type === "userMessage" && item.id === update.messageId);
          if (loaded) loaded.rewindMessageId = update.messageId;
        }
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const toolId = update.toolCallId;
      if (toolId) {
        let item = items.find(existing => existing.id === toolId);
        if (!item) { item = { id: toolId, type: "toolCall", turnId }; items.push(item); }
        item.toolName = update.title || item.toolName || "工具调用";
        item.toolKind = update.kind || item.toolKind || "other";
        const nativeTool = update._meta?.["codebuddy.ai/toolName"];
        if (provider === "codebuddy" && typeof nativeTool === "string" && nativeTool.startsWith("mcp__")) item.tool = nativeTool;
        item.status = update.status || item.status;
        if (provider === "codebuddy" && entry.session.type === "windows" && !entry.runtime.localBridge) {
          try { entry.mcpApps.update(value.sessionId, item, update._meta?.["codebuddy.ai"]?.toolMetaData?.mcpUi, update); }
          catch (error) { item.output = error.message; }
        }
        if (provider === "opencode") applyStructuredToolUpdate(item, update);
        else {
          const output = update.content?.map(block => block.content?.text || block.content?.uri || block.text || "").filter(Boolean).join("\n");
          if (output) item.output = output;
          if (Array.isArray(update.locations)) item.locations = update.locations.map(location => ({ path: location.path, uri: location.uri }));
        }
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
      if (!entry.busy) reportTokenLive(entry, "turnEnd");
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
      if ((provider === "codebuddy" || provider === "opencode") && ["model", "context_window"].some(key =>
        before.find(option => option.id === key)?.currentValue !== entry.configOptions.find(option => option.id === key)?.currentValue)) entry.contextUsage = null;
    } else if ((provider === "codebuddy" || provider === "opencode") && kind === "usage_update") {
      const used = update.used;
      const size = update.size;
      if (Number.isFinite(used) && used >= 0 && Number.isFinite(size) && size > 0) {
        const raw = update._meta?.["codebuddy.ai/usageByCategory"];
        const categories = {};
        for (const key of ["systemPrompt", "tools", "conversation", "mcp", "skills"]) {
          if (Number.isFinite(raw?.[key]) && raw[key] >= 0) categories[key] = raw[key];
        }
        entry.contextUsage = { used, size, categories, updatedAt: Date.now() };
        if (provider === "opencode" && entry.openCodeUsageReady && !entry.loadingThreadId
          && !entry.forkReplay && !historyOperations.has(id)) void recordTokenUsage(entry, { live: true });
      }
    }
    schedulePublish(id);
  }
  function replayContextUsage(entry) {
    const update = entry.earlyContextUsage.get(entry.threadId)?.update;
    entry.earlyContextUsage.clear();
    if (update) entry.contextUsage = { used: update.used, size: update.size, categories: {}, updatedAt: Date.now() };
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
      if (provider === "opencode" && message.error?.code === -32000) {
        entry.authRequired = true; publish(id);
      }
      if (message.error) pending.reject(Object.assign(new Error(safeStderr(message.error.data?.details || message.error.message || "ACP 请求失败。", entry.environment)), { code: message.error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (sessions.get(id) !== entry) return;
    if (message.method === "session/update") return onUpdate(id, entry, message.params);
    if (provider === "opencode" && message.method === "$/cancel_request") {
      const requestId = message.params?.requestId;
      if (entry.questions.get(requestId)?.openCodeForm) {
        send(entry, { id: requestId, result: { action: "cancel" } });
        entry.questions.delete(requestId);
        publish(id);
      }
      return;
    }
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
    if (provider === "opencode" && message.method === "elicitation/create") {
      if (typeof message.id !== "number" && typeof message.id !== "string") return;
      if (entry.questions.has(message.id)) return;
      const params = message.params || {};
      const form = !entry.transportClosed && entry.threadId && params.mode === "form" && params.sessionId === entry.threadId
        ? readFormQuestions(params.requestedSchema) : null;
      if (!form) { send(entry, { id: message.id, result: { action: "cancel" } }); return; }
      if (form.questions.length === 1 && !params.requestedSchema.properties[form.questions[0].id].description)
        form.questions[0].question = params.message || form.questions[0].question;
      entry.questions.set(message.id, { requestId: message.id, submitting: false, openCodeForm: form,
        params: { threadId: entry.threadId, turnId: entry.turnId || "", itemId: params.toolCallId, questions: form.questions } });
      status(id, entry, "e_prompt", params.message || form.questions[0].question, "AcpQuestion");
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
        if (typeof plan !== "string" || !plan.trim() || !allowed?.optionId) {
          entry.error = "CodeBuddy 未提供可审阅的计划，无法批准执行。";
          send(entry, { id: message.id, result: { outcome: { outcome: "cancelled" } } });
          publish(id);
          return;
        }
        if ([entry.pendingPlan, ...entry.queuedPlans].some(plan => plan?.requestId === message.id)) return;
        const itemId = `codebuddy-plan:${message.id}`;
        entry.items.push({ id: itemId, type: "plan", turnId: entry.turnId, text: plan });
        const pending = { itemId, requestId: message.id, threadId: entry.threadId,
          promoteParent: entry.mode === "plan",
          allowedOptionId: allowed.optionId, declinedOptionId: declined?.optionId };
        if (entry.pendingPlan) entry.queuedPlans.push(pending);
        else entry.pendingPlan = pending;
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
    await closingSessions.get(session.id);
    const authGeneration = runtime.authGeneration;
    runtime = { ...runtime }; delete runtime.authGeneration;
    const loginClosed = () => authGeneration != null && (!auth?.isActive(session.id) || auth.snapshot(session.id).generation !== authGeneration);
    if (loginClosed()) throw new Error("原图形会话已关闭。");
    if ((provider === "claude" || provider === "qoder") && runtime.localBridge && (!runtime.remoteBridge?.url || !runtime.remoteBridge?.token || !runtime.remoteBridge?.instructions))
      throw new Error(`${agentName} SSH 本机桥接缺少受限远端工具配置。`);
    const environment = { ...environmentService.resolve(session), ...(runtime.runtimeEnv || {}) };
    const child = isRemote({ session, runtime })
      ? await createRemoteChild(sshAgentTransport, session, environment, provider, runtime)
      : (() => { const invocation = buildInvocation(session, runtime, environment, provider);
        return spawnProcess(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); })();
    if (loginClosed()) { stopAgentChild(child, provider); throw new Error("原图形会话已关闭。"); }
    const entry = { child, session, runtime, environment, nextId: 0, pending: new Map(), approvals: new Map(), questions: new Map(), allowedFiles: new Set(), pastedImages: new Set(), uploadedFiles: new Set(),
      threadId: null, loadingThreadId: runtime.resumeThreadId || null, turnId: null, mode: "default", nativeMode: null, modes: [], executionPermission: "askApproval", busy: false, foregroundBusy: false, unsolicitedTurns: new Set(), multitaskSupport: false,
      error: null, pendingPlan: null, queuedPlans: [], items: [], team: null, model: null, configOptions: [], availableCommands: [], earlyCommands: new Map(), awaitingSession: true,
      authMethods: [], authRequired: false,
      codeBuddyGoal: emptyGoalState(),
      contextUsage: null, earlyContextUsage: new Map(), capabilities: { history: false, plan: false, attachments: true, permissions: provider !== "opencode" } };
    if (provider === "opencode" && runtime.retainedTimeline) {
      entry.allowedFiles = new Set(runtime.retainedTimeline.allowedFiles);
      entry.pastedImages = new Set(runtime.retainedTimeline.pastedImages);
      entry.uploadedFiles = new Set(runtime.retainedTimeline.uploadedFiles);
    }
    entry.listedThreadIds = new Set();
    entry.mcpStatuses = new Map();
    entry.mcpApps = createMcpApps({ current: () => {
      if (entryFor(session.id) !== entry) throw new Error("MCP App 所属进程已失效。");
      return entry;
    }, request });
    sessions.set(session.id, entry);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    if (provider !== "codebuddy") readline.createInterface({ input: child.stdout }).on("line", line => {
      try { onMessage(session.id, entry, JSON.parse(line)); }
      catch { if (sessions.get(session.id) === entry) { entry.error = `${agentName} 返回了无效 ACP 消息。`; publish(session.id); } }
    });
    function fail(error) {
      if (sessions.get(session.id) !== entry) {
        for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        entry.pending.clear();
        return;
      }
      if (provider === "opencode") interruptCompactions(entry.items);
      entry.openCodeRetry = null; entry.busy = false; entry.error = error.message;
      if (provider === "opencode") entry.transportClosed = true;
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      entry.pending.clear(); entry.approvals.clear(); entry.questions.clear(); entry.pendingPlan = null; entry.queuedPlans = [];
      entry.executePlanInFullAccess = false; publish(session.id);
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
      const initialized = await request(entry, "initialize", { protocolVersion: 1, clientInfo: { name: "pannel_handle", version: "1.0.0" }, clientCapabilities: provider === "codebuddy" ? { session: { configOptions: { boolean: {} } }, _meta: { "codebuddy.ai": { question: true, goalSnapshotReplay: true, ...(!runtime.localBridge && !runtime.requiredMode ? { mainAgentSupport: true } : {}) } } } : provider === "claude" ? { elicitation: { form: {} } } : provider === "opencode" ? { auth: { terminal: true }, elicitation: { form: {} }, session: { compaction: {} } } : {} });
      if (provider === "opencode") entry.authMethods = readAuthMethods(initialized?.authMethods);
      if (provider === "qoder" && runtime.localBridge && initialized?.agentCapabilities?.mcpCapabilities?.http !== true)
        throw new Error("Qoder ACP 不支持 SSH 本机桥接所需的 HTTP MCP 通道。");
      entry.supportsLoad = initialized?.agentCapabilities?.loadSession === true;
      entry.multitaskSupport = initialized?.agentCapabilities?.multitaskSupport === true;
      entry.mainAgentSupport = provider === "codebuddy" && !runtime.localBridge && !runtime.requiredMode && initialized?.agentCapabilities?.mainAgentSupport === true;
      if (runtime.resumeThreadId && initialized?.agentCapabilities?.loadSession !== true
        && !(provider === "opencode" && runtime.retainedTimeline && initialized?.agentCapabilities?.sessionCapabilities?.resume != null))
        throw new Error(`当前 ${agentName} CLI 不支持恢复断开的会话。`);
      entry.capabilities.history = initialized?.agentCapabilities?.loadSession === true;
      if (provider === "opencode") {
        const capabilities = initialized?.agentCapabilities?.sessionCapabilities;
        entry.supportsAdditionalDirectories = capabilities?.additionalDirectories != null;
        entry.supportsResume = capabilities?.resume != null;
        entry.supportsClose = capabilities?.close != null;
        entry.capabilities.forkHistory = capabilities?.fork != null;
        entry.capabilities.deleteHistory = capabilities?.delete != null;
      }
      const retained = runtime.retainedTimeline;
      let result;
      if (runtime.resumeThreadId && retained && entry.supportsResume) {
        entry.items = retained.items;
        try { result = await request(entry, "session/resume", sessionParams(entry, runtime.resumeThreadId)); }
        catch (error) {
          if (error.code !== -32601) throw error;
          entry.items = [];
          result = await request(entry, "session/load", sessionParams(entry, runtime.resumeThreadId));
        }
      } else result = await request(entry, runtime.resumeThreadId ? "session/load" : "session/new", sessionParams(entry, runtime.resumeThreadId));
      if (sessions.get(session.id) !== entry) throw new Error("会话已关闭。");
      delete entry.runtime.retainedTimeline;
      entry.threadId = result.sessionId || runtime.resumeThreadId;
      if (!entry.threadId) throw new Error(`${agentName} ACP 未返回会话 ID。`);
      entry.availableCommands = entry.earlyCommands.get(entry.threadId) || [];
      entry.earlyCommands.clear(); entry.awaitingSession = false;
      entry.loadingThreadId = null;
      applySessionOptions(entry, result);
      replayContextUsage(entry);
      await enforceRequiredMode(entry, true);
      if (provider === "opencode" && runtime.openCodeModel) {
        const option = entry.configOptions.find(item => item.id === "model" && item.type === "select");
        if (!option?.options?.some(item => item.value === runtime.openCodeModel))
          throw new Error(`OpenCode 未提供已配置的模型 ${runtime.openCodeModel}，请重新连接或检查模型验证与服务凭据。`);
        if (option.currentValue !== runtime.openCodeModel) {
          const selected = await request(entry, "session/set_config_option", {
            sessionId: entry.threadId, configId: "model", value: runtime.openCodeModel
          });
          entry.configOptions = Array.isArray(selected?.configOptions) ? selected.configOptions
            : entry.configOptions.map(item => item.id === "model" ? { ...item, currentValue: runtime.openCodeModel } : item);
        }
      }
      if (provider === "opencode" && (runtime.openCodeHistoryControl || openCodeControl)) await refreshOpenCodeHistoryState(entry);
      await restoreOptions(entryFor(session.id));
      await refreshMainAgents(entry);
      publish(session.id);
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(session.id, "connected");
      if (runtime.resumeThreadId || provider === "opencode") await recordTokenUsage(entry, { resumed: Boolean(runtime.resumeThreadId) });
      if (provider === "opencode") entry.openCodeUsageReady = true;
      reportTokenLive(entry, "sessionStart", { resumed: Boolean(runtime.resumeThreadId) });
    } catch (error) {
      if (provider === "opencode" && error.code === -32000 && sessions.get(session.id) === entry) {
        entry.authRequired = true; entry.error = "OpenCode 需要登录，请从会话菜单打开登录入口。";
        entry.busy = false; entry.loadingThreadId = null; publish(session.id); return;
      }
      const failure = provider === "codebuddy" || provider === "claude" || provider === "qoder" || provider === "gemini" || provider === "grok" ? withStderr(error) : error;
      if (sessions.get(session.id) === entry) close(session.id, auth?.snapshot(session.id).status === "reconnecting");
      throw failure;
    }
  }
  function close(id, preserveAuth = false) {
    if (!preserveAuth) auth?.close(id);
    const entry = sessions.get(id);
    if (!entry) return closingSessions.get(id);
    entry.openCodeRetry = null;
    clearPendingPublish(id);
    if (provider === "opencode") interruptCompactions(entry.items);
    entry.mcpApps?.clear();
    sideQuestions?.clear(id);
    sessions.delete(id);
    if (provider !== "opencode" || !entry.supportsClose || !entry.threadId || !entry.child.stdin.writable
      || entry.child.exitCode != null || entry.child.signalCode != null) { disposeEntry(entry); return; }
    for (const requestId of entry.approvals.keys()) {
      try { send(entry, { id: requestId, result: { outcome: { outcome: "cancelled" } } }); } catch {}
    }
    cancelOpenCodeForms(entry);
    entry.approvals.clear(); entry.questions.clear();
    const closing = request(entry, "session/close", { sessionId: entry.threadId }, 3000)
      .catch(() => {}).finally(() => {
        disposeEntry(entry);
        if (closingSessions.get(id) === closing) closingSessions.delete(id);
      });
    closingSessions.set(id, closing);
    return closing;
  }
  async function closePreviousThread(entry, threadId) {
    if (provider !== "opencode" || !entry.supportsClose || !threadId || threadId === entry.threadId) return;
    try { await request(entry, "session/close", { sessionId: threadId }, 3000); } catch {}
  }
  function disposeEntry(entry) {
    cancelOpenCodeForms(entry);
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("会话已关闭。")); }
    entry.pending.clear();
    entry.questions.clear();
    entry.pendingPlan = null; entry.queuedPlans = [];
    entry.executePlanInFullAccess = false;
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
  function shutdown() {
    auth?.shutdown();
    jobs?.shutdown();
    for (const id of [...sessions.keys()]) close(id);
    return Promise.allSettled([...closingSessions.values()]);
  }
  function jobsEntry(id) {
    const entry = entryFor(id);
    if (!jobs || entry.session.type !== "windows" || entry.runtime.localBridge)
      throw new Error("仅 Windows CodeBuddy 图形会话支持后台智能体管理。");
    return entry;
  }
  const withJobs = (id, method, ...args) => {
    const entry = jobsEntry(id);
    return jobs[method]({ session: entry.session, runtime: entry.runtime, environment: entry.environment,
      cwd: workspace(entry) }, ...args);
  };
  async function restart(id, preserveAuth = false) {
    const entry = entryFor(id);
    const session = terminalManager.getSession(id);
    terminalManager.setAppServerConnectionState?.(id, "reconnecting");
    const runtime = { ...entry.runtime, resumeThreadId: entry.threadId || entry.runtime.resumeThreadId };
    if (preserveAuth) runtime.authGeneration = auth.snapshot(id).generation;
    if (provider === "opencode") runtime.retainedTimeline = {
      items: entry.items.map(item => { const copy = { ...item }; delete copy.streaming; return copy; }),
      allowedFiles: [...entry.allowedFiles], pastedImages: [...entry.pastedImages], uploadedFiles: [...entry.uploadedFiles]
    };
    // Keep pasted/uploaded attachment files available to the replacement process.
    if (provider === "opencode") { entry.pastedImages.clear(); entry.uploadedFiles.clear(); }
    await close(id, preserveAuth);
    if (preserveAuth && (!auth?.isActive(id) || !terminalManager.getSession(id))) throw new Error("原图形会话已关闭。");
    try { await start(session, runtime); }
    catch (error) {
      // Keep the login entry usable when reinitialization fails (including failure to spawn).
      if (preserveAuth && auth?.isActive(id) && terminalManager.getSession(id) && !sessions.has(id)) {
        entry.runtime = { ...runtime }; delete entry.runtime.authGeneration;
        entry.threadId = null; entry.loadingThreadId = null; entry.busy = false;
        entry.error = `登录后重连失败：${error.message}`;
        entry.pastedImages = new Set(runtime.retainedTimeline?.pastedImages || []);
        entry.uploadedFiles = new Set(runtime.retainedTimeline?.uploadedFiles || []);
        sessions.set(id, entry); publish(id);
      }
      throw error;
    }
    return terminalManager.listSessions().find(value => value.id === id);
  }
  async function listHistory(id, cursor = null) {
    const entry = entryFor(id);
    if (!entry.capabilities.history) throw new Error(`当前 ${agentName} CLI 不支持历史会话恢复。`);
    if (provider === "gemini" || provider === "grok") {
      if (!historyService?.listHistoryForSession) throw new Error(`${agentName} 历史记录服务不可用。`);
      const result = await historyService.listHistoryForSession(entry.session,
        { providers: [provider], scope: "cwd", cursor });
      const failure = result.errors?.find(error => error.provider === provider);
      if (failure) throw new Error(failure.message || `${agentName} 历史记录读取失败。`);
      const matching = (result.items || []).filter(value => value.provider === provider
        && (provider === "grok" ? typeof value.ref === "string" && /^grok:[^:]+$/.test(value.ref)
          : typeof value.acpSessionId === "string" && value.acpSessionId));
      const data = matching.map(value => ({ id: provider === "grok" ? value.ref.slice("grok:".length) : value.acpSessionId, title: value.title || "未命名会话",
        updatedAt: (value.updatedAt || 0) / 1000, source: agentName, status: "saved" }));
      for (const value of data) entry.listedThreadIds.add(value.id);
      return { data, nextCursor: result.nextCursor || null };
    }
    if (provider === "codebuddy") {
      if (!historyService?.listHistoryForSession) throw new Error("CodeBuddy 历史记录服务不可用。");
      const historySession = { ...entry.session, cwd: workspace(entry),
        type: entry.runtime.localBridge ? "windows" : entry.session.type };
      const result = await historyService.listHistoryForSession(historySession,
        { providers: ["codebuddy"], scope: "cwd", cursor });
      const failure = result.errors?.find(error => error.provider === "codebuddy");
      if (failure) throw new Error(failure.message || "CodeBuddy 历史记录读取失败。");
      const expectedCwd = normalizeCwd(historySession.cwd, historySession.type === "windows");
      const matching = (result.items || []).filter(value => value.provider === "codebuddy"
        && typeof value.ref === "string" && value.ref.startsWith("codebuddy:")
        && normalizeCwd(value.cwd, historySession.type === "windows") === expectedCwd);
      const data = matching.map(value => ({ id: value.ref.slice("codebuddy:".length),
        title: value.title || "未命名会话", updatedAt: (value.updatedAt || 0) / 1000,
        source: agentName, status: "saved" }));
      for (const value of data) entry.listedThreadIds.add(value.id);
      return { data, nextCursor: result.nextCursor || null };
    }
    const result = await request(entry, "session/list", { cwd: workspace(entry), ...(cursor ? { cursor } : {}) });
    const matching = (result.sessions || []).filter(value => value.cwd === workspace(entry));
    for (const value of matching) entry.listedThreadIds.add(value.sessionId);
    return { data: matching.map(value => ({ id: value.sessionId, title: value.title || "未命名会话",
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : value.updatedAt ? Date.parse(value.updatedAt) / 1000 || 0 : 0,
      source: agentName, status: "saved" })), nextCursor: result.nextCursor || null };
  }
  async function controlOpenCode(entry, operation, threadId = entry.threadId, body) {
    if (sessions.get(entry.session.id) !== entry) throw new Error("OpenCode 会话已关闭或重新连接。");
    const result = await (openCodeControl || runOpenCodeHistoryControl)({ session: entry.session,
      cwd: workspace(entry), environment: entry.environment, sshAgentTransport, operation, threadId, body });
    if (sessions.get(entry.session.id) !== entry) throw new Error("OpenCode 会话已关闭或重新连接，请刷新历史状态。");
    return result;
  }
  async function updateOpenCodeMessageIds(entry) {
    if (!(entry.runtime.openCodeHistoryControl || openCodeControl)) return;
    const target = entry.items.findLast(item => item.type === "userMessage" && item.turnId === entry.turnId);
    if (!target || target.rewindMessageId) return;
    try {
      const messages = await controlOpenCode(entry, "session.message.list");
      const users = Array.isArray(messages) ? messages.filter(message => message.type === "user") : [];
      const latest = users[0];
      if (latest && isOpenCodeMessageId(latest.id) && String(latest.text || "").trim() === String(target.text || "").trim()) target.rewindMessageId = latest.id;
    } catch (error) { entry.historyActionsError = `无法读取回退消息标识：${error.message}`; }
  }
  async function refreshOpenCodeHistoryState(entry) {
    try {
      if (!entry.openCodeHistoryVersion) {
        const version = await controlOpenCode(entry, "version");
        const parts = String(version).match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
        if (!parts || parts[0] < 2 || parts[0] === 2 && parts[1] === 0 && parts[2] < 18)
          throw new Error("需要 OpenCode V2.0.18 或更新版本。");
        entry.openCodeHistoryVersion = version;
      }
      const info = await controlOpenCode(entry, "session.get");
      if (info?.id !== entry.threadId) throw new Error("OpenCode 返回了其他会话的状态。");
      entry.openCodeRevert = info.revert || null;
      entry.capabilities.revertHistory = true;
      entry.capabilities.renameHistory = true;
      entry.historyActionsError = null;
      if (entry.openCodeRevert) {
        const boundary = entry.items.findIndex(item => item.rewindMessageId === entry.openCodeRevert.messageID || item.id === entry.openCodeRevert.messageID);
        if (boundary >= 0) entry.items = entry.items.slice(0, boundary);
      }
    } catch (error) {
      entry.capabilities.revertHistory = false;
      entry.capabilities.renameHistory = false;
      entry.historyActionsError = `OpenCode 历史控制不可用，请检查 V2 安装：${error.message}`;
    }
  }
  async function changeOpenCodeRevert(id, messageId, restore = false) {
    const entry = entryFor(id);
    if (provider !== "opencode" || !entry.capabilities.revertHistory) throw new Error("当前 OpenCode 不支持回退，请检查或升级 V2。");
    assertHistoryIdle(entry);
    if (restore ? !entry.openCodeRevert : !isOpenCodeMessageId(messageId) || !entry.items.some(item => item.type === "userMessage" && item.rewindMessageId === messageId))
      throw new Error("回退目标已失效，请刷新会话。");
    entry.listedThreadIds.add(entry.threadId);
    await checkHistoryTarget(entry, entry.threadId);
    let failure;
    try {
      await controlOpenCode(entry, restore ? "session.revert.clear" : "session.revert.stage", entry.threadId,
        restore ? undefined : { messageID: messageId, files: true });
    } catch (error) { failure = error; }
    // Re-read the stored boundary even after errors: file operations may have partially succeeded.
    await refreshOpenCodeHistoryState(entry);
    const threadId = entry.threadId;
    await resume(id, threadId);
    if (failure) throw failure;
    if (entry.historyActionsError) throw new Error(entry.historyActionsError);
    return snapshot(id);
  }
  async function renameThread(id, threadId, name) {
    const entry = entryFor(id);
    if (provider === "opencode") {
      if (!entry.capabilities.renameHistory) throw new Error("当前 OpenCode 不支持重命名，请检查或升级 V2。");
      await checkHistoryTarget(entry, threadId);
      const title = String(name || "").trim();
      if (!title || title.length > 200) throw new Error("会话名称须为 1 到 200 个字符。");
      await controlOpenCode(entry, "session.update", threadId, { title });
      publish(id);
      return;
    }
    if (provider !== "codebuddy" || !entry.httpTransport?.renameSession) throw new Error("当前会话不支持重命名。");
    if (typeof threadId !== "string" || !entry.listedThreadIds.has(threadId)) throw new Error("只能重命名当前项目列出的历史会话。");
    const title = String(name || "").trim();
    if (!title || title.length > 200) throw new Error("会话名称须为 1 到 200 个字符。");
    const result = await entry.httpTransport.renameSession(threadId, title);
    if (result?.error) throw new Error(result.error.message || "CodeBuddy 重命名失败。");
  }
  const scheduledTasks = createScheduledTasksService((id, threadId) => {
    const entry = entryFor(id);
    if (provider !== "codebuddy" || entry.session.type !== "windows" || entry.runtime.localBridge || !entry.httpTransport?.scheduledTasksRequest)
      throw new Error("仅 Windows 本机 CodeBuddy 图形会话支持定时任务管理。");
    const assertCurrent = () => {
      if (!threadId || sessions.get(id) !== entry || entry.threadId !== threadId || entry.loadingThreadId || activeOperations.has(id))
        throw new Error("对话已切换或正在重建，请重新打开定时任务管理。");
    };
    assertCurrent();
    return { threadId, transport: entry.httpTransport, assertCurrent };
  });
  function pluginRuntime(id) {
    const entry = entryFor(id);
    if (provider !== "codebuddy" || entry.session.type !== "windows" || entry.runtime.localBridge || !entry.httpTransport?.pluginRequest)
      throw new Error("仅 Windows CodeBuddy 图形会话支持插件管理。");
    return { cwd: workspace(entry), shell: entry.runtime.shell || entry.session.shell,
      before: String(entry.session.initialCommand || "").trim(), environment: { ...entry.environment } };
  }
  function pluginRequest(id, method, route, body) {
    pluginRuntime(id);
    return entryFor(id).httpTransport.pluginRequest(method, route, body);
  }
  function assertHistoryIdle(entry) {
    if (entry.busy || entry.pendingPlan || entry.approvals.size || entry.questions.size || entry.executingPlan || activeOperations.has(entry.session.id) || auth?.isActive(entry.session.id))
      throw new Error("当前会话正在执行或有待处理操作，请处理后重试。");
  }
  async function checkHistoryTarget(entry, threadId) {
    if (typeof threadId !== "string" || !threadId || threadId.length > 200 || !entry.listedThreadIds.has(threadId))
      throw new Error("只能操作当前项目列出的历史会话。");
    const seen = new Set();
    let cursor;
    do {
      const result = await request(entry, "session/list", { cwd: workspace(entry), ...(cursor ? { cursor } : {}) });
      if ((result.sessions || []).some(value => value.sessionId === threadId && value.cwd === workspace(entry))) return;
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("历史记录分页异常，请刷新后重试。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    entry.listedThreadIds.delete(threadId);
    throw new Error("历史会话已不存在或不属于当前项目，请刷新后重试。");
  }
  // Reserve both panel and target before any await, including list revalidation.
  async function withHistoryOperation(id, threadId, operation) {
    if (provider === "codebuddy") return guardHistoryOperation(operation)(id);
    if (provider !== "opencode") return operation();
    const entry = entryFor(id);
    assertHistoryIdle(entry);
    const targets = new Set([entry.threadId, threadId].filter(Boolean));
    if (historyOperations.has(id) || [...targets].some(target => historyTargets.has(target)))
      throw new Error("会话操作正在进行，请稍后重试。");
    historyOperations.add(id);
    for (const target of targets) historyTargets.add(target);
    publish(id);
    let result;
    try { result = await operation(); }
    finally {
      historyOperations.delete(id);
      for (const target of targets) historyTargets.delete(target);
      if (sessions.get(id) === entry) publish(id);
    }
    return result?.threadId && sessions.get(id) === entry ? snapshot(id) : result;
  }
  function guardHistoryOperation(operation) {
    return async (id, ...args) => {
      if (provider === "codebuddy") {
        if (entryFor(id).mainAgentChanging) throw new Error("主 Agent 正在切换，请稍后重试。");
        codeBuddyOperations.set(id, (codeBuddyOperations.get(id) || 0) + 1);
        try { return await operation(id, ...args); }
        finally {
          const remaining = (codeBuddyOperations.get(id) || 1) - 1;
          if (remaining) codeBuddyOperations.set(id, remaining); else codeBuddyOperations.delete(id);
        }
      }
      if (provider !== "opencode") return operation(id, ...args);
      if (auth?.isActive(id)) throw new Error("OpenCode 登录正在进行，请稍后重试。");
      const threadId = sessions.get(id)?.threadId;
      if (historyOperations.has(id) || activeOperations.has(id) || (threadId && historyTargets.has(threadId)))
        throw new Error("会话操作正在进行，请稍后重试。");
      activeOperations.add(id);
      if (threadId) historyTargets.add(threadId);
      try { return await operation(id, ...args); }
      finally { activeOperations.delete(id); if (threadId) historyTargets.delete(threadId); }
    };
  }
  async function startWithHistoryReservation(session, runtime = {}) {
    if (provider !== "opencode") return start(session, runtime);
    const threadId = runtime.resumeThreadId;
    if (historyOperations.has(session.id) || activeOperations.has(session.id) || (threadId && historyTargets.has(threadId)))
      throw new Error("会话操作正在进行，请稍后重试。");
    activeOperations.add(session.id);
    if (threadId) historyTargets.add(threadId);
    try { return await start(session, runtime); }
    finally { activeOperations.delete(session.id); if (threadId) historyTargets.delete(threadId); }
  }
  async function forkThread(id, threadId) {
    const entry = entryFor(id);
    if (provider !== "opencode" || !entry.capabilities.forkHistory) throw new Error("当前会话不支持分叉。");
    await checkHistoryTarget(entry, threadId);
    if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
    for (const other of sessions.values()) if (other.threadId === threadId) {
      assertHistoryIdle(other);
      if (other !== entry && historyOperations.has(other.session.id)) throw new Error("来源会话正在切换，请稍后重试。");
    }
    const previous = Object.fromEntries(["threadId", "items", "team", "contextUsage", "availableCommands", "configOptions",
      "modes", "nativeMode", "mode", "executionPermission", "model", "error", "pendingPlan", "turnId", "capabilities"]
      .map(key => [key, entry[key]]));
    entry.historySnapshot = snapshot(id);
    entry.forkReplay = [];
    let forkId;
    try {
      const result = await request(entry, "session/fork", sessionParams(entry, threadId));
      forkId = result?.sessionId;
      if (typeof forkId !== "string" || !forkId || forkId === threadId) throw new Error("OpenCode 未返回有效的分叉会话 ID。");
      if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
      const replay = entry.forkReplay;
      entry.forkReplay = null;
      entry.threadId = forkId; entry.loadingThreadId = forkId;
      entry.items = []; entry.team = null; entry.contextUsage = null; entry.availableCommands = [];
      entry.modes = []; entry.nativeMode = null; entry.error = null; entry.pendingPlan = null; entry.queuedPlans = []; entry.turnId = null;
      entry.capabilities = { ...entry.capabilities };
      applySessionOptions(entry, result);
      for (const value of replay) if (value.sessionId === forkId) onUpdate(id, entry, value);
      await enforceRequiredMode(entry);
      if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
      entry.listedThreadIds.add(forkId);
      await recordTokenUsage(entry, { resumed: true });
      status(id, entry, "cleared");
      await closePreviousThread(entry, previous.threadId);
      return snapshot(id);
    } catch (error) {
      Object.assign(entry, previous);
      if (forkId) throw new Error(`${error.message} 已创建的分支 ${forkId} 可在历史列表中查看。`);
      throw error;
    } finally { entry.forkReplay = null; entry.loadingThreadId = null; entry.historySnapshot = null; }
  }
  async function deleteThread(id, threadId) {
    const entry = entryFor(id);
    if (provider !== "opencode" || !entry.capabilities.deleteHistory) throw new Error("当前会话不支持删除历史。");
    await checkHistoryTarget(entry, threadId);
    if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
    if ([...sessions.values()].some(other => other.threadId === threadId))
      throw new Error("该会话仍在本应用中打开，请先切换到其他对话再删除。");
    await request(entry, "session/delete", { sessionId: threadId });
    for (const other of sessions.values()) other.listedThreadIds.delete(threadId);
  }
  async function rewind(id, messageId, scope) {
    const entry = entryFor(id);
    if (provider !== "codebuddy" || entry.session.type !== "windows" || entry.runtime.localBridge)
      throw new Error("仅 Windows CodeBuddy 图形会话支持回退。");
    if (entry.busy || entry.pendingPlan || entry.approvals.size || entry.questions.size)
      throw new Error("请等待当前轮次及待确认请求结束后再回退。");
    if (!entry.threadId || !isRewindMessageId(messageId) || !entry.items.some(item => item.type === "userMessage" && item.rewindMessageId === messageId))
      throw new Error("所选消息没有可用的回退标识。");
    if (!["Code", "Conversation", "CodeAndConversation"].includes(scope)) throw new Error("无效的回退范围。");
    const session = entry.session;
    const runtime = { ...entry.runtime, resumeThreadId: entry.threadId };
    const environment = { ...process.env, ...entry.environment };
    const cwd = workspace(entry);
    const child = entry.child;
    close(id);
    let result;
    let failure;
    try {
      if (child.exitCode == null) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 CodeBuddy 图形进程退出超时。")), 10000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        if (child.exitCode != null) { clearTimeout(timer); resolve(); }
      });
      result = await rewindControl({ sessionId: runtime.resumeThreadId, messageId, scope, cwd, env: environment, spawnProcess });
    } catch (error) { failure = error; }
    try {
      await start(session, runtime);
    } catch (error) {
      throw new Error(`${failure ? `${failure.message}；` : ""}恢复 CodeBuddy 图形会话失败：${error.message}`);
    }
    if (failure) throw failure;
    if (result.fileRewindError) {
      const current = entryFor(id);
      current.items.push({ id: `turn-error:rewind:${randomUUID()}`, type: "turnError", turnId: null,
        text: `对话已回退，但部分文件恢复失败：${sanitizeDiagnostic(result.fileRewindError)}` });
      publish(id);
    }
    return { snapshot: snapshot(id), filesChanged: result.filesChanged || [],
      historyRewound: result.historyRewound === true, fileRewindError: result.fileRewindError || null };
  }
  async function resume(id, threadId) {
    const entry = entryFor(id);
    if (entry.busy || entry.pendingPlan) throw new Error("当前轮次尚未结束。");
    if (entry.approvals.size || entry.questions.size) throw new Error("请先处理当前会话的待确认请求。");
    if (!entry.capabilities.history || !entry.listedThreadIds.has(threadId)) throw new Error("只能恢复当前项目列出的历史会话。");
    if ([...sessions.values()].some(other => other !== entry && other.threadId === threadId)) throw new Error("该历史会话已在其他窗口打开。");
    const previousCommands = entry.availableCommands;
    const previousGoal = entry.codeBuddyGoal;
    const previousItems = entry.items;
    const previousThreadId = entry.threadId;
    if (provider === "codebuddy") entry.codeBuddyGoal = emptyGoalState();
    conversationArchive?.pause(id);
    entry.loadingThreadId = threadId;
    entry.availableCommands = []; entry.earlyCommands.clear(); entry.awaitingSession = true;
    entry.items = [];
    entry.team = null;
    entry.contextUsage = null;
    let result;
    try { result = await request(entry, "session/load", sessionParams(entry, threadId)); }
    catch (error) {
      entry.items = previousItems;
      entry.availableCommands = previousCommands;
      if (provider === "codebuddy") entry.codeBuddyGoal = previousGoal;
      entry.earlyCommands.clear(); entry.awaitingSession = false;
      publish(id);
      throw error;
    } finally { entry.loadingThreadId = null; }
    sideQuestions?.clear(id);
    entry.threadId = result.sessionId || threadId; entry.error = null; entry.pendingPlan = null; entry.queuedPlans = [];
    entry.availableCommands = entry.earlyCommands.get(entry.threadId) || [];
    entry.earlyCommands.clear(); entry.awaitingSession = false;
    applySessionOptions(entry, result);
    replayContextUsage(entry);
    try { await enforceRequiredMode(entry); }
    catch (error) { close(id); throw error; }
    if (provider === "opencode") {
      await restoreOptions(entry);
      if (entry.runtime.openCodeHistoryControl || openCodeControl) await refreshOpenCodeHistoryState(entry);
    }
    await refreshMainAgents(entry);
    publish(id);
    await recordTokenUsage(entry, { resumed: true });
    await closePreviousThread(entry, previousThreadId);
    return snapshot(id);
  }
  async function newThread(id) {
    const entry = entryFor(id);
    if (entry.busy || entry.pendingPlan) throw new Error("当前轮次尚未结束。");
    if (entry.approvals.size || entry.questions.size) throw new Error("请先处理当前会话的待确认请求。");
    const previousCommands = entry.availableCommands;
    const previousThreadId = entry.threadId;
    entry.availableCommands = []; entry.earlyCommands.clear(); entry.awaitingSession = true;
    let result;
    try { result = await request(entry, "session/new", sessionParams(entry)); }
    catch (error) {
      entry.availableCommands = previousCommands;
      entry.earlyCommands.clear(); entry.awaitingSession = false;
      publish(id);
      throw error;
    }
    sideQuestions?.clear(id);
    entry.threadId = result.sessionId;
    entry.items = []; entry.team = null; entry.error = null; entry.pendingPlan = null; entry.queuedPlans = []; entry.contextUsage = null;
    if (provider === "opencode") {
      entry.openCodeRevert = null;
      if (entry.runtime.openCodeHistoryControl || openCodeControl) await refreshOpenCodeHistoryState(entry);
    }
    if (provider === "codebuddy") entry.codeBuddyGoal = emptyGoalState();
    entry.availableCommands = entry.earlyCommands.get(entry.threadId) || [];
    entry.earlyCommands.clear(); entry.awaitingSession = false;
    applySessionOptions(entry, result);
    replayContextUsage(entry);
    try { await enforceRequiredMode(entry, true); }
    catch (error) { close(id); throw error; }
    await restoreOptions(entryFor(id));
    await refreshMainAgents(entry);
    publish(id);
    status(id, entry, "cleared");
    if (provider === "opencode") await recordTokenUsage(entry);
    await closePreviousThread(entry, previousThreadId);
    return snapshot(id);
  }
  async function setMode(id, mode) {
    const entry = entryFor(id);
    if (entry.runtime.requiredMode) throw new Error("本机 SSH 桥接不允许切换受限 Agent 模式。");
    if (entry.busy || entry.pendingPlan) throw new Error("当前轮次尚未结束。");
    const native = policy.findMode(entry, mode);
    if (!native) throw new Error(`当前 ${agentName} CLI 不支持${mode === "plan" ? "计划" : "执行"}模式。`);
    if (native.id === entry.nativeMode) return snapshot(id);
    if ((provider === "opencode" || provider === "qoder") && entry.configOptions.some(option => option.id === "mode")) return setConfigOption(id, "mode", native.id);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId: native.id });
    entry.mode = mode; entry.nativeMode = native.id; entry.pendingPlan = null; entry.queuedPlans = [];
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
    if ((provider === "opencode" || provider === "qoder") && entry.configOptions.some(option => option.id === "mode")) return setConfigOption(id, "mode", modeId);
    await request(entry, "session/set_mode", { sessionId: entry.threadId, modeId });
    entry.nativeMode = modeId; entry.pendingPlan = null; entry.queuedPlans = [];
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
    if ((provider !== "opencode" && provider !== "qoder" && !((provider === "gemini" || provider === "grok") && optionId === "model") && !(provider === "codebuddy" && (optionId === "model" || optionId === "context_window"))
      && !(provider === "claude" && (optionId === "model" || optionId === "effort"))) || entry.busy)
      throw new Error("当前会话无法切换配置。");
    const option = entry.configOptions.find(item => item.id === optionId && item.type === "select");
    if (!option?.options?.some(item => item.value === value)) throw new Error(`当前 ${agentName} 会话不支持此选项。`);
    const result = await request(entry, (provider === "gemini" || provider === "grok") && optionId === "model" ? "session/set_model" : "session/set_config_option",
      (provider === "gemini" || provider === "grok") && optionId === "model" ? { sessionId: entry.threadId, modelId: value } : { sessionId: entry.threadId, configId: optionId, value });
    entry.configOptions = result?.configOptions || entry.configOptions.map(item => item.id === optionId ? { ...item, currentValue: value } : item);
    if ((provider === "codebuddy" || provider === "opencode") && (optionId === "model" || optionId === "context_window")) entry.contextUsage = null;
    if (provider === "codebuddy" || provider === "opencode") saveOption(entry, optionId === "context_window" ? "contextWindow" : optionId, value);
    if (optionId === "mode") {
      entry.nativeMode = value;
      reflectNativeMode(entry);
    }
    publish(id);
    return snapshot(id);
  }
  function setModel(id, value) { return setConfigOption(id, "model", value); }
  async function refreshMainAgents(entry) {
    if (!entry.mainAgentSupport) return;
    const threadId = entry.threadId;
    try {
      const result = await request(entry, "_codebuddy.ai/getAgents", { sessionId: threadId });
      if (sessions.get(entry.session.id) !== entry || entry.threadId !== threadId) return;
      if (!Array.isArray(result?.agents) || typeof result.currentAgentName !== "string" || typeof result.sessionBlank !== "boolean")
        throw new Error("CodeBuddy 未返回有效的主 Agent 状态，请重试。");
      entry.mainAgent = { currentAgentName: result.currentAgentName, sessionBlank: result.sessionBlank,
        // Some CLI versions list the Multitask overlay in this directory; it is not a main agent.
        agents: result.agents.filter(agent => typeof agent?.name === "string" && agent.name && agent.name !== "multitask").map(agent => ({
          name: agent.name, displayName: typeof agent.displayName === "string" ? agent.displayName : agent.name,
          description: typeof agent.description === "string" ? agent.description : undefined,
          source: typeof agent.source === "string" ? agent.source : undefined,
          broken: typeof agent.broken === "string" ? agent.broken : undefined
        })), error: null };
    } catch (error) {
      if (sessions.get(entry.session.id) !== entry || entry.threadId !== threadId) return;
      if (error.code === -32601) { entry.mainAgentSupport = false; entry.mainAgent = null; }
      else entry.mainAgent = { ...(entry.mainAgent || { currentAgentName: null, agents: [] }), sessionBlank: false, error: error.message };
    }
    publish(entry.session.id);
  }
  async function listMainAgents(id) {
    const entry = entryFor(id);
    if (provider !== "codebuddy") throw new Error("只有 CodeBuddy 支持主 Agent 选择。");
    await refreshMainAgents(entry);
    return snapshot(id);
  }
  async function setMainAgent(id, agentName) {
    const entry = entryFor(id);
    if (provider !== "codebuddy" || !entry.mainAgentSupport || entry.runtime.localBridge || entry.runtime.requiredMode)
      throw new Error("当前会话不支持主 Agent 选择。");
    if (entry.mainAgentChanging || codeBuddyOperations.has(id) || entry.busy || entry.pendingPlan || entry.approvals.size || entry.questions.size)
      throw new Error("会话操作正在进行，请稍后重试。");
    entry.mainAgentChanging = true;
    publish(id);
    try {
      await refreshMainAgents(entry);
      if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
      if (entry.mainAgent?.error) throw new Error(entry.mainAgent.error);
      if (entry.busy || entry.pendingPlan || entry.approvals.size || entry.questions.size) throw new Error("当前会话正在运行或等待确认。");
      if (!entry.mainAgent?.sessionBlank) throw new Error("对话已开始，新建对话后可切换主 Agent。");
      const agent = entry.mainAgent.agents.find(value => value.name === agentName);
      if (!agent || agent.broken) throw new Error(agent?.broken || "主 Agent 已不可用，请刷新后重试。");
      if (agentName === "minimal" && (entry.nativeMode === "plan" || entry.configOptions.some(option => option.id === "multitask" && option.currentValue === true)))
        throw new Error("极简模式不能与 Plan 或 Multitask 同时启用，请先调整当前模式。");
      const result = await request(entry, "session/set_agent", { sessionId: entry.threadId, agentName });
      if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
      if (result?.currentModelId) {
        entry.model = result.currentModelId;
        entry.configOptions = entry.configOptions.map(option => option.id === "model" ? { ...option, currentValue: result.currentModelId,
          ...(Array.isArray(result.models) ? { options: result.models.map(model => ({ value: model.modelId, name: model.name || model.modelId })) } : {}) } : option);
      }
      entry.contextUsage = null;
      await refreshMainAgents(entry);
    } catch (error) {
      if (sessions.get(id) === entry && error.code === -32011 && entry.mainAgent) entry.mainAgent.sessionBlank = false;
      throw error;
    } finally {
      entry.mainAgentChanging = false;
      if (sessions.get(id) === entry) publish(id);
    }
    return snapshot(id);
  }
  function setContextWindow(id, value) { return setConfigOption(id, "context_window", value); }
  function setEffort(id, value) { return setConfigOption(id, provider === "qoder" ? "reasoning_effort" : "effort", value); }
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
    if (!entry.allowedFiles.has(file) && !entry.pastedImages.has(file)
      && !entry.items.some(item => item.attachments?.some(value => value.path === file))) throw new Error("只能预览当前会话的附件。");
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
  async function submit(id, text, files = [], _references = [], orderedContent, onSubmitted) {
    const entry = entryFor(id);
    conversationArchive?.baseline(id, snapshot(id));
    if (entry.mainAgentChanging) throw new Error("主 Agent 正在切换，请稍后重试。");
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
      if (isRemote(entry) && !file.startsWith("/") && path.win32.isAbsolute(file)) {
        const directory = path.posix.join(await sshFileSystem.cwd(id), ".cache", "pannel-handle", "acp", randomUUID());
        await sshFileSystem.mkdir(id, directory, true);
        await sshFileSystem.chmod(id, directory, 0o700);
        agentPath = path.posix.join(directory, path.win32.basename(file));
        await sshFileSystem.fastPut(id, file, agentPath);
        entry.uploadedFiles.add(directory);
      } else if (entry.session.type === "wsl" && !file.startsWith("/") && path.win32.isAbsolute(file)) {
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
      } else if (provider === "opencode") {
        const hostPath = entry.session.type === "wsl" && agentPath.startsWith("/") ? toWslHostPath(entry.session.wslDistro, agentPath) : file;
        const stat = isRemote(entry) && agentPath.startsWith("/")
          ? await sshFileSystem.stat(id, agentPath) : await fs.promises.stat(hostPath);
        if (stat.isDirectory?.()) throw new Error("附件必须是文件。");
        if (!(isRemote(entry) && agentPath.startsWith("/"))) await fs.promises.access(hostPath, fs.constants.R_OK);
        prompt.push(fileResourceLink(agentPath, stat.size));
      } else prompt.push({ type: "text", text: `\n请读取以下附件文件：${JSON.stringify(agentPath)}` });
      attachments.push({ path: agentPath, name: path.basename(file) });
    }
    if (orderedContent) prompt.unshift(...orderedContent.map(part => part.type === "text" ? { type: "text", text: part.text } : imageBlocks.get(part.path)));
    if (provider === "opencode" && entry.openCodeRevert) {
      try { await controlOpenCode(entry, "session.revert.commit"); }
      catch (error) { await refreshOpenCodeHistoryState(entry); if (sessions.get(id) === entry) publish(id); throw error; }
      entry.openCodeRevert = null;
    }
    entry.openCodeRetry = null; entry.openCodeRetryCancelled = false;
    entry.error = null; entry.busy = true; entry.foregroundBusy = true;
    let settlePrompt;
    entry.promptCompletion = new Promise(resolve => { settlePrompt = resolve; });
    if (entry.mainAgent) entry.mainAgent.sessionBlank = false;
    entry.turnId = provider === "codebuddy" ? createConversationRequestId() : randomUUID(); entry.pendingPlan = null; entry.queuedPlans = [];
    entry.items.push({ id: randomUUID(), type: "userMessage", turnId: entry.turnId, text: String(text || "").trim(), attachments,
      ...(orderedContent ? { parts: orderedContent.map(part => part.type === "text" ? part : {
        type: "image", path: attachments[files.indexOf(part.path)].path, name: attachments[files.indexOf(part.path)].name }) } : {}) });
    publish(id); status(id, entry, "running", text);
    reportTokenLive(entry, "turnStart");
    try {
      const result = await request(entry, "session/prompt", { sessionId: entry.threadId, prompt,
        ...(provider === "codebuddy" ? { _meta: { "codebuddy.ai/conversationRequestId": entry.turnId } } : {}) }, 60 * 60 * 1000, onSubmitted);
      if (sessions.get(id) !== entry) return;
      cancelOpenCodeForms(entry);
      for (const file of files) entry.allowedFiles.delete(file);
      entry.openCodeRetry = null; entry.foregroundBusy = false; entry.busy = entry.unsolicitedTurns.size > 0;
      for (const item of entry.items) if (item.turnId === entry.turnId) delete item.streaming;
      if (provider === "codebuddy" || provider === "gemini" || provider === "grok") {
        const detail = typeof result?.errorMessage === "string" && result.errorMessage.trim()
          ? result.errorMessage : result?.stopReason && !["end_turn", "cancelled", "refusal"].includes(result.stopReason)
            ? `${agentName} 本轮未完成（${result.stopReason}）。` : "";
        appendTurnError(entry, entry.turnId, detail);
      }
      if (provider === "opencode") await updateOpenCodeMessageIds(entry);
      status(id, entry, result?.stopReason === "end_turn" ? "completed" : "failed"); publish(id);
      if (!entry.busy) reportTokenLive(entry, "turnEnd");
      if (entry.executePlanInFullAccess) void promoteApprovedPlan(id, entry);
      void recordTokenUsage(entry);
    } catch (error) {
      if (sessions.get(id) !== entry) throw error;
      cancelOpenCodeForms(entry);
      entry.openCodeRetry = null; entry.foregroundBusy = false; entry.busy = entry.unsolicitedTurns.size > 0;
      entry.error = appendTurnError(entry, entry.turnId, error.message) ? null : error.message;
      if (provider === "opencode") await updateOpenCodeMessageIds(entry);
      status(id, entry, "failed", error.message); publish(id); if (!entry.busy) reportTokenLive(entry, "turnEnd"); void recordTokenUsage(entry); throw error; }
    finally { if (provider === "opencode" && sessions.get(id) === entry) { interruptCompactions(entry.items); publish(id); } settlePrompt(); entry.promptCompletion = null; await refreshMainAgents(entry); }
  }
  function submitStarted(id, text) {
    return new Promise((resolve, reject) => {
      // submit keeps reporting later turn failures through the existing session state.
      void submit(id, text, [], [], undefined, resolve).catch(reject);
    });
  }
  function startGoalCommand(id, command, action) {
    const entry = entryFor(id);
    if (provider !== "codebuddy") throw new Error("当前会话不支持 CodeBuddy 目标。");
    if (!entry.threadId || entry.busy || entry.pendingPlan || entry.approvals.size || entry.questions.size)
      throw new Error("当前会话正在运行或等待确认，请稍后重试。");
    const threadId = entry.threadId;
    entry.codeBuddyGoal.pendingAction = action;
    entry.codeBuddyGoal.error = null;
    const running = submit(id, command);
    const turnId = entry.turnId;
    void running.then(() => {
      if (sessions.get(id) !== entry || entry.threadId !== threadId) return;
      const turnError = entry.items.findLast(item => item.type === "turnError" && item.turnId === turnId);
      if (turnError) entry.codeBuddyGoal.error = turnError.text;
      if (entry.codeBuddyGoal.pendingAction === action) entry.codeBuddyGoal.pendingAction = null;
      publish(id);
    }, error => {
      if (sessions.get(id) !== entry || entry.threadId !== threadId) return;
      entry.codeBuddyGoal.error = error.message;
      if (entry.codeBuddyGoal.pendingAction === action) entry.codeBuddyGoal.pendingAction = null;
      publish(id);
    });
    publish(id);
    return snapshot(id);
  }
  function getGoal(id) { return snapshot(id); }
  async function stopGoalTurn(id, entry) {
    if (!entry.busy) return;
    const pending = entry.promptCompletion;
    if (!pending) throw new Error("当前轮次尚未结束，请稍后重试。");
    interrupt(id);
    let timer;
    try { await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("等待当前轮次停止超时，请重试操作目标。")), 15000);
    })]); }
    finally { clearTimeout(timer); }
    if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
  }
  function setGoal(id, changes) {
    if (provider !== "codebuddy" || !changes || typeof changes.objective !== "string"
      || changes.status !== "active" || changes.tokenBudget !== undefined)
      throw new Error("CodeBuddy 目标只支持设置完成条件。");
    const objective = changes.objective.trim();
    if (!objective || objective.length > 4000) throw new Error("目标内容须为 1 到 4000 个字符。");
    const entry = entryFor(id);
    if (entry.busy && entry.codeBuddyGoal.active)
      return stopGoalTurn(id, entry).then(() => startGoalCommand(id, `/goal ${objective}`, "set"));
    return startGoalCommand(id, `/goal ${objective}`, "set");
  }
  async function clearGoal(id) {
    const entry = entryFor(id);
    if (provider !== "codebuddy") throw new Error("当前会话不支持 CodeBuddy 目标。");
    if (entry.codeBuddyGoal.pendingAction === "clear") throw new Error("目标清除正在进行，请稍后重试。");
    await stopGoalTurn(id, entry);
    return startGoalCommand(id, "/goal clear", "clear");
  }
  function refreshGoal(id) { return startGoalCommand(id, "/goal", "inspect"); }
  function cancelOpenCodeForms(entry) {
    if (provider !== "opencode") return;
    for (const [requestId, question] of entry.questions) {
      if (!question.openCodeForm) continue;
      try { send(entry, { id: requestId, result: { action: "cancel" } }); } catch {}
      entry.questions.delete(requestId);
    }
  }
  function interrupt(id) { const entry = entryFor(id); entry.openCodeRetry = null; entry.openCodeRetryCancelled = true; cancelOpenCodeForms(entry); publish(id);
    send(entry, { method: "session/cancel", params: { sessionId: entry.threadId } }); }
  function resolveApproval(id, requestId, approved) {
    const entry = entryFor(id); const approval = entry.approvals.get(requestId);
    if (!approval) throw new Error("确认请求已失效。");
    const selected = typeof approved === "string" ? approved : approved ? approval.allowed : approval.declined;
    if (selected && !approval.options.has(selected)) throw new Error("无效的选择。");
    entry.approvals.delete(requestId);
    if (approval.interruption) {
      if (approval.threadId !== entry.threadId) throw new Error("工具确认请求已失效。");
      publish(id);
      return request(entry, "_codebuddy.ai/resolveInterruption", { sessionId: entry.threadId, toolCallId: approval.interruption, decision: selected === "allow" ? "allow" : "deny" });
    }
    send(entry, { id: requestId, result: { outcome: selected ? { outcome: "selected", optionId: selected } : { outcome: "cancelled" } } });
    publish(id); status(id, entry, "running");
  }
  async function answerQuestion(id, requestId, answers) {
    if (provider !== "codebuddy" && provider !== "claude" && provider !== "opencode") throw new Error(`当前 ${agentName} ACP 不支持此提问格式。`);
    const entry = entryFor(id);
    const question = entry.questions.get(requestId);
    if (!question || question.submitting || question.params.threadId !== entry.threadId) throw new Error("问题请求已失效。");
    const prompts = question.params.questions;
    if (!question.openCodeForm && (!answers || typeof answers !== "object" || Array.isArray(answers)
      || Object.keys(answers).length !== prompts.length || prompts.some(prompt => {
        const values = answers[prompt.id]?.answers;
        return !Array.isArray(values) || !values.length || values.some(value => typeof value !== "string" || !value.trim())
          || (!prompt.multiSelect && values.length > 1);
      }))) throw new Error("问题答案无效。");
    question.submitting = true; publish(id);
    try {
      if (question.openCodeForm) {
        send(entry, { id: requestId, result: { action: "accept", content: formAnswerContent(question.openCodeForm, answers) } });
      } else if (question.elicitation) {
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
          question: prompt.question, answers: answers[prompt.id]?.answers || [] })) });
      publish(id); status(id, entry, "running");
    } catch (error) { question.submitting = false; publish(id); throw error; }
  }
  async function cancelQuestion(id, requestId) {
    if (provider !== "codebuddy" && provider !== "claude" && provider !== "opencode") throw new Error(`当前 ${agentName} ACP 不支持此提问格式。`);
    const entry = entryFor(id);
    const question = entry.questions.get(requestId);
    if (!question || question.submitting || question.params.threadId !== entry.threadId) throw new Error("问题请求已失效。");
    question.submitting = true; publish(id);
    try {
      if (question.openCodeForm || question.elicitation) {
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
    entry.pendingPlan = entry.queuedPlans.shift() || null;
    publish(id);
    status(id, entry, entry.pendingPlan ? "e_prompt" : "running");
    return snapshot(id);
  }
  async function executePlan(id, itemId) {
    const entry = entryFor(id);
    if (provider === "opencode") {
      const lastUserIndex = entry.items.map(item => item.type).lastIndexOf("userMessage");
      const reply = lastUserIndex < 0 ? [] : entry.items.slice(lastUserIndex + 1);
      const latestPlan = reply.some(item => item.type === "turnError") ? null
        : reply.filter(item => item.type === "agentMessage" && item.text?.trim()
          || item.type === "turnPlan" && item.plan?.length).at(-1);
      const build = entry.modes.find(mode => mode.id.toLowerCase() === "build");
      if (!entry.threadId || entry.busy || entry.executingPlan || entry.pendingPlan || entry.approvals.size || entry.questions.size
        || entry.nativeMode !== "plan" || !build || latestPlan?.id !== itemId || entry.error)
        throw new Error("计划确认已失效。");
      const threadId = entry.threadId;
      entry.executingPlan = true;
      try {
        await setNativeMode(id, build.id);
        if (sessions.get(id) !== entry || entry.threadId !== threadId || entry.busy)
          throw new Error("对话已切换，计划执行已取消。");
        void submit(id, "按上述计划执行。").catch(error => {
          if (sessions.get(id) === entry && !entry.error) {
            entry.error = error.message;
            publish(id);
          }
        });
      } finally { entry.executingPlan = false; }
      return;
    }
    const plan = entry.pendingPlan;
    if (provider !== "codebuddy" || !plan || plan.itemId !== itemId || plan.threadId !== entry.threadId)
      throw new Error("计划确认已失效。");
    send(entry, { id: plan.requestId, result: { outcome: { outcome: "selected", optionId: plan.allowedOptionId } } });
    entry.pendingPlan = entry.queuedPlans.shift() || null;
    if (plan.promoteParent) entry.executePlanInFullAccess = true;
    publish(id);
    status(id, entry, entry.pendingPlan ? "e_prompt" : "running");
  }
  return { start: startWithHistoryReservation, restart: guardHistoryOperation(restart), close, shutdown, snapshot, listModelMetadata, pluginRuntime, pluginRequest, getWorkspaceCwd: id => workspace(entryFor(id)), resetUsageBaselines, listHistory, renameThread: provider === "opencode" ? (id, threadId, name) => withHistoryOperation(id, threadId, () => renameThread(id, threadId, name)) : renameThread,
    revertThread: (id, messageId) => withHistoryOperation(id, null, () => changeOpenCodeRevert(id, messageId)),
    restoreThread: id => withHistoryOperation(id, null, () => changeOpenCodeRevert(id, null, true)), rewind: guardHistoryOperation(rewind),
    async mcpRestart(id) {
      const entry = entryFor(id);
      if (entry.session.type !== "windows" || entry.runtime.localBridge || entry.busy || entry.approvals.size || entry.questions.size || entry.pendingPlan)
        throw new Error("请等待当前会话操作结束后再重启。");
      await restart(id); return snapshot(id);
    },
    mcpAppImages: (id, threadId, itemId, images) => entryFor(id).mcpApps.images(threadId, itemId, images),
    mcpAppLoad: (id, threadId, itemId) => entryFor(id).mcpApps.load(threadId, itemId),
    mcpAppRead: (id, threadId, itemId, uri) => entryFor(id).mcpApps.read(threadId, itemId, uri),
    mcpAppPrepare: (id, threadId, itemId, name, args) => entryFor(id).mcpApps.prepare(threadId, itemId, name, args),
    mcpAppResolve: (id, token, approved) => entryFor(id).mcpApps.resolve(token, approved),
    mcpAppDispose: (id, threadId, itemId) => entryFor(id).mcpApps.dispose(threadId, itemId),
    mcpRuntime(id) { const entry = entryFor(id);
      if (entry.session.type !== "windows" || entry.runtime.localBridge) throw new Error("仅 Windows 本机 CodeBuddy 支持 MCP 管理。");
      return { threadId: entry.threadId,
      statuses: [...entry.mcpStatuses.values()], supported: false,
      reason: "当前公开接口未提供完整连接查询、热重载、重连和 OAuth 管理；状态仅为 CLI 已推送的首轮记录。" }; },
    askSideQuestion(id, question) {
      if (!sideQuestions || historyOperations.has(id)) throw new Error("当前会话不支持旁问或正在切换对话。");
      sideQuestions.ask(id, question); return snapshot(id);
    },
    cancelSideQuestion(id, requestId) {
      if (!sideQuestions) throw new Error("当前会话不支持旁问。");
      sideQuestions.cancel(id, requestId); return snapshot(id);
    },
    startAcpLogin(id, methodId) { if (!auth) throw new Error("仅 OpenCode 支持此登录入口。"); return auth.start(id, methodId); },
    cancelAcpLogin: (id, generation) => auth?.cancel(id, generation),
    writeAcpLogin: (id, generation, data) => auth?.write(id, generation, data),
    resizeAcpLogin: (id, generation, cols, rows) => auth?.resize(id, generation, cols, rows),
    listScheduledTasks: scheduledTasks.list, createScheduledTask: scheduledTasks.create, deleteScheduledTask: scheduledTasks.delete,
    listJobs: id => withJobs(id, "list"), jobDispatchContext: id => withJobs(id, "dispatchContext"),
    listResumableJobs: id => withJobs(id, "resumable"), dispatchJob: (id, input) => withJobs(id, "dispatch", input),
    resumeJob: (id, sessionId) => withJobs(id, "resume", sessionId), jobTranscript: (id, jobId) => withJobs(id, "transcript", jobId),
    jobAction: (id, jobId, action, input) => withJobs(id, "action", jobId, action, input),
    watchJob: (id, jobId) => withJobs(id, "watch", jobId), unwatchJob: (id, jobId) => withJobs(id, "unwatch", jobId),
    resume: (id, threadId) => withHistoryOperation(id, threadId, () => resume(id, threadId)),
    newThread: id => withHistoryOperation(id, null, () => newThread(id)),
    forkThread: (id, threadId) => withHistoryOperation(id, threadId, () => forkThread(id, threadId)),
    deleteThread: (id, threadId) => withHistoryOperation(id, threadId, () => deleteThread(id, threadId)),
    setMode: guardHistoryOperation(setMode), setNativeMode: guardHistoryOperation(setNativeMode), setModel: guardHistoryOperation(setModel),
    setContextWindow: guardHistoryOperation(setContextWindow), setEffort: guardHistoryOperation(setEffort),
    setMultitask: guardHistoryOperation(setMultitask), sendTeamMessage, setExecutionPermission: guardHistoryOperation(setExecutionPermission), dismissPlan,
    listMainAgents, setMainAgent,
    executePlan: guardHistoryOperation(executePlan), getGoal, setGoal, clearGoal, refreshGoal,
    allowFiles, allowPastedImage, discardPastedImage, previewAttachment,
    submit: guardHistoryOperation(submit), submitStarted: guardHistoryOperation(submitStarted), interrupt, resolveApproval, answerQuestion, cancelQuestion };
}

module.exports = { createCodeBuddyAcpSessionService, buildInvocation, stopAgentChild };
