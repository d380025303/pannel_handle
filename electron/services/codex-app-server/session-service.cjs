const { spawn, spawnSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const readline = require("node:readline");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const { createSubAgentObserver } = require("./sub-agent-observer.cjs");
const { createConfigurationController } = require("./configuration-controller.cjs");
const { createAccountController } = require("./account-controller.cjs");
const { displayItem, historyItems, mergeQuestionAnswers, questionAnswerItem, activitySummary, itemSummary, updateTokenUsage } = require("./snapshot-helpers.cjs");
const { mergeEnvironment } = require("../environment/index.cjs");
const { toWslHostPath } = require("../../core/wsl-paths.cjs");
const SUMMARY_BROADCAST_INTERVAL_MS = 150;
const PUBLISH_COALESCE_MS = 80;
const HISTORY_CURSOR_PREFIX = "pannel-history-v1:";
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT = 10 * 1024 * 1024;
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const EXECUTION_PERMISSIONS = {
  readOnly: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
  askApproval: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } },
  fullAccess: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
};

function quoteBash(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function isPowerShell(shell) { return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell); }
function startupStderrDetail(stderr, environment) {
  let detail = String(stderr || "").trim();
  for (const [name, value] of Object.entries({ ...process.env, ...environment })) {
    if (!/(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name) || value == null) continue;
    const secret = String(value);
    if (secret.length >= 4) detail = detail.split(secret).join("[已隐藏]");
  }
  return detail.slice(-2000);
}

function tierArgs(session, fastMode) {
  if ((session.codexBackend || "openai") !== "openai") return "";
  return fastMode ? ' -c service_tier="priority" -c features.fast_mode=true' : ' -c service_tier="default"';
}
function buildRemoteCommand(session, environment, fastMode = false) {
  const exports = Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error(`无效的远端环境变量：${name}`);
    return `export ${name}=${quoteBash(value)}`;
  });
  const before = String(session.initialCommand || "").trim();
  const script = [...exports, `cd ${quoteBash(session.cwd)}`,
    ...(before ? [`{ ${before}; } 1>&2`] : []), `exec codex app-server --stdio${tierArgs(session, fastMode)}`].join(" && ");
  return `bash -lic ${quoteBash(script)}`;
}

async function createRemoteChild(sshAgentTransport, session, environment, fastMode = false) {
  if (!sshAgentTransport) throw new Error("SSH App Server 通道不可用。");
  const transport = await sshAgentTransport.createStdioTransport(session.id, {
    actionName: "Codex App Server connection", command: buildRemoteCommand(session, environment, fastMode)
  });
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on("data", chunk => transport.write(chunk));
  transport.on("stdout", chunk => child.stdout.write(chunk));
  transport.on("stderr", chunk => child.stderr.write(chunk));
  transport.on("error", error => { child.emit("error", error); transport.close(); });
  transport.on("close", code => {
    child.stdin.end(); child.stdout.end(); child.stderr.end(); child.emit("exit", code);
  });
  child.kill = () => transport.close();
  return child;
}

function buildInvocation(session, runtime, environment) {
  // Keep all config overrides before the subcommand: later -c flags replace earlier ones.
  const command = `${runtime.codexCommand || "codex"}${tierArgs(session, runtime.appServerFastMode)} app-server`;
  const before = runtime.localBridge ? "" : String(session.initialCommand || "").trim();
  const shell = runtime.shell || session.shell;
  const cwd = runtime.workspaceCwd || session.cwd;
  if (session.type === "wsl") {
    const script = before ? `{ ${before}; } 1>&2 && exec ${command}` : `exec ${command}`;
    const configuredNames = Object.keys(environment);
    const existing = String(process.env.WSLENV || "").split(":").filter(Boolean);
    const names = new Set(existing.map(entry => entry.split("/")[0]));
    for (const name of configuredNames) if (!names.has(name)) existing.push(`${name}/u`);
    return {
      executable: "wsl.exe",
      args: ["-d", session.wslDistro, "--cd", session.cwd, "--", "bash", "-lic", script],
      cwd: process.cwd(),
      env: { ...process.env, ...environment, WSLENV: existing.join(":") }
    };
  }
  if (isPowerShell(shell)) {
    const script = before ? `& { ${before} } 1>&2; if (-not $?) { exit 1 }; & ${command}` : `& ${command}`;
    return { executable: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], cwd,
      env: mergeEnvironment([process.env, environment], true) };
  }
  const script = before ? `(${before}) 1>&2 && ${command}` : command;
  return { executable: shell, args: ["/d", "/s", "/c", script], cwd,
    env: mergeEnvironment([process.env, environment], true) };
}

function createCodexAppServerSessionService({ environmentService, terminalManager, broadcast, sessionStore = null, questionAnswerStore = null, diagnosticsStore = null, spawnProcess = spawn, spawnSyncProcess = spawnSync,
  conversationArchive = null, sshAgentTransport = null, sshFileSystem = null, removePastedImage = null, onTokenUsage = () => {} }) {
  const sessions = new Map();
  const publishTimers = new Map();
  const isRemote = entry => entry.session.type === "ssh" && !entry.runtime.localBridge;
  const projectCwd = entry => entry.runtime.workspaceCwd || entry.session.cwd;
  const mcpErrorText = (entry, value) => startupStderrDetail(value,
    { ...environmentService.resolve(entry.session), ...(entry.runtime.runtimeEnv || {}) });
  const removeImage = removePastedImage || ((entry, filePath) => isRemote(entry)
    ? sshFileSystem.remove(entry.session.id, filePath)
    : fs.promises.rm(entry.session.type === "wsl" ? toWslHostPath(entry.session.wslDistro, filePath) : filePath, { force: true }));

  function broadcastStatus(id, entry, immediate = false, eventName = null) {
    if (entry.statusTimer) {
      if (!immediate) return;
      clearTimeout(entry.statusTimer); entry.statusTimer = null;
    }
    const sendStatus = () => {
      entry.statusTimer = null;
      if (sessions.get(id) !== entry) return;
      entry.lastStatusBroadcastAt = Date.now();
      const currentEventName = eventName || (entry.status === "e_prompt" && entry.questions.size
        ? "AppServerQuestion" : entry.status === "completed" && entry.pendingPlan
          ? "AppServerPlanPending" : "AppServerTurn");
      terminalManager.broadcastAgentStatus({ id, provider: "codex", status: entry.status,
        eventName: currentEventName, activitySummary: entry.activitySummary || undefined });
    };
    const remaining = SUMMARY_BROADCAST_INTERVAL_MS - (Date.now() - entry.lastStatusBroadcastAt);
    if (immediate || remaining <= 0) sendStatus();
    else entry.statusTimer = setTimeout(sendStatus, remaining);
  }

  function updateSummary(id, entry, value) {
    const summary = activitySummary(value);
    if (!summary || summary === entry.activitySummary) return;
    entry.activitySummary = summary;
    broadcastStatus(id, entry);
  }

  function sandboxSetupAvailable(entry) {
    return process.platform === "win32" && entry.session.type === "windows"
      && (!entry.session.agentProvider || entry.session.agentProvider === "codex");
  }
  function guardSandboxSetup(entry) {
    if (entry?.windowsSandboxSetup?.status === "running") throw new Error("Windows 沙箱正在初始化，请等待完成。");
  }
  async function setupWindowsSandbox(id, mode) {
    const entry = sessions.get(id);
    if (!entry || !sandboxSetupAvailable(entry)) throw new Error("仅本地 Windows Codex 会话支持沙箱初始化。");
    if (!["elevated", "unelevated"].includes(mode)) throw new Error("无效的 Windows 沙箱初始化模式。");
    guardSandboxSetup(entry);
    if (entry.status === "exited" || entry.child.exitCode != null) throw new Error("Codex App Server 已退出。");
    if (entry.busy || entry.uploading || entry.compacting || entry.review) throw new Error("请等待当前会话操作完成。");
    const operation = { mode, status: "running", error: null };
    entry.windowsSandboxSetup = operation;
    publish(id);
    try {
      const result = await request(entry, "windowsSandbox/setupStart", { mode });
      if (entry.windowsSandboxSetup === operation && operation.status === "running" && result?.started !== true)
        throw new Error("Codex 未启动 Windows 沙箱初始化。");
    } catch (error) {
      if (entry.windowsSandboxSetup === operation && operation.status === "running") {
        operation.status = "failed";
        operation.error = /method.*not found|unknown method|未实现|不支持/i.test(error.message)
          ? "当前 Codex 不支持 Windows 沙箱初始化，请升级 Codex。" : error.message;
      }
    }
    if (sessions.get(id) === entry) publish(id);
    return snapshot(id);
  }
  function snapshot(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    return { subAgents: entry.subAgentObserver?.snapshot(), threadId: entry.threadId, mode: entry.mode, executionPermission: entry.executionPermission,
      permissionProfileId: entry.permissionProfileId, permissionError: entry.permissionError, changingPermission: Boolean(entry.changingPermission),
      permissionOptions: entry.configuration?.snapshot().legacy || [],
      backend: entry.session.codexBackend || "openai", models: entry.models || [], fastMode: entry.fastMode, effort: entry.effort,
      busy: entry.busy, reviewing: Boolean(entry.review), archived: entry.archived, compacting: entry.compacting, compactionStatus: entry.compactionStatus,
      windowsSandboxSetup: { available: sandboxSetupAvailable(entry), mode: "elevated", status: "idle", error: null, ...entry.windowsSandboxSetup },
      goal: entry.goal, goalLoading: entry.goalLoading, goalError: entry.goalError,
      error: entry.error, pendingPlan: entry.pendingPlan,
      threadStatus: entry.threadStatus, turnStatus: entry.turnStatus, effectiveModel: entry.effectiveModel,
      errorDetails: entry.errorDetails, diagnosticStoreError: entry.diagnosticStoreError,
      diagnostics: [...entry.diagnostics], turnDiffs: [...entry.turnDiffs.values()],
      mcpRuntime: [...entry.mcpRuntime.values()], mcpLogins: [...entry.mcpLogins.entries()].map(([name, value]) => ({ name, ...value })),
      mcpReload: entry.mcpReload,
      account: entry.accountController?.snapshot() || null,
      model: entry.model, tokenUsage: entry.tokenUsage, tokenUpdatedAt: entry.tokenUpdatedAt,
      turnOutputTokens: entry.turnOutputTokens, outputTokensPerSecond: entry.outputTokensPerSecond,
      outputRateAvailable: entry.outputRateAvailable,
      streamId: entry.streamId, revision: entry.revision, items: [...entry.items], approvals: [...entry.approvals.values()].map(({ requestId, method, params }) => ({ requestId, method, params })),
      questions: [...entry.questions.values()].map(({ requestId, params, submitting }) => ({ requestId, params, submitting })),
      elicitations: [...entry.elicitations.values()].map(({ requestId, params, submitting }) => ({ requestId, params, submitting })) };
  }
  function getWorkspaceCwd(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    return projectCwd(entry);
  }
  function getPluginRuntime(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    return { cwd: projectCwd(entry), environment: { ...environmentService.resolve(entry.session), ...(entry.runtime.runtimeEnv || {}) },
      localBridge: Boolean(entry.runtime.localBridge), shell: entry.runtime.shell || entry.session.shell };
  }
  function publish(id) {
    const timer = publishTimers.get(id);
    if (timer) { clearTimeout(timer); publishTimers.delete(id); }
    const entry = sessions.get(id);
    if (!entry) return;
    entry.streamItems.clear(); entry.streamDiffs.clear(); entry.streamText.clear();
    entry.revision += 1;
    broadcast("codex-app-server:changed", { id, snapshot: snapshot(id) });
  }
  function schedulePublish(id) {
    if (!sessions.has(id) || publishTimers.has(id)) return;
    publishTimers.set(id, setTimeout(() => {
      publishTimers.delete(id);
      const entry = sessions.get(id);
      if (!entry) return;
      const items = [...entry.streamItems].map(itemId => entry.items.find(item => item.id === itemId)).filter(Boolean);
      const turnDiffs = [...entry.streamDiffs].map(turnId => entry.turnDiffs.get(turnId)).filter(Boolean);
      const textDeltas = [...entry.streamText].map(([itemId, delta]) => ({ itemId, delta }));
      entry.streamItems.clear(); entry.streamDiffs.clear(); entry.streamText.clear();
      if (!items.length && !turnDiffs.length && !textDeltas.length) return;
      const baseRevision = entry.revision;
      entry.revision += 1;
      broadcast("codex-app-server:delta", { id, streamId: entry.streamId, threadId: entry.threadId, baseRevision,
        revision: entry.revision, items, turnDiffs, textDeltas });
    }, PUBLISH_COALESCE_MS));
  }
  function recordDiagnostic(entry, kind, payload, turnId = null) {
    const at = Date.now();
    if (!entry.threadId) {
      entry.pendingDiagnostics.push({ kind, payload, turnId, at });
      return;
    }
    let eventId = `live-${randomUUID()}`;
    try { if (diagnosticsStore) eventId = String(diagnosticsStore.addEvent(entry.threadId, turnId, kind, payload, at)); }
    catch (error) { entry.diagnosticStoreError = `诊断记录保存失败：${error.message}`; }
    if (!kind.startsWith("hook/")) entry.diagnostics.push({ id: eventId, turnId, kind, at, payload });
  }
  function recordError(entry, value, turnId) {
    const structured = structuredError(value);
    const details = structured || { message: String(value?.message || "Codex 运行失败。") };
    entry.error = details.message;
    entry.errorDetails = structured;
    if (!entry.diagnostics.some(event => event.kind === "error" && event.turnId === turnId
      && event.payload.message === details.message)) recordDiagnostic(entry, "error", details, turnId);
  }
  function loadDiagnostics(entry) {
    entry.diagnostics = []; entry.turnDiffs = new Map();
    try {
      const saved = diagnosticsStore?.list(entry.threadId, { includeHooks: false });
      if (saved) {
        entry.diagnostics = saved.events.filter(event => !event.kind.startsWith("hook/"));
        entry.turnDiffs = new Map(saved.diffs.map(diff => [diff.turnId, diff]));
      }
      entry.diagnosticStoreError = null;
    } catch (error) { entry.diagnosticStoreError = `诊断记录读取失败：${error.message}`; }
    for (const event of entry.pendingDiagnostics.splice(0)) {
      let eventId = `live-${randomUUID()}`;
      try { if (diagnosticsStore) eventId = String(diagnosticsStore.addEvent(entry.threadId, event.turnId, event.kind, event.payload, event.at)); }
      catch (error) { entry.diagnosticStoreError = `诊断记录保存失败：${error.message}`; }
      if (!event.kind.startsWith("hook/")) entry.diagnostics.push({ ...event, id: eventId });
    }
  }
  function setTurnDiff(entry, turnId, diff) {
    if (!turnId || typeof diff !== "string") return;
    const value = { turnId, diff, updatedAt: Date.now() };
    entry.turnDiffs.set(turnId, value);
    try { diagnosticsStore?.setDiff(entry.threadId, turnId, diff, value.updatedAt); }
    catch (error) { entry.diagnosticStoreError = `变更记录保存失败：${error.message}`; }
  }
  function structuredError(value) {
    if (!value || typeof value !== "object") return null;
    const info = value.codexErrorInfo;
    const knownKinds = ["ContextWindowExceeded", "UsageLimitExceeded", "HttpConnectionFailed",
      "ResponseStreamConnectionFailed", "ResponseStreamDisconnected", "ResponseTooManyFailedAttempts",
      "BadRequest", "Unauthorized", "SandboxError", "InternalServerError", "Other"];
    const kind = typeof info === "string" ? info : info && typeof info === "object"
      ? (info.type || info.kind || info.code || knownKinds.find(name => Object.hasOwn(info, name))) : null;
    const httpStatusCode = info && typeof info === "object"
      ? (info.httpStatusCode || info[kind]?.httpStatusCode || null) : null;
    return { message: String(value.message || "Codex 运行失败。"), kind: kind || "Other",
      httpStatusCode: Number.isInteger(httpStatusCode) ? httpStatusCode : null,
      additionalDetails: value.additionalDetails ?? null, codexErrorInfo: info ?? null };
  }
  function recordTokenUsage(entry, baseline = entry.usageNeedsBaseline) {
    if (!entry.threadId || !entry.tokenUsage) return;
    try {
      onTokenUsage({ threadId: entry.threadId, session: entry.session, cwd: projectCwd(entry),
        model: entry.model, tokens: entry.tokenUsage.total, baseline });
      entry.usageNeedsBaseline = false;
    } catch (error) {
      console.error("Failed to record Codex App Server token statistics:", error);
    }
  }
  function resetUsageBaselines() {
    for (const entry of sessions.values()) recordTokenUsage(entry, true);
  }
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
  function validInputModalities(value) {
    return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.trim())
      ? [...value] : undefined;
  }
  function checkImageInput(entry, filePaths, orderedContent) {
    const modalities = validInputModalities(entry.models.find(model => model.id === entry.model)?.inputModalities);
    if (modalities && !modalities.includes("image") && (filePaths.some(filePath => entry.pastedImages.has(filePath)
      || /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath)) || orderedContent?.some(part => part.type === "image")))
      throw new Error("当前模型不支持图片输入，请先移除图片附件。");
  }
  async function refreshModels(entry) {
    if ((entry.session.codexBackend || "openai") !== "openai") return;
    const models = [];
    let cursor = null;
    do {
      const result = await request(entry, "model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...(result.data || []).filter(model => model?.id && !model.hidden).map(model => ({
        id: model.id, displayName: model.displayName || model.id,
        inputModalities: validInputModalities(model.inputModalities),
        fastAvailable: Array.isArray(model.serviceTiers) && model.serviceTiers.some(tier => tier.id === "priority" || tier.id === "fast"),
        defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.filter(option => typeof option?.reasoningEffort === "string" && option.reasoningEffort)
            .map(option => ({ reasoningEffort: option.reasoningEffort, description: typeof option.description === "string" ? option.description : "" }))
          : []
      })));
      cursor = result.nextCursor || null;
    } while (cursor);
    entry.models = models;
  }
  function compatibleEffort(entry, preferred = entry.effort) {
    if ((entry.session.codexBackend || "openai") !== "openai") return null;
    const model = entry.models.find(item => item.id === entry.model);
    const options = model?.supportedReasoningEfforts || [];
    if (!options.length) return null;
    if (options.some(option => option.reasoningEffort === preferred)) return preferred;
    if (options.some(option => option.reasoningEffort === model.defaultReasoningEffort)) return model.defaultReasoningEffort;
    return options[0].reasoningEffort;
  }
  function close(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    entry.subAgentObserver?.dispose();
    sessions.delete(id);
    const publishTimer = publishTimers.get(id);
    if (publishTimer) { clearTimeout(publishTimer); publishTimers.delete(id); }
    if (entry.statusTimer) clearTimeout(entry.statusTimer);
    entry.elicitations.clear();
    void releasePastedImages(id, entry);
    entry.child.kill();
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("会话已关闭。")); }
    entry.pending.clear();
  }
  function settleQuestionAnswer(entry, question, status) {
    if (!question?.submitting) return;
    const item = entry.items.find(value => value.id === `question-answer:${question.params.turnId}:${question.requestId}`);
    if (!item) return;
    item.status = status;
    try { questionAnswerStore?.update(entry.threadId, question.params.turnId, question.requestId, item); }
    catch (error) { entry.error = `问答记录保存失败：${error.message}`; }
  }
  function onMessage(id, entry, message) {
    if (sessions.get(id) !== entry) return;
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = entry.pending.get(message.id);
      if (!pending) return;
      entry.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || "App Server 请求失败。"), { code: message.error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      const method = message.method;
      if (message.params?.threadId && message.params.threadId !== entry.threadId) {
        send(entry, { id: message.id, error: { code: -32602, message: "请求不属于当前会话。" } });
        return;
      }
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
        if (entry.mode === "plan") send(entry, { id: message.id, result: method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" } : { decision: "decline" } });
        else {
          entry.approvals.set(message.id, { requestId: message.id, method, params: message.params || {} });
          entry.status = "waiting_for_permission";
          updateSummary(id, entry, message.params?.reason || message.params?.command || "等待操作确认");
          broadcastStatus(id, entry, true);
          publish(id);
        }
      } else if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
        if (!entry.busy || (message.params?.turnId && entry.turnId && message.params.turnId !== entry.turnId)) return;
        entry.questions.set(message.id, { requestId: message.id, params: message.params || {}, submitting: false,
          afterItemId: entry.items.at(-1)?.id || null });
        entry.status = "e_prompt";
        updateSummary(id, entry, message.params?.questions?.[0]?.question || "等待回答问题");
        broadcastStatus(id, entry, true);
        publish(id);
      } else if (method === "mcpServer/elicitation/request") {
        const params = message.params || {};
        if (typeof params.threadId !== "string" || !entry.threadId || !["form", "openai/form", "url"].includes(params.mode)
          || typeof params.serverName !== "string" || typeof params.message !== "string"
          || (params.mode === "url" && (typeof params.url !== "string" || !/^https?:\/\//i.test(params.url)))
          || (params.mode !== "url" && (!params.requestedSchema || typeof params.requestedSchema !== "object" || Array.isArray(params.requestedSchema)))) {
          send(entry, { id: message.id, error: { code: -32602, message: "不支持的 MCP 交互请求。" } });
          return;
        }
        entry.elicitations.set(message.id, { requestId: message.id, params, submitting: false });
        entry.status = "e_prompt";
        updateSummary(id, entry, params.message);
        broadcastStatus(id, entry, true);
        publish(id);
      } else {
        recordDiagnostic(entry, "unsupportedServerRequest", { method }, entry.turnId || null);
        send(entry, { id: message.id, error: { code: -32601, message: `未实现的服务端请求：${method}` } });
      }
      return;
    }
    const params = message.params || {};
    entry.subAgentObserver?.observe(message.method, params);
    if (message.method === "windowsSandbox/setupCompleted") {
      const setup = entry.windowsSandboxSetup;
      if (setup?.status !== "running" || setup.mode !== params.mode || typeof params.success !== "boolean") return;
      setup.status = params.success ? "succeeded" : "failed";
      setup.error = params.success ? null : String(params.error || "Windows 沙箱初始化失败。");
      publish(id);
      return;
    }
    if (entry.accountController?.onNotification(message.method, params)) return;
    if (message.method === "mcpServer/startupStatus/updated") {
      if (params.threadId !== entry.threadId || !params.name || !params.status) return;
      const previous = entry.mcpRuntime.get(params.name) || { name: params.name };
      entry.mcpStatusRevision += 1;
      entry.mcpRuntime.set(params.name, { ...previous, status: params.status,
        error: params.status === "failed" ? mcpErrorText(entry, params.error) : null,
        failureReason: params.status === "failed" ? params.failureReason || null : null });
      if (params.status === "ready") entry.mcpLogins.delete(params.name);
      else if (params.status === "failed" && entry.mcpLogins.get(params.name)?.status === "refreshing")
        entry.mcpLogins.set(params.name, { status: "failed", error: mcpErrorText(entry, params.error || "MCP 服务启动失败。") });
      if (entry.mcpReload.status === "queued") entry.mcpReload = { status: "idle", error: null };
      publish(id);
      return;
    }
    if (message.method === "mcpServer/oauthLogin/completed") {
      if ((params.threadId != null && params.threadId !== entry.threadId) || !entry.mcpLogins.has(params.name)) return;
      if (!params.success) {
        entry.mcpLogins.set(params.name, { status: "failed", error: mcpErrorText(entry, params.error || "MCP 授权失败。") });
        publish(id);
      } else {
        entry.mcpLogins.set(params.name, { status: "refreshing", error: null });
        publish(id);
        void reloadMcpServers(id).catch(error => {
          if (sessions.get(id) !== entry) return;
          entry.mcpLogins.set(params.name, { status: "failed", error: `授权已完成，但重载失败：${mcpErrorText(entry, error.message)}` });
          publish(id);
        });
      }
      return;
    }
    if ((message.method === "thread/archived" || message.method === "thread/unarchived") && params.threadId) {
      for (const [sessionId, current] of sessions) if (current.threadId === params.threadId) {
        current.archived = message.method === "thread/archived";
        publish(sessionId);
      }
    }
    if (params.threadId && params.threadId !== entry.threadId) {
      if (message.method === "thread/tokenUsage/updated" && params.threadId === entry.pendingThreadId)
        entry.pendingTokenUsage = params;
      return;
    }
    if (message.method === "thread/status/changed" && params.status?.type) {
      entry.threadStatus = params.status;
      const flags = params.status.activeFlags || [];
      if (params.status.type === "systemError") entry.status = "failed";
      else if (params.status.type === "notLoaded") entry.status = "exited";
      else if (params.status.type === "active" && flags.includes("waitingOnApproval")) entry.status = "waiting_for_permission";
      else if (params.status.type === "active" && flags.includes("waitingOnUserInput")) entry.status = "e_prompt";
      else if (params.status.type === "active") entry.status = "running";
      else if (params.status.type === "idle" && !entry.busy) entry.status = "completed";
      broadcastStatus(id, entry, true);
    }
    if (message.method === "turn/diff/updated") setTurnDiff(entry, params.turnId, params.diff);
    const isHookNotification = message.method === "hook/started" || message.method === "hook/completed";
    if (message.method === "configWarning" || message.method === "warning"
      || message.method === "hook/started" || message.method === "hook/completed"
      || message.method === "model/rerouted" || message.method === "model/safetyBuffering/updated"
      || message.method === "model/verification") {
      const previousStoreError = entry.diagnosticStoreError;
      recordDiagnostic(entry, message.method, params, params.turnId || entry.turnId || null);
      if (message.method === "model/rerouted" && typeof params.toModel === "string") entry.effectiveModel = params.toModel;
      if (isHookNotification) {
        if (entry.diagnosticStoreError !== previousStoreError) publish(id);
        return;
      }
    }
    if (message.method === "thread/tokenUsage/updated" && updateTokenUsage(entry, params)) recordTokenUsage(entry);
    if (message.method === "thread/goal/updated") {
      entry.goalRevision += 1;
      entry.goal = params.goal || null; entry.goalError = null;
    }
    if (message.method === "thread/goal/cleared") {
      entry.goalRevision += 1;
      entry.goal = null; entry.goalError = null;
    }
    if (message.method === "serverRequest/resolved") {
      entry.approvals.delete(params.requestId);
      entry.elicitations.delete(params.requestId);
      const answered = entry.questions.get(params.requestId);
      settleQuestionAnswer(entry, answered, "completed");
      entry.questions.delete(params.requestId);
      if (entry.busy) {
        entry.status = entry.questions.size || entry.elicitations.size ? "e_prompt" : entry.approvals.size ? "waiting_for_permission" : "running";
        broadcastStatus(id, entry, true);
      } else if (!entry.questions.size && !entry.elicitations.size && !entry.approvals.size && entry.status === "e_prompt") {
        entry.status = "completed";
        broadcastStatus(id, entry, true);
      }
    }
    if (message.method === "turn/started") {
      if (entry.review) { entry.review.started = true; entry.review.turnId = params.turn?.id; }
      entry.turnId = params.turn?.id; entry.busy = true;
      entry.turnStatus = "inProgress"; entry.effectiveModel = entry.model;
      entry.status = "running";
      broadcastStatus(id, entry, true);
      for (const item of entry.items.slice(entry.activeTurnStartIndex)) if (item.type === "userMessage"
        && String(item.id).startsWith("local-") && !item.turnId)
        item.turnId = entry.turnId;
      entry.turnOutputBaseline = entry.tokenUsage?.total.outputTokens || 0;
      entry.turnOutputTokens = 0; entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
      if (entry.review?.interruptRequested) {
        const review = entry.review;
        void Promise.resolve().then(() => {
          if (sessions.get(id) === entry && entry.review === review && entry.busy) return interrupt(id);
        }).catch(error => {
          if (sessions.get(id) === entry && entry.review === review) { entry.error = `停止审查失败：${error.message}`; publish(id); }
        });
      }
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = displayItem(params.item);
      if (item?.id) {
        if (["sleep", "imageGeneration"].includes(item.type) && !item.status)
          item.status = message.method === "item/completed" ? "completed" : "inProgress";
        if (item.type === "reasoning") item.status = message.method === "item/completed" ? "completed" : "inProgress";
        if (item.type === "contextCompaction") {
          item.status = message.method === "item/completed" ? "completed" : "inProgress";
          if (message.method === "item/started") { entry.compacting = true; entry.compactionStatus = "running"; }
          else entry.compactionStatus = "completed";
        }
        const previous = entry.items.find(value => value.id === item.id);
        item.turnId = params.turnId || entry.turnId || previous?.turnId;
        if (item.type === "commandExecution" && !item.output && previous?.output) item.output = previous.output;
        if (item.type === "userMessage" && !item.attachments?.length && previous?.attachments?.length)
          item.attachments = previous.attachments;
        if (item.type === "userMessage") {
          const localIndex = entry.items.findIndex(value => value.type === "userMessage"
            && String(value.id).startsWith("local-") && value.text === item.text
            && (!value.turnId || value.turnId === item.turnId));
          if (localIndex >= 0) {
            const [local] = entry.items.splice(localIndex, 1);
            if (!item.attachments?.length) item.attachments = local.attachments;
          }
        }
        let index = entry.items.findIndex(value => value.id === item.id);
        if (item.type === "exitedReviewMode" && entry.items[index]?.type === "enteredReviewMode") {
          entry.items[index].id = `${item.id}:enteredReviewMode`;
          index = -1;
        }
        if (index < 0) entry.items.push(item); else entry.items[index] = item;
        if (item.type !== "userMessage") updateSummary(id, entry, itemSummary(item));
      }
    }
    if (message.method === "item/agentMessage/delta" || message.method === "item/plan/delta") {
      const item = entry.items.find(value => value.id === params.itemId);
      if (item) {
        item.text = (item.text || "") + (params.delta || "");
        updateSummary(id, entry, itemSummary(item));
      }
    }
    if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/summaryPartAdded") {
      const item = entry.items.find(value => value.id === params.itemId && value.type === "reasoning");
      if (item) {
        const summary = Array.isArray(item.summary) ? [...item.summary] : [];
        const index = Number.isSafeInteger(params.summaryIndex) && params.summaryIndex >= 0
          ? params.summaryIndex : message.method === "item/reasoning/summaryPartAdded" ? summary.length : Math.max(0, summary.length - 1);
        if (message.method === "item/reasoning/summaryPartAdded") {
          if (summary[index] == null) summary[index] = "";
        } else if (typeof params.delta === "string") {
          summary[index] = `${typeof summary[index] === "string" ? summary[index] : ""}${params.delta}`;
        }
        item.summary = summary;
      }
    }
    if (message.method === "turn/plan/updated" && params.turnId) {
      const item = { id: `turn-plan-${params.turnId}`, type: "turnPlan", explanation: params.explanation,
        plan: Array.isArray(params.plan) ? params.plan : [], turnId: params.turnId };
      const index = entry.items.findIndex(value => value.id === item.id);
      if (index < 0) entry.items.push(item); else entry.items[index] = item;
      updateSummary(id, entry, itemSummary(item));
    }
    if (message.method === "item/commandExecution/outputDelta") {
      const item = entry.items.find(value => value.id === params.itemId);
      if (item) item.output = ((item.output || "") + (params.delta || "")).slice(-16000);
    }
    if (message.method === "error") {
      recordError(entry, params.error, params.turnId || entry.turnId || null);
      if (entry.compacting) entry.compactionStatus = "failed";
      updateSummary(id, entry, entry.error);
    }
    if (message.method === "turn/completed") {
      entry.turnStatus = params.turn?.status || "failed";
      const completedTurnId = params.turn?.id || entry.turnId || null;
      for (const item of entry.items) if (["reasoning", "sleep", "imageGeneration"].includes(item.type) && ["inProgress", "in_progress", "pending"].includes(item.status)
        && item.turnId === completedTurnId) item.status = entry.turnStatus;
      if (params.turn?.error) {
        recordError(entry, params.turn.error, completedTurnId);
      } else if (entry.turnStatus === "failed" && !entry.diagnostics.some(event => event.kind === "error" && event.turnId === completedTurnId)) {
        recordError(entry, { message: "Codex 回合失败，服务端未提供具体原因。" }, completedTurnId);
      }
      if (entry.compacting) {
        entry.compactionStatus = params.turn?.status === "completed" && entry.compactionStatus !== "failed" ? "completed" : "failed";
        if (entry.compactionStatus === "failed") {
          const item = [...entry.items].reverse().find(value => value.type === "contextCompaction" && value.turnId === entry.turnId);
          if (item) item.status = "failed";
        }
        entry.compacting = false;
      }
      for (const question of entry.questions.values()) settleQuestionAnswer(entry, question,
        params.turn?.status === "completed" ? "completed" : "failed");
      entry.questions.clear();
      for (const [requestId, elicitation] of entry.elicitations) {
        if (!elicitation.params.turnId || elicitation.params.turnId === params.turn?.id) entry.elicitations.delete(requestId);
      }
      if (entry.activeTurnMode === "plan" && params.turn?.status === "completed") {
        const plan = entry.items.slice(entry.activeTurnStartIndex).filter(item =>
          (item.type === "plan" && item.text?.trim())
          || (item.type === "agentMessage" && /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(item.text || ""))).at(-1);
        if (plan) entry.pendingPlan = { itemId: plan.id };
      }
      entry.review = null;
      entry.activeTurnMode = null;
      entry.busy = false; entry.turnId = null;
      entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
      const finalItem = entry.items.slice(entry.activeTurnStartIndex).filter(item =>
        (item.type === "agentMessage" || item.type === "plan") && item.text?.trim()).at(-1);
      if (finalItem) entry.activitySummary = itemSummary(finalItem);
      entry.status = params.turn?.status === "completed" ? "completed"
        : params.turn?.status === "interrupted" ? "interrupted" : "failed";
      broadcastStatus(id, entry, true);
    }
    if (["item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta",
      "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
      "turn/diff/updated"].includes(message.method)) {
      if (message.method === "turn/diff/updated" && params.turnId) entry.streamDiffs.add(params.turnId);
      else if ((message.method === "item/agentMessage/delta" || message.method === "item/plan/delta")
        && params.itemId && typeof params.delta === "string" && entry.items.some(item => item.id === params.itemId))
        entry.streamText.set(params.itemId, (entry.streamText.get(params.itemId) || "") + params.delta);
      else if (params.itemId) entry.streamItems.add(params.itemId);
      schedulePublish(id);
    }
    else publish(id);
  }

  async function start(session, runtime = {}) {
    const id = session.id;
    const template = session.templateId && sessionStore?.getTemplate(session.templateId);
    const fastMode = (session.codexBackend || "openai") === "openai" && (template?.codexAppServerFastMode ?? session.codexAppServerFastMode) === true;
    runtime = { ...runtime, appServerFastMode: fastMode };
    const environment = { ...environmentService.resolve(session), ...(runtime.runtimeEnv || {}) };
    let child;
    if (session.type === "ssh" && !runtime.localBridge) child = await createRemoteChild(sshAgentTransport, session, environment, fastMode);
    else {
      const invocation = buildInvocation(session, runtime, environment);
      child = spawnProcess(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env,
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    }
    const entry = { child, session, runtime, nextId: 0, pending: new Map(), approvals: new Map(), questions: new Map(), elicitations: new Map(), allowedFiles: new Set(), pastedImages: new Set(), threadId: null,
      permissionProfileId: template?.codexPermissionProfileId || session.codexPermissionProfileId || null, permissionError: null, changingPermission: false,
      turnId: null, mode: "default", executionPermission: template?.codexExecutionPermission || session.codexExecutionPermission || "askApproval",
      model: template?.codexAppServerModel || session.codexAppServerModel || session.codexModel || null,
      effort: template?.codexAppServerEffort || session.codexAppServerEffort || null, fastMode, models: [], busy: false, archived: false, error: null, items: [],
      threadStatus: null, turnStatus: null, effectiveModel: null, errorDetails: null,
      diagnostics: [], pendingDiagnostics: [], turnDiffs: new Map(), diagnosticStoreError: null,
      compacting: false, compactionStatus: null, goal: null, goalLoading: false, goalError: null, goalRevision: 0,
      pendingPlan: null, activeTurnMode: null, activeTurnStartIndex: 0,
      mcpRuntime: new Map(), mcpLogins: new Map(), mcpReload: { status: "idle", error: null }, mcpReloadPromise: null, mcpStatusRevision: 0,
      tokenUsage: null, tokenUpdatedAt: null, turnOutputBaseline: 0, turnOutputTokens: 0,
      outputTokensPerSecond: 0, outputRateAvailable: false, pendingThreadId: null, pendingTokenUsage: null,
      usageNeedsBaseline: Boolean(runtime.resumeThreadId),
      status: "completed", activitySummary: "", statusTimer: null, lastStatusBroadcastAt: 0,
      streamId: randomUUID(), revision: 0, streamItems: new Set(), streamDiffs: new Set(), streamText: new Map() };
    entry.configuration = createConfigurationController({ request: (method, params) => request(entry, method, params),
      cwd: () => projectCwd(entry), check: () => { if (sessions.get(id) !== entry) throw new Error("会话已切换。"); } });
    entry.subAgentObserver = createSubAgentObserver({ request: (method, params) => request(entry, method, params),
      changed: () => { if (sessions.get(id) === entry) publish(id); } });
    entry.accountController = createAccountController({ request: (method, params) => request(entry, method, params),
      changed: () => { if (sessions.get(id) === entry) publish(id); },
      authenticated: async () => { if (sessions.get(id) === entry && !entry.threadId) await initializeThread(id, entry); } });
    sessions.set(id, entry);
    const lines = readline.createInterface({ input: child.stdout });
    let startupStderr = "";
    let recentStderr = "";
    child.stderr.on("data", chunk => {
      recentStderr = (recentStderr + chunk.toString()).slice(-4096);
      if (!entry.threadId) startupStderr = (startupStderr + chunk.toString()).slice(-4096);
    });
    lines.on("line", line => {
      try { onMessage(id, entry, JSON.parse(line)); }
      catch { if (sessions.get(id) === entry) { entry.error = "App Server 返回了无效协议消息。"; publish(id); } }
    });
    child.on("error", error => {
      entry.subAgentObserver.dispose();
      if (sessions.get(id) !== entry) return;
      entry.error = error.message;
      entry.accountController.reset();
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      entry.pending.clear(); publish(id);
    });
    child.on("exit", code => {
      entry.subAgentObserver.dispose();
      if (sessions.get(id) !== entry) return;
      if (entry.windowsSandboxSetup?.status === "running") {
        entry.windowsSandboxSetup.status = "failed";
        entry.windowsSandboxSetup.error = "Codex App Server 已退出，沙箱初始化未完成。";
      }
      entry.review = null;
      entry.busy = false;
      entry.accountController.reset();
      entry.questions.clear();
      entry.elicitations.clear();
      const detail = session.type === "wsl" && !entry.threadId ? startupStderrDetail(startupStderr, environment) : "";
      const exitMessage = `Codex App Server 已退出（代码 ${code ?? "未知"}）。${detail ? ` 启动输出：${detail}` : ""}`;
      const exitDetail = code !== 0 ? startupStderrDetail(recentStderr, environment) : "";
      recordError(entry, { message: exitMessage, ...(exitDetail ? { additionalDetails: exitDetail } : {}) }, entry.turnId || null);
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(entry.error)); }
      entry.pending.clear(); publish(id);
      entry.status = "exited";
      broadcastStatus(id, entry, true, "AppServerExit");
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(id, "disconnected");
    });
    try {
      await request(entry, "initialize", { clientInfo: { name: "pannel_handle", title: "Pannel Handle", version: "1.0.0" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } });
      send(entry, { method: "initialized", params: {} });
      const account = (session.codexBackend || "openai") === "openai" && (!session.agentProvider || session.agentProvider === "codex")
        ? await entry.accountController.refresh() : { status: "notRequired" };
      if (account.status !== "signedOut") await initializeThread(id, entry);
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(id, "connected");
      publish(id);
      return snapshot(id);
    } catch (error) {
      const detail = session.type === "wsl" ? startupStderrDetail(startupStderr, environment) : "";
      close(id);
      if (detail && !String(error?.message || error).includes(detail)) {
        throw new Error(`${error?.message || error} WSL ${session.wslDistro} App Server 启动输出：${detail}`);
      }
      throw error;
    }
  }
  async function initializeThread(id, entry) {
    if (entry.threadId || sessions.get(id) !== entry) return;
    if (entry.threadStartPromise) return entry.threadStartPromise;
    entry.threadStartPromise = (async () => {
    await entry.configuration.load();
    let permission;
    try { permission = threadPermissions(entry); entry.permissionError = null; }
    catch (error) { entry.permissionError = error.message; publish(id); return; }
    await refreshModels(entry).catch(() => {});
    const { runtime, session } = entry;
    const template = session.templateId && sessionStore?.getTemplate(session.templateId);
    const result = runtime.resumeThreadId
      ? await request(entry, "thread/resume", { threadId: runtime.resumeThreadId, cwd: projectCwd(entry), ...permission })
      : await request(entry, "thread/start", { cwd: projectCwd(entry), ...permission, serviceName: "pannel_handle_session" });
    entry.threadId = result.thread.id;
    entry.threadStatus = result.thread.status || null;
    entry.mcpRuntime.clear(); entry.mcpLogins.clear(); entry.mcpReload = { status: "idle", error: null }; entry.mcpStatusRevision = 0;
    loadDiagnostics(entry);
    entry.model = runtime.resumeThreadId && !runtime.preferTemplateModel
      ? (result.thread.model || entry.model)
      : (template?.codexAppServerModel || session.codexAppServerModel || result.thread.model || entry.model);
    entry.effort = compatibleEffort(entry);
    if (entry.pendingTokenUsage?.threadId === entry.threadId && updateTokenUsage(entry, entry.pendingTokenUsage)) recordTokenUsage(entry);
    entry.pendingThreadId = null; entry.pendingTokenUsage = null;
    if (runtime.resumeThreadId) {
      conversationArchive?.pause(id);
      entry.items = mergeQuestionAnswers(historyItems(result.thread), questionAnswerStore?.list(result.thread.id) || []);
      const lastTurn = result.thread.turns?.at(-1);
      entry.busy = lastTurn?.status === "inProgress";
      entry.turnId = entry.busy ? lastTurn.id : null;
      entry.turnStatus = lastTurn?.status || null;
      entry.status = entry.busy ? "running" : "completed";
    }
    entry.subAgentObserver.reset(entry.threadId, entry.items);
    void refreshGoal(id, entry);
    publish(id);
    })();
    try { await entry.threadStartPromise; } finally { entry.threadStartPromise = null; }
  }
  async function restart(id) {
    const entry = sessions.get(id);
    const session = terminalManager.getSession(id);
    guardSandboxSetup(entry);
    if (!entry || !session || session.type !== "ssh") throw new Error("SSH App Server 会话不存在。");
    const threadId = entry.archived ? null : entry.threadId;
    terminalManager.setAppServerConnectionState?.(id, "reconnecting");
    close(id);
    try {
      await start(session, { ...entry.runtime, resumeThreadId: threadId });
      return terminalManager.listSessions().find(value => value.id === id);
    } catch (error) {
      terminalManager.setAppServerConnectionState?.(id, "disconnected");
      throw error;
    }
  }
  function ready(id) {
    const entry = sessions.get(id);
    guardSandboxSetup(entry);
    if (entry?.accountController?.snapshot().status === "signedOut") throw new Error("请先登录 Codex 账号。");
    if (entry?.changingPermission) throw new Error("正在切换执行权限。");
    if (!entry?.threadId || entry.busy) throw new Error("Codex 会话未就绪或正在运行。");
    return entry;
  }
  async function refreshGoal(id, entry = sessions.get(id)) {
    if (!entry?.threadId) throw new Error("Codex 会话未就绪。");
    const threadId = entry.threadId;
    const revision = entry.goalRevision;
    entry.goalLoading = true; entry.goalError = null; publish(id);
    try {
      const result = await request(entry, "thread/goal/get", { threadId });
      if (sessions.get(id) === entry && entry.threadId === threadId && entry.goalRevision === revision) {
        entry.goal = result.goal || null; entry.goalError = null;
      }
    } catch (error) {
      if (sessions.get(id) === entry && entry.threadId === threadId && entry.goalRevision === revision)
        entry.goalError = error.message;
    } finally {
      if (sessions.get(id) === entry && entry.threadId === threadId) {
        entry.goalLoading = false; publish(id);
      }
    }
    return sessions.get(id) === entry ? snapshot(id) : null;
  }
  async function setGoal(id, changes) {
    const entry = sessions.get(id);
    if (!entry?.threadId) throw new Error("Codex 会话未就绪。");
    if (!changes || typeof changes !== "object") throw new Error("无效的目标设置。");
    const params = { threadId: entry.threadId };
    if (changes.objective !== undefined) {
      if (typeof changes.objective !== "string" || !changes.objective.trim() || changes.objective.length > 4000)
        throw new Error("目标内容须为 1–4000 个字符。");
      params.objective = changes.objective.trim();
    }
    if (changes.status !== undefined) {
      if (!["active", "paused"].includes(changes.status)) throw new Error("无效的目标状态。");
      params.status = changes.status;
    }
    if (changes.tokenBudget !== undefined) {
      if (changes.tokenBudget !== null && (!Number.isSafeInteger(changes.tokenBudget) || changes.tokenBudget <= 0))
        throw new Error("Token 预算须为正整数。");
      params.tokenBudget = changes.tokenBudget;
    }
    if (Object.keys(params).length === 1) throw new Error("没有需要更新的目标内容。");
    const result = await request(entry, "thread/goal/set", params);
    if (sessions.get(id) === entry && entry.threadId === params.threadId) {
      entry.goalRevision += 1;
      entry.goal = result.goal || null; entry.goalError = null; publish(id);
    }
    return snapshot(id);
  }
  async function clearGoal(id) {
    const entry = sessions.get(id);
    if (!entry?.threadId) throw new Error("Codex 会话未就绪。");
    const threadId = entry.threadId;
    await request(entry, "thread/goal/clear", { threadId });
    if (sessions.get(id) === entry && entry.threadId === threadId) {
      entry.goalRevision += 1;
      entry.goal = null; entry.goalError = null; publish(id);
    }
    return snapshot(id);
  }
  async function startReview(id, target) {
    const entry = ready(id);
    if (entry.archived || entry.uploading) throw new Error("Codex 会话未就绪或正在运行。");
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("无效的审查目标。");
    const fields = { baseBranch: "branch", commit: "sha", custom: "instructions" };
    const normalized = { type: target.type };
    if (target.type !== "uncommittedChanges") {
      const field = Object.hasOwn(fields, target.type) ? fields[target.type] : null;
      if (!field || typeof target[field] !== "string" || !target[field].trim()) throw new Error("请填写有效的审查目标。");
      normalized[field] = target[field].trim();
    }
    const operation = { threadId: entry.threadId, started: false, turnId: null };
    entry.review = operation; entry.busy = true; entry.turnId = null;
    entry.activeTurnMode = null; entry.activeTurnStartIndex = entry.items.length;
    entry.error = null; entry.errorDetails = null; entry.status = "running";
    entry.turnStatus = "inProgress";
    entry.turnOutputBaseline = entry.tokenUsage?.total.outputTokens || 0;
    entry.turnOutputTokens = 0; entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
    updateSummary(id, entry, "正在审查代码");
    broadcastStatus(id, entry, true); publish(id);
    try {
      const result = await request(entry, "review/start", { threadId: operation.threadId, delivery: "inline", target: normalized });
      // Notifications may complete the review before its request resolves.
      if (sessions.get(id) !== entry || entry.threadId !== operation.threadId || entry.review !== operation) return;
      if (!result?.turn?.id || result.reviewThreadId !== operation.threadId) throw new Error("Codex 返回了无效的审查会话。");
      // Some CLI versions return a review submission id here, then emit a
      // different active turn id. Only turn/started supplies the interrupt id.
      for (const item of result.turn.items || []) {
        if (!entry.items.some(value => value.id === item.id && value.type === item.type))
          onMessage(id, entry, { method: "item/started", params: { threadId: operation.threadId, turnId: result.turn.id, item } });
      }
      if (["completed", "failed", "interrupted"].includes(result.turn.status))
        onMessage(id, entry, { method: "turn/completed", params: { threadId: operation.threadId, turn: result.turn } });
    } catch (error) {
      if (sessions.get(id) === entry && entry.threadId === operation.threadId && entry.review === operation) {
        if (!operation.started) { entry.review = null; entry.busy = false; entry.turnId = null; entry.status = "failed"; entry.turnStatus = "failed"; }
        entry.error = `无法启动代码审查：${error.message}`;
        broadcastStatus(id, entry, true); publish(id);
      }
      throw error;
    }
  }
  async function compactThread(id) {
    const entry = ready(id);
    const threadId = entry.threadId;
    entry.compacting = true; entry.busy = true; entry.compactionStatus = "running";
    entry.error = null; publish(id);
    try { await request(entry, "thread/compact/start", { threadId }); }
    catch (error) {
      if (sessions.get(id) === entry && entry.threadId === threadId) {
        entry.compacting = false; entry.busy = false; entry.compactionStatus = "failed";
        entry.error = error.message; publish(id);
      }
      throw error;
    }
    return snapshot(id);
  }
  function backgroundThread(id) {
    const entry = sessions.get(id);
    if (!entry?.threadId || !entry.child?.stdin?.writable) throw new Error("Codex 会话未就绪。");
    return entry;
  }
  async function listBackgroundTerminals(id) {
    const entry = backgroundThread(id);
    const threadId = entry.threadId;
    const data = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const result = await request(entry, "thread/backgroundTerminals/list", {
        threadId, limit: 100, ...(cursor ? { cursor } : {})
      });
      if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("Codex 会话已切换，请重新加载后台终端。");
      if (!Array.isArray(result?.data)) throw new Error("Codex 返回的后台终端列表无效。");
      data.push(...result.data.filter(item => item && typeof item.processId === "string" && item.processId));
      cursor = result.nextCursor || null;
      if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("后台终端分页游标无效。");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    entry.backgroundTerminalThreadId = threadId;
    entry.backgroundTerminalIds = new Set(data.map(item => item.processId));
    return data;
  }
  async function terminateBackgroundTerminal(id, processId) {
    const entry = backgroundThread(id);
    if (typeof processId !== "string" || entry.backgroundTerminalThreadId !== entry.threadId
      || !entry.backgroundTerminalIds?.has(processId))
      throw new Error("后台终端不存在或列表已过期，请刷新后重试。");
    const threadId = entry.threadId;
    const result = await request(entry, "thread/backgroundTerminals/terminate", { threadId, processId });
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("Codex 会话已切换，请重新加载后台终端。");
    if (result?.terminated !== true) throw new Error("Codex 未能终止该后台终端，请刷新列表。");
    entry.backgroundTerminalIds.delete(processId);
    return result;
  }
  async function cleanBackgroundTerminals(id) {
    const entry = backgroundThread(id);
    const threadId = entry.threadId;
    await request(entry, "thread/backgroundTerminals/clean", { threadId });
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("Codex 会话已切换，请重新加载后台终端。");
    entry.backgroundTerminalThreadId = threadId;
    entry.backgroundTerminalIds = new Set();
  }
  function allowFiles(id, filePaths) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    for (const filePath of filePaths) entry.allowedFiles.add(filePath);
  }
  async function previewAttachment(id, filePath) {
    const entry = sessions.get(id);
    if (!entry || typeof filePath !== "string" || !filePath) throw new Error("附件不存在。");
    const attached = entry.items.some(item => item.type === "userMessage"
      && item.attachments?.some(file => file.path === filePath));
    if (!entry.allowedFiles.has(filePath) && !attached) throw new Error("只能预览当前会话的附件。");
    if (isRemote(entry) && filePath.startsWith("/")) {
      if (!sshFileSystem) throw new Error("SSH 文件服务不可用。");
      const mime = IMAGE_MIME[path.posix.extname(filePath).toLowerCase()];
      const limit = mime ? IMAGE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT;
      const stat = await sshFileSystem.stat(id, filePath);
      if (typeof stat.isFile === "function" && !stat.isFile()) return { kind: "unsupported" };
      if (stat.size > limit) return { kind: "too_large", size: stat.size, limit };
      const data = await sshFileSystem.get(id, filePath);
      const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (content.length > limit) return { kind: "too_large", size: content.length, limit };
      if (mime) return { kind: "image", dataUrl: `data:${mime};base64,${content.toString("base64")}` };
      if (content.subarray(0, 4096).includes(0)) return { kind: "unsupported" };
      try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(content) }; }
      catch { return { kind: "unsupported" }; }
    }
    const hostPath = entry.session.type === "wsl" && filePath.startsWith("/")
      ? toWslHostPath(entry.session.wslDistro, filePath)
      : path.win32.isAbsolute(filePath) ? filePath : null;
    if (!hostPath) throw new Error("附件路径无效。");
    const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
    const limit = mime ? IMAGE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT;
    const handle = await fs.promises.open(hostPath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { kind: "unsupported" };
      if (stat.size > limit) return { kind: "too_large", size: stat.size, limit };
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit) return { kind: "too_large", size: bytesRead, limit };
      const content = buffer.subarray(0, bytesRead);
      if (mime) return { kind: "image", dataUrl: `data:${mime};base64,${content.toString("base64")}` };
      if (content.subarray(0, 4096).includes(0)) return { kind: "unsupported" };
      try { return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(content) }; }
      catch { return { kind: "unsupported" }; }
    } finally { await handle.close(); }
  }
  function allowPastedImage(id, filePath) {
    const entry = sessions.get(id);
    if (!entry || typeof filePath !== "string" || !filePath) throw new Error("Codex App Server 会话不存在。");
    entry.pastedImages.add(filePath);
    entry.allowedFiles.add(filePath);
  }
  async function discardPastedImage(id, filePath) {
    const entry = sessions.get(id);
    if (!entry?.pastedImages.has(filePath)) return;
    entry.pastedImages.delete(filePath);
    entry.allowedFiles.delete(filePath);
    try { await removeImage(entry, filePath); }
    catch (error) { entry.pastedImages.add(filePath); entry.allowedFiles.add(filePath); throw error; }
  }
  async function releasePastedImages(id, entry) {
    await Promise.all([...entry.pastedImages].map(async filePath => {
      entry.pastedImages.delete(filePath);
      entry.allowedFiles.delete(filePath);
      await removeImage(entry, filePath).catch(() => {});
    }));
  }
  async function listHistory(id, cursor = null, archived = false, isPinned = null) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    if (typeof archived !== "boolean" || (isPinned !== null && typeof isPinned !== "boolean")) throw new Error("无效的会话筛选条件。");
    const list = (pinned, pageCursor) => request(entry, "thread/list", { cwd: projectCwd(entry), sourceKinds: ["cli", "vscode", "appServer"],
      archived, isPinned: pinned, sortKey: "updated_at", sortDirection: "desc", limit: 25,
      ...(pageCursor ? { cursor: pageCursor } : {}) });
    let phase = "pinned";
    let pageCursor = null;
    if (isPinned !== null) { phase = isPinned ? "pinned" : "ordinary"; pageCursor = cursor; }
    else if (cursor) {
      try {
        if (!cursor.startsWith(HISTORY_CURSOR_PREFIX)) throw new Error();
        const value = JSON.parse(Buffer.from(cursor.slice(HISTORY_CURSOR_PREFIX.length), "base64url").toString("utf8"));
        if (!(["pinned", "ordinary"].includes(value.phase) && typeof value.cursor === "string" && value.cursor && value.archived === archived)) throw new Error();
        phase = value.phase; pageCursor = value.cursor;
      } catch { throw new Error("无效的历史会话游标。"); }
    }
    const encodeCursor = (nextPhase, nextCursor) => nextCursor
      ? HISTORY_CURSOR_PREFIX + Buffer.from(JSON.stringify({ phase: nextPhase, cursor: nextCursor, archived })).toString("base64url") : null;
    const mapThread = thread => ({ id: thread.id, title: thread.name || thread.preview || "未命名会话",
      updatedAt: thread.updatedAt, source: typeof thread.source === "string" ? thread.source : "unknown",
      status: thread.status?.type || "notLoaded", archived, isPinned: thread.isPinned === true });
    let pinnedPage = null;
    let ordinaryPage = null;
    if (phase === "pinned" && isPinned === null && !cursor) {
      [pinnedPage, ordinaryPage] = await Promise.all([list(true, null), list(false, null)]);
    } else if (phase === "pinned") {
      pinnedPage = await list(true, pageCursor);
    }
    if (pinnedPage?.nextCursor) {
      if (pinnedPage.nextCursor === pageCursor) throw new Error("历史会话分页游标重复。");
      return { data: (pinnedPage.data || []).map(mapThread),
        nextCursor: isPinned !== null ? pinnedPage.nextCursor : encodeCursor("pinned", pinnedPage.nextCursor) };
    }
    if (isPinned !== true && !ordinaryPage) ordinaryPage = await list(false, phase === "ordinary" ? pageCursor : null);
    const data = [...(pinnedPage?.data || []), ...(ordinaryPage?.data || [])];
    return { data: data.map(mapThread),
      nextCursor: isPinned !== null ? ordinaryPage?.nextCursor || pinnedPage?.nextCursor || null : encodeCursor("ordinary", ordinaryPage?.nextCursor) };
  }
  async function checkedThread(entry, threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) throw new Error("无效的历史会话。");
    const detail = await request(entry, "thread/read", { threadId, includeTurns: false });
    if (detail.thread?.cwd !== projectCwd(entry)) throw new Error("只能整理当前项目的历史会话。");
    return detail.thread;
  }
  async function readInitialUserInput(id, threadId) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    if (typeof threadId !== "string" || !threadId.trim()) throw new Error("无效的历史会话。");
    const detail = await request(entry, "thread/read", { threadId, includeTurns: true });
    if (detail.thread?.id !== threadId || detail.thread.cwd !== projectCwd(entry))
      throw new Error("只能读取当前项目的历史会话。");
    const first = historyItems(detail.thread).find(item => item.type === "userMessage");
    if (!first) return null;
    return { text: first.text || "", attachments: first.attachments || [] };
  }
  function assertThreadIdle(threadId) {
    if ([...sessions.values()].some(other => other.threadId === threadId && other.busy))
      throw new Error("该会话正在运行，请等待当前回合结束。");
  }
  async function renameThread(id, threadId, name) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    if (typeof name !== "string" || !name.trim()) throw new Error("会话名称不能为空。");
    await checkedThread(entry, threadId);
    await request(entry, "thread/name/set", { threadId, name: name.trim() });
  }
  async function pinThread(id, threadId, isPinned) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    if (typeof isPinned !== "boolean") throw new Error("无效的置顶状态。");
    await checkedThread(entry, threadId);
    const result = await request(entry, "thread/metadata/update", { threadId, isPinned });
    if (result?.thread?.id !== threadId || result.thread.isPinned !== isPinned)
      throw new Error("App Server 未确认会话置顶状态，请重试。");
    return { isPinned: result.thread.isPinned };
  }
  async function forkThread(id, threadId, lastTurnId = null) {
    const entry = ready(id);
    await checkedThread(entry, threadId);
    assertThreadIdle(threadId);
    if (lastTurnId !== null) {
      if (typeof lastTurnId !== "string" || !lastTurnId.trim()) throw new Error("无效的分叉回合。");
      const detail = await request(entry, "thread/read", { threadId, includeTurns: true });
      if (detail.thread?.id !== threadId || detail.thread.cwd !== projectCwd(entry))
        throw new Error("只能从当前项目的会话分叉。");
      const turn = detail.thread.turns?.find(value => value.id === lastTurnId);
      if (!turn || turn.status === "inProgress") throw new Error("所选回合不存在或仍在运行。");
      assertThreadIdle(threadId);
    }
    const result = await request(entry, "thread/fork", { threadId, ...threadPermissions(entry), ...(lastTurnId === null ? {} : { lastTurnId }) });
    if (!result.thread?.id) throw new Error("App Server 未返回分支会话 ID。");
    try { return await resume(id, result.thread.id); }
    catch (error) { throw new Error(`${error.message} 已创建的分支 ${result.thread.id} 可在历史列表中查看。`); }
  }
  async function archiveThread(id, threadId) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    await checkedThread(entry, threadId);
    assertThreadIdle(threadId);
    await request(entry, "thread/archive", { threadId });
    for (const [sessionId, current] of sessions) if (current.threadId === threadId) {
      current.archived = true; publish(sessionId);
    }
  }
  async function unarchiveThread(id, threadId) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    await checkedThread(entry, threadId);
    await request(entry, "thread/unarchive", { threadId });
    for (const [sessionId, current] of sessions) if (current.threadId === threadId) {
      current.archived = false; publish(sessionId);
      if (!current.busy) await resume(sessionId, threadId, true);
    }
  }
  async function listSkills(id, forceRefresh = false) {
    const entry = sessions.get(id);
    if (!entry?.threadId) throw new Error("Codex 会话未就绪。");
    const threadId = entry.threadId;
    const response = await request(entry, "skills/list", { cwds: [projectCwd(entry)], forceReload: Boolean(forceRefresh) });
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("会话已切换，请刷新技能列表。");
    const group = (response.data || []).find(value => value.cwd === projectCwd(entry));
    if (!group) throw new Error("Codex 未返回当前项目的技能列表。");
    if (group?.errors?.length) throw new Error(group.errors.map(value => value.message || String(value)).join("；"));
    return (group?.skills || []).filter(value => value?.name && value?.path).map(value => ({
      name: value.name, path: value.path, description: value.description || "", enabled: value.enabled !== false,
      scope: value.scope || ""
    }));
  }
  async function setSkillEnabled(id, skillPath, enabled) {
    if (typeof skillPath !== "string" || !skillPath.trim() || skillPath.includes("\0") || typeof enabled !== "boolean")
      throw new Error("无效的技能设置。");
    const entry = ready(id);
    if (entry.session.agentProvider && entry.session.agentProvider !== "codex") throw new Error("仅 Codex 图形会话支持此操作。");
    const threadId = entry.threadId;
    const check = () => {
      if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("会话已切换，请刷新技能列表。");
      ready(id);
      if (entry.archived || entry.compacting || entry.review || entry.uploading) throw new Error("当前会话不可修改技能设置。");
    };
    check();
    const operation = (entry.skillWriteQueue || Promise.resolve()).then(async () => {
      check();
      const skills = await listSkills(id, true);
      check();
      const skill = skills.find(value => value.path === skillPath);
      if (!skill) throw new Error("技能已不可用，请刷新列表后重试。");
      await request(entry, "skills/config/write", { path: skill.path, enabled });
    });
    entry.skillWriteQueue = operation.catch(() => {});
    await operation;
  }
  async function listCapabilities(id, forceRefresh = false) {
    const entry = sessions.get(id);
    if (!entry?.threadId) throw new Error("Codex 会话未就绪。");
    const result = { skills: [], apps: [], mcp: [], errors: {} };
    try { result.skills = await listSkills(id, forceRefresh); }
    catch (error) { result.errors.skills = error.message; }
    try {
      const installed = await request(entry, "app/installed", { threadId: entry.threadId, forceRefresh: Boolean(forceRefresh) });
      const states = new Map((installed.apps || []).map(value => [value.id, value]));
      let cursor = null;
      const seen = new Set();
      do {
        const response = await request(entry, "app/list", { threadId: entry.threadId, cursor, limit: 100, forceRefetch: Boolean(forceRefresh) });
        result.apps.push(...(response.data || []).filter(value => value?.id && value?.name).map(value => ({
          id: value.id, name: value.name, description: value.description || "",
          accessible: value.isAccessible === true, enabled: value.isEnabled !== false && states.get(value.id)?.enabled === true,
          callable: states.get(value.id)?.callable === true
        })));
        cursor = response.nextCursor || null;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      } while (true);
    } catch (error) { result.errors.apps = error.message; }
    const mcpRevision = entry.mcpStatusRevision;
    try {
      let cursor = null;
      const seen = new Set();
      do {
        const response = await request(entry, "mcpServerStatus/list", { threadId: entry.threadId, cursor, limit: 100, detail: "full" });
        result.mcp.push(...(response.data || []).filter(value => value?.name).map(value => ({
          name: value.name, status: value.runtimeStatus || "notStarted", authStatus: value.authStatus || "unknown",
          toolsError: value.toolsError || null, pluginId: value.pluginId || null,
          httpOrigin: value.httpOrigin || null, serverInfo: value.serverInfo || null,
          resources: (value.resources || []).filter(resource => resource?.uri && resource?.name)
            .map(resource => ({ uri: resource.uri, name: resource.name, description: resource.description || "", mimeType: resource.mimeType || null })),
          resourceTemplates: (value.resourceTemplates || []).filter(resource => resource?.uriTemplate && resource?.name)
            .map(resource => ({ uriTemplate: resource.uriTemplate, name: resource.name, description: resource.description || "" })),
          tools: Object.entries(value.tools || {}).map(([key, tool]) => ({ name: tool?.name || key,
            description: tool?.description || "" }))
        })));
        cursor = response.nextCursor || null;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      } while (true);
    } catch (error) { result.errors.mcp = error.message; }
    let clearedStatus = false;
    result.mcp = result.mcp.map(value => {
      if (value.status === "connected" && entry.mcpStatusRevision === mcpRevision) {
        if (entry.mcpRuntime.delete(value.name)) clearedStatus = true;
        if (entry.mcpLogins.get(value.name)?.status === "refreshing" && entry.mcpLogins.delete(value.name)) clearedStatus = true;
      }
      return { ...value, ...(entry.mcpRuntime.get(value.name) || {}) };
    });
    if (clearedStatus) publish(id);
    return result;
  }
  async function loginMcpServer(id, name) {
    const entry = pluginEntry(id);
    const threadId = entry.threadId;
    if (typeof name !== "string" || !name.trim()) throw new Error("请选择 MCP 服务。");
    if (entry.mcpLogins.get(name)?.status === "pending") throw new Error("该 MCP 服务正在授权。");
    entry.mcpLogins.set(name, { status: "pending", error: null });
    publish(id);
    try {
      const result = await request(entry, "mcpServer/oauth/login", { name, threadId });
      if (entry.threadId !== threadId || sessions.get(id) !== entry) throw new Error("MCP 会话已切换。");
      const url = new URL(result?.authorizationUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("授权链接协议无效。");
      return { authorizationUrl: url.href };
    } catch (error) {
      const safeError = mcpErrorText(entry, error.message);
      if (entry.threadId === threadId && sessions.get(id) === entry) {
        entry.mcpLogins.set(name, { status: "failed", error: safeError });
        publish(id);
      }
      throw new Error(safeError);
    }
  }
  function reloadMcpServers(id) {
    const entry = pluginEntry(id);
    if (entry.mcpReloadPromise) return entry.mcpReloadPromise;
    const threadId = entry.threadId;
    entry.mcpReload = { status: "reloading", error: null };
    const revision = entry.mcpStatusRevision;
    publish(id);
    const operation = request(entry, "config/mcpServer/reload", {}).then(() => {
      if (sessions.get(id) === entry && entry.threadId === threadId) { entry.mcpReload = { status: entry.mcpStatusRevision === revision ? "queued" : "idle", error: null }; publish(id); }
    }).catch(error => {
      const safeError = mcpErrorText(entry, error.message);
      if (sessions.get(id) === entry && entry.threadId === threadId) { entry.mcpReload = { status: "failed", error: safeError }; publish(id); }
      throw new Error(safeError);
    }).finally(() => { if (entry.mcpReloadPromise === operation) entry.mcpReloadPromise = null; });
    entry.mcpReloadPromise = operation;
    return operation;
  }
  function pluginEntry(id) {
    const entry = sessions.get(String(id || ""));
    if (!entry?.threadId || (entry.session.agentProvider && entry.session.agentProvider !== "codex"))
      throw new Error("Codex 图形会话未就绪。");
    return entry;
  }
  async function listPlugins(id, forceRefetch = false) {
    const entry = pluginEntry(id);
    const response = await request(entry, "plugin/list", { cwds: [projectCwd(entry)], forceRefetch: Boolean(forceRefetch) });
    if (!Array.isArray(response?.marketplaces)) throw new Error("Codex 未返回插件目录。");
    const marketplaces = response.marketplaces.map(marketplace => ({
      name: marketplace.name, path: marketplace.path || null,
      plugins: (marketplace.plugins || []).map(plugin => ({
        id: plugin.id, name: plugin.name, marketplaceName: marketplace.name,
        marketplacePath: marketplace.path || null,
        displayName: plugin.interface?.displayName || plugin.name,
        description: plugin.interface?.shortDescription || "",
        logo: plugin.interface?.logo || plugin.interface?.logoDark || null,
        logoUrl: plugin.interface?.logoUrl || plugin.interface?.logoUrlDark || null,
        installed: plugin.installed === true, enabled: plugin.enabled === true, source: plugin.source || null,
        installPolicy: plugin.installPolicy, installPolicySource: plugin.installPolicySource,
        availability: plugin.availability,
        disabledReason: plugin.disabledReason || null
      }))
    }));
    return { marketplaces, errors: (response.marketplaceLoadErrors || []).map(error => error.message || String(error)) };
  }
  async function readPluginDetail(id, pluginName, marketplaceName) {
    const entry = pluginEntry(id);
    const catalog = await listPlugins(id);
    const plugin = catalog.marketplaces.flatMap(value => value.plugins)
      .find(value => value.name === pluginName && value.marketplaceName === marketplaceName);
    if (!plugin) throw new Error("插件不在当前目录中，请刷新列表。");
    const threadId = entry.threadId;
    const response = await request(entry, "plugin/read", { pluginName,
      ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : { remoteMarketplaceName: marketplaceName }) });
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("Codex 会话已切换。");
    const detail = response?.plugin;
    if (!detail || detail.summary?.name !== pluginName) throw new Error("Codex 未返回所选插件的详情。");
    return { name: pluginName, marketplaceName, description: detail.description || plugin.description || "",
      version: detail.summary.version || detail.summary.localVersion || null,
      source: detail.summary.source || null, installed: detail.summary.installed === true,
      enabled: detail.summary.enabled === true, shareUrl: detail.shareUrl || null,
      remotePluginId: detail.summary.remotePluginId || null,
      skills: (detail.skills || []).map(skill => ({ name: skill.name, description: skill.description || "", enabled: skill.enabled !== false })),
      apps: (detail.apps || []).map(app => ({ name: app.name || app.id || "App" })),
      mcpServers: (detail.mcpServers || []).filter(value => typeof value === "string") };
  }
  async function readPluginSkill(id, pluginName, marketplaceName, skillName) {
    const entry = pluginEntry(id);
    const detail = await readPluginDetail(id, pluginName, marketplaceName);
    if (!detail.remotePluginId || !detail.skills.some(skill => skill.name === skillName)) throw new Error("此插件技能不支持远程正文读取。");
    const threadId = entry.threadId;
    const response = await request(entry, "plugin/skill/read", { remoteMarketplaceName: marketplaceName,
      remotePluginId: detail.remotePluginId, skillName });
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("Codex 会话已切换。");
    return { contents: typeof response?.contents === "string" ? response.contents.slice(0, 65536) : null,
      truncated: typeof response?.contents === "string" && response.contents.length > 65536 };
  }
  async function readAppDetail(id, appId) {
    const entry = pluginEntry(id);
    const capabilities = await listCapabilities(id);
    const app = capabilities.apps.find(value => value.id === appId);
    if (!app) throw new Error("App 不在当前会话目录中，请刷新列表。");
    const threadId = entry.threadId;
    const response = await request(entry, "app/read", { appIds: [appId], threadId, includeTools: true });
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("Codex 会话已切换。");
    const detail = response?.apps?.find(value => value.id === appId);
    if (!detail) throw new Error("此 App 当前不可访问。");
    return { id: appId, name: detail.name, description: detail.description || app.description,
      accessible: app.accessible, enabled: app.enabled, callable: app.callable,
      distributionChannel: detail.distributionChannel || null, installUrl: detail.installUrl || null,
      pluginDisplayNames: detail.pluginDisplayNames || [],
      tools: (detail.toolSummaries || []).map(tool => ({ name: tool.name, title: tool.title || tool.name,
        description: tool.description || "", enabled: tool.isEnabled === true,
        disabledReason: tool.disabledReason || null, readOnly: tool.isReadOnly === true })) };
  }
  async function readMcpResource(id, serverName, uri) {
    const entry = pluginEntry(id);
    const capabilities = await listCapabilities(id);
    const server = capabilities.mcp.find(value => value.name === serverName);
    if (!server || !server.resources.some(value => value.uri === uri)) throw new Error("MCP 资源不在当前会话目录中，请刷新列表。");
    if (server.status !== "connected" && server.status !== "ready") throw new Error("MCP 服务尚未连接。");
    const threadId = entry.threadId;
    const response = await request(entry, "mcpServer/resource/read", { threadId, server: serverName, uri });
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("Codex 会话已切换。");
    return { contents: (response?.contents || []).slice(0, 20).map(item => ({ uri: item.uri,
      mimeType: item.mimeType || null, text: typeof item.text === "string" ? item.text.slice(0, 65536) : null,
      binary: typeof item.blob === "string", truncated: typeof item.text === "string" && item.text.length > 65536 })),
      truncated: Array.isArray(response?.contents) && response.contents.length > 20 };
  }
  async function installPlugin(id, plugin) {
    const entry = pluginEntry(id);
    const installed = await request(entry, "plugin/install", { pluginName: plugin.name,
      ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : { remoteMarketplaceName: plugin.marketplaceName }) });
    return { ...await listPlugins(id), setupRequired: (installed.appsNeedingAuth || []).map(app => app.name || app.id) };
  }
  async function uninstallPlugin(id, pluginId) {
    const entry = pluginEntry(id);
    await request(entry, "plugin/uninstall", { pluginId });
    return listPlugins(id);
  }
  async function addPluginMarketplace(id, source) {
    await request(pluginEntry(id), "marketplace/add", { source });
    return listPlugins(id);
  }
  async function refreshPluginMarketplace(id, marketplaceName) {
    await request(pluginEntry(id), "marketplace/upgrade", { marketplaceName });
    return listPlugins(id);
  }
  async function removePluginMarketplace(id, marketplaceName) {
    await request(pluginEntry(id), "marketplace/remove", { marketplaceName });
    return listPlugins(id);
  }
  async function resume(id, threadId, force = false) {
    const entry = ready(id);
    if (typeof threadId !== "string" || !threadId.trim()) throw new Error("无效的历史会话。");
    if ([...sessions.entries()].some(([otherId, other]) => otherId !== id && other.threadId === threadId)) throw new Error("该历史会话已在其他窗口打开。");
    if (threadId === entry.threadId && !force) return snapshot(id);
    await checkedThread(entry, threadId);
    entry.pendingThreadId = threadId;
    entry.pendingTokenUsage = null;
    let result;
    try { result = await request(entry, "thread/resume", { threadId, cwd: projectCwd(entry), ...threadPermissions(entry) }); }
    catch (error) { entry.pendingThreadId = null; entry.pendingTokenUsage = null; throw error; }
    await releasePastedImages(id, entry);
    const previousThreadId = entry.threadId;
    entry.threadId = result.thread.id;
    entry.archived = false;
    entry.threadStatus = result.thread.status || null;
    entry.mcpRuntime.clear(); entry.mcpLogins.clear(); entry.mcpReload = { status: "idle", error: null }; entry.mcpStatusRevision = 0;
    loadDiagnostics(entry);
    entry.goal = null; entry.goalLoading = false; entry.goalError = null; entry.goalRevision += 1;
    entry.compacting = false; entry.compactionStatus = null;
    entry.model = result.thread.model || entry.session.codexAppServerModel || entry.session.codexModel || null;
    entry.effort = compatibleEffort(entry, sessionStore?.getTemplate(entry.session.templateId)?.codexAppServerEffort || entry.session.codexAppServerEffort);
    entry.tokenUsage = null; entry.tokenUpdatedAt = null;
    entry.usageNeedsBaseline = true;
    entry.turnOutputBaseline = 0; entry.turnOutputTokens = 0;
    entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
    if (entry.pendingTokenUsage && updateTokenUsage(entry, entry.pendingTokenUsage)) recordTokenUsage(entry);
    entry.pendingThreadId = null; entry.pendingTokenUsage = null;
    conversationArchive?.pause(id);
    entry.items = mergeQuestionAnswers(historyItems(result.thread), questionAnswerStore?.list(result.thread.id) || []);
    entry.subAgentObserver.reset(entry.threadId, entry.items);
    const lastTurn = result.thread.turns?.at(-1);
    entry.busy = lastTurn?.status === "inProgress";
    entry.turnId = entry.busy ? lastTurn.id : null;
    entry.turnStatus = lastTurn?.status || null;
    entry.effectiveModel = null;
    entry.mode = "default";
    entry.pendingPlan = null;
    entry.error = null;
    entry.errorDetails = null;
    entry.approvals.clear();
    entry.questions.clear();
    entry.elicitations.clear();
    entry.allowedFiles.clear();
    entry.activitySummary = itemSummary(entry.items.filter(item =>
      (item.type === "agentMessage" || item.type === "plan") && item.text?.trim()).at(-1)
      || entry.items.filter(item => item.type === "userMessage" && item.text?.trim()).at(-1));
    entry.status = entry.busy ? "running" : "completed";
    broadcastStatus(id, entry, true);
    if (previousThreadId && previousThreadId !== entry.threadId) void request(entry, "thread/unsubscribe", { threadId: previousThreadId }).catch(() => {});
    publish(id);
    void refreshGoal(id, entry);
    return snapshot(id);
  }
  async function newThread(id) {
    const entry = ready(id);
    const result = await request(entry, "thread/start", { cwd: projectCwd(entry), ...threadPermissions(entry), serviceName: "pannel_handle_session" });
    await releasePastedImages(id, entry);
    const previousThreadId = entry.threadId;
    entry.threadId = result.thread.id;
    entry.archived = false;
    entry.threadStatus = result.thread.status || null;
    entry.mcpRuntime.clear(); entry.mcpLogins.clear(); entry.mcpReload = { status: "idle", error: null }; entry.mcpStatusRevision = 0;
    loadDiagnostics(entry);
    entry.goal = null; entry.goalLoading = false; entry.goalError = null; entry.goalRevision += 1;
    entry.compacting = false; entry.compactionStatus = null;
    entry.model = sessionStore?.getTemplate(entry.session.templateId)?.codexAppServerModel || result.thread.model || entry.session.codexAppServerModel || entry.session.codexModel || null;
    entry.effort = compatibleEffort(entry, sessionStore?.getTemplate(entry.session.templateId)?.codexAppServerEffort || entry.session.codexAppServerEffort);
    entry.tokenUsage = null; entry.tokenUpdatedAt = null;
    entry.usageNeedsBaseline = false;
    entry.turnOutputBaseline = 0; entry.turnOutputTokens = 0;
    entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
    entry.mode = "default";
    entry.pendingPlan = null;
    entry.items = [];
    entry.subAgentObserver.reset(entry.threadId);
    entry.error = null;
    entry.errorDetails = null;
    entry.turnStatus = null;
    entry.effectiveModel = null;
    entry.approvals.clear();
    entry.questions.clear();
    entry.elicitations.clear();
    entry.allowedFiles.clear();
    entry.activitySummary = "";
    entry.status = "cleared";
    broadcastStatus(id, entry, true);
    if (previousThreadId) void request(entry, "thread/unsubscribe", { threadId: previousThreadId }).catch(() => {});
    publish(id);
    void refreshGoal(id, entry);
    return snapshot(id);
  }
  function setMode(id, mode) {
    const entry = ready(id);
    if (mode !== "plan" && mode !== "default") throw new Error("无效的 Codex 模式。");
    const hadPendingPlan = Boolean(entry.pendingPlan);
    entry.mode = mode;
    entry.pendingPlan = null;
    if (hadPendingPlan) broadcastStatus(id, entry, true);
    publish(id);
    return snapshot(id);
  }
  async function setModel(id, modelId) {
    let entry = ready(id);
    if (entry.uploading) throw new Error("请等待附件上传完成。");
    if ((entry.session.codexBackend || "openai") !== "openai") throw new Error("仅 OpenAI 后端支持会话内切换模型。");
    if (typeof modelId !== "string" || !entry.models.some(model => model.id === modelId)) throw new Error("请选择当前可用的 Codex 模型。");
    if (entry.model === modelId) return snapshot(id);
    if (entry.fastMode && !entry.models.find(model => model.id === modelId).fastAvailable) {
      await setFastMode(id, false);
      entry = ready(id);
    }
    if (entry.session.templateId) sessionStore.updateLibrary(entry.session.templateId, {
      codexAppServerModel: modelId
    });
    entry.model = modelId;
    entry.session.codexAppServerModel = modelId;
    entry.effort = compatibleEffort(entry);
    entry.session.codexAppServerEffort = entry.effort;
    if (entry.session.templateId) sessionStore.updateLibrary(entry.session.templateId, { codexAppServerEffort: entry.effort });
    publish(id);
    return snapshot(id);
  }
  function setEffort(id, effort) {
    const entry = ready(id);
    if (entry.busy || entry.uploading) throw new Error("请等待当前对话或附件上传完成。");
    if ((entry.session.codexBackend || "openai") !== "openai") throw new Error("仅 OpenAI 后端支持设置思考强度。");
    const model = entry.models.find(item => item.id === entry.model);
    if (typeof effort !== "string" || !model?.supportedReasoningEfforts.some(option => option.reasoningEffort === effort))
      throw new Error("请选择当前模型支持的思考强度。");
    if (entry.effort === effort) return snapshot(id);
    if (entry.session.templateId) sessionStore.updateLibrary(entry.session.templateId, { codexAppServerEffort: effort });
    entry.effort = effort;
    entry.session.codexAppServerEffort = effort;
    publish(id);
    return snapshot(id);
  }
  async function setFastMode(id, enabled) {
    const entry = ready(id);
    if (entry.uploading) throw new Error("请等待附件上传完成。");
    if ((entry.session.codexBackend || "openai") !== "openai") throw new Error("仅 OpenAI 后端支持快速模式。");
    if (typeof enabled !== "boolean") throw new Error("无效的快速模式设置。");
    if (enabled && !entry.models.find(model => model.id === entry.model)?.fastAvailable)
      throw new Error("当前模型不支持快速模式。");
    if (entry.fastMode === enabled) return snapshot(id);
    const previous = entry.fastMode;
    const threadId = entry.threadId;
    const session = entry.session;
    const runtime = entry.runtime;
    if (session.templateId) sessionStore.updateLibrary(session.templateId, { codexAppServerFastMode: enabled });
    session.codexAppServerFastMode = enabled;
    close(id);
    try { return await start(session, { ...runtime, resumeThreadId: threadId, preferTemplateModel: true }); }
    catch (error) {
      if (session.templateId) sessionStore.updateLibrary(session.templateId, { codexAppServerFastMode: previous });
      session.codexAppServerFastMode = previous;
      try { await start(session, { ...runtime, resumeThreadId: threadId, preferTemplateModel: true }); } catch {}
      throw error;
    }
  }
  function threadPermissions(entry) {
    const permission = entry.configuration.validate(entry.permissionProfileId, entry.executionPermission);
    if (permission.permissions) return permission;
    const sandbox = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" }[permission.sandboxPolicy.type];
    return { approvalPolicy: permission.approvalPolicy, sandbox };
  }
  async function readConfiguration(id) {
    const entry = sessions.get(id);
    if (!entry?.configuration) throw new Error("Codex App Server 会话不存在。");
    const threadId = entry.threadId;
    const result = await entry.configuration.load(true);
    if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("会话已切换，请刷新配置。");
    try { entry.configuration.validate(entry.permissionProfileId, entry.executionPermission); entry.permissionError = null; }
    catch (error) { entry.permissionError = error.message; }
    publish(id);
    return { ...result, cwd: projectCwd(entry), runtime: { model: entry.model, effort: entry.effort, mode: entry.mode,
      executionPermission: entry.executionPermission, permissionProfileId: entry.permissionProfileId }, permissionError: entry.permissionError };
  }
  async function changePermission(id, profileId, permission) {
    const entry = sessions.get(id);
    guardSandboxSetup(entry);
    if (!entry || entry.busy || entry.changingPermission || entry.archived || entry.compacting || entry.review || entry.uploading
      || entry.pendingPlan || entry.approvals.size || entry.questions.size || entry.elicitations.size
      || entry.accountController?.snapshot().status === "signedOut") throw new Error("当前会话不可切换执行权限。");
    const threadId = entry.threadId;
    const previous = { profileId: entry.permissionProfileId, permission: entry.executionPermission };
    entry.changingPermission = true; publish(id);
    try {
      await entry.configuration.load();
      if (sessions.get(id) !== entry || entry.threadId !== threadId || entry.busy) throw new Error("会话已切换。");
      const policy = entry.configuration.validate(profileId, permission, entry.mode === "plan");
      // Validate the saved profile even when Plan temporarily uses read-only permissions.
      entry.configuration.validate(profileId, permission);
      const params = policy.sandboxPolicy?.type === "workspaceWrite"
        ? { ...policy, sandboxPolicy: { ...policy.sandboxPolicy, writableRoots: [projectCwd(entry)] } } : policy;
      if (threadId) {
        try { await request(entry, "thread/settings/update", { threadId, ...params }); }
        catch (error) { if (profileId || !(error.code === -32601 || /method not found|unknown method/i.test(error.message))) throw error; }
      }
      if (sessions.get(id) !== entry || entry.threadId !== threadId) throw new Error("会话已切换。");
      entry.permissionProfileId = profileId; entry.executionPermission = permission; entry.permissionError = null;
      if (!threadId) await initializeThread(id, entry);
      if (entry.permissionError || !entry.threadId) throw new Error(entry.permissionError || "会话未就绪。");
      const templateId = entry.session.templateId;
      const template = templateId && sessionStore?.getTemplate(templateId);
      if (template) {
        try {
          if (profileId) sessionStore.setCodexPermissionProfile(templateId, profileId);
          else sessionStore.setCodexExecutionPermission(templateId, permission);
        } catch (error) {
          entry.permissionProfileId = previous.profileId; entry.executionPermission = previous.permission;
          try {
            const rollback = entry.configuration.validate(previous.profileId, previous.permission, entry.mode === "plan");
            await request(entry, "thread/settings/update", { threadId: entry.threadId, ...rollback });
          } catch { entry.permissionError = "模板保存失败且权限恢复未确认，请重新选择权限。"; }
          throw error;
        }
      }
      if (!profileId) for (const [sessionId, current] of sessions) {
        if (sessionId === id || !template || current.session.templateId !== templateId || current.permissionProfileId) continue;
        current.executionPermission = permission; publish(sessionId);
      }
      entry.changingPermission = false;
      return snapshot(id);
    } finally { if (sessions.get(id) === entry) { entry.changingPermission = false; publish(id); } }
  }
  async function setPermissionProfile(id, profileId) {
    if (typeof profileId !== "string" || !profileId.trim() || profileId.length > 512 || profileId.includes("\0")) throw new Error("无效的权限档。");
    return changePermission(id, profileId, sessions.get(id)?.executionPermission || "askApproval");
  }
  async function setExecutionPermission(id, permission) {
    if (!Object.prototype.hasOwnProperty.call(EXECUTION_PERMISSIONS, permission)) throw new Error("无效的 Codex 执行权限。");
    return changePermission(id, null, permission);
  }
  function dismissPlan(id, itemId) {
    const entry = sessions.get(id);
    if (!entry?.pendingPlan || entry.pendingPlan.itemId !== itemId) throw new Error("计划确认已失效。");
    entry.pendingPlan = null;
    broadcastStatus(id, entry, true);
    publish(id);
    return snapshot(id);
  }
  async function executePlan(id, itemId) {
    const entry = ready(id);
    if (entry.mode !== "plan" || !entry.pendingPlan || entry.pendingPlan.itemId !== itemId)
      throw new Error("计划确认已失效。");
    entry.pendingPlan = null;
    entry.mode = "default";
    publish(id);
    try { await submit(id, "按上述计划执行。"); }
    catch (error) {
      if (!entry.busy && sessions.get(id) === entry) {
        entry.mode = "plan";
        entry.pendingPlan = { itemId };
        publish(id);
      }
      throw error;
    }
  }
  function fileInput(entry, filePath) {
    if (entry.pastedImages.has(filePath)) return { path: filePath, image: true };
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
    return { path: targetPath, image: /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath),
      ...(isRemote(entry) ? { localPath: filePath } : {}) };
  }
  async function prepareRemoteFiles(entry, files, uploaded) {
    if (!isRemote(entry) || !files.some(file => file.localPath)) return files;
    if (!sshFileSystem) throw new Error("SSH 文件服务不可用。");
    const home = await sshFileSystem.cwd(entry.session.id);
    if (typeof home !== "string" || !home.startsWith("/")) throw new Error("无法确定远端用户目录。");
    const threadKey = createHash("sha256").update(entry.threadId).digest("hex").slice(0, 24);
    const directory = path.posix.join(home, ".cache", "pannel-handle", "app-server", threadKey);
    await sshFileSystem.mkdir(entry.session.id, directory, true);
    await sshFileSystem.chmod(entry.session.id, directory, 0o700);
    const prepared = [];
    for (const file of files) {
      if (!file.localPath) { prepared.push(file); continue; }
      const fileDirectory = path.posix.join(directory, randomUUID());
      const remotePath = path.posix.join(fileDirectory, path.win32.basename(file.localPath));
      uploaded.push(remotePath);
      await sshFileSystem.mkdir(entry.session.id, fileDirectory, true);
      await sshFileSystem.chmod(entry.session.id, fileDirectory, 0o700);
      await sshFileSystem.fastPut(entry.session.id, file.localPath, remotePath);
      await sshFileSystem.chmod(entry.session.id, remotePath, 0o600);
      if (sessions.get(entry.session.id) !== entry) throw new Error("会话已关闭。");
      prepared.push({ path: remotePath, image: file.image });
    }
    return prepared;
  }
  async function removeUploadedFiles(entry, uploaded) {
    if (!sshFileSystem || !uploaded.length) return;
    await Promise.all(uploaded.map(async filePath => {
      await sshFileSystem.remove(entry.session.id, filePath).catch(() => {});
      await sshFileSystem.remove(entry.session.id, path.posix.dirname(filePath)).catch(() => {});
    }));
  }
  async function submit(id, text, filePaths = [], references = [], orderedContent) {
    const entry = sessions.get(id);
    guardSandboxSetup(entry);
    if (entry?.changingPermission || entry?.permissionError) throw new Error(entry.permissionError || "正在切换执行权限。");
    conversationArchive?.baseline(id, snapshot(id));
    const expectedThreadId = entry?.threadId;
    if (entry?.accountController?.snapshot().status === "signedOut") throw new Error("请先登录 Codex 账号。");
    if (!entry?.threadId || entry.archived || entry.uploading || typeof text !== "string" || !Array.isArray(filePaths) || filePaths.length > 10
      || (!text.trim() && filePaths.length === 0) || !Array.isArray(references) || references.length > 10)
      throw new Error("Codex 会话未就绪或正在运行。");
    if (entry.review) throw new Error("代码审查正在进行，请等待完成或停止审查。");
    if (entry.compacting) throw new Error("会话正在压缩，请等待完成。");
    if (entry.busy && !entry.turnId) throw new Error("当前回合尚未就绪，请稍后重试。");
    if (filePaths.some(filePath => !entry.allowedFiles.has(filePath))) throw new Error("只能发送通过文件选择器附加的文件。");
    if (orderedContent !== undefined && (!Array.isArray(orderedContent) || orderedContent.length > 40
      || orderedContent.some(part => !part || (part.type !== "text" && part.type !== "image")
        || part.type === "text" && typeof part.text !== "string"
        || part.type === "image" && typeof part.path !== "string"))) throw new Error("无效的消息内容顺序。");
    const activeReferences = references.filter(value => value && typeof value.token === "string" && text.includes(value.token));
    const capabilities = activeReferences.length ? await listCapabilities(id, true) : null;
    const referenceInput = activeReferences.map(value => {
      if (value.kind === "skill" && capabilities.skills.some(skill => skill.enabled && skill.name === value.name && skill.path === value.path))
        return { type: "skill", name: value.name, path: value.path };
      if (value.kind === "app" && capabilities.apps.some(app => app.callable && app.accessible && app.enabled && app.name === value.name && `app://${app.id}` === value.path))
        return { type: "mention", name: value.name, path: value.path };
      throw new Error("所选能力已不可用，请刷新列表后重新选择。");
    });
    if (sessions.get(id) !== entry || entry.threadId !== expectedThreadId) throw new Error("会话已切换，请重新发送消息。");
    guardSandboxSetup(entry);
    if (entry.changingPermission || entry.permissionError) throw new Error(entry.permissionError || "正在切换执行权限。");
    if (entry.review) throw new Error("代码审查正在进行，请等待完成或停止审查。");
    if (!entry.busy && !entry.model) {
      const result = await request(entry, "model/list", {});
      const selected = result.data?.find(model => model.isDefault) || result.data?.[0];
      entry.model = selected?.id;
      if (selected) entry.models = [...entry.models.filter(model => model.id !== selected.id),
        { ...selected, inputModalities: validInputModalities(selected.inputModalities) }];
      entry.effort = compatibleEffort(entry);
      if (sessions.get(id) !== entry || entry.threadId !== expectedThreadId) throw new Error("会话已切换，请重新发送消息。");
    }
    checkImageInput(entry, filePaths, orderedContent);
    entry.uploading = true;
    const uploaded = [];
    let files;
    try { files = await prepareRemoteFiles(entry, filePaths.map(filePath => fileInput(entry, filePath)), uploaded); }
    catch (error) { entry.uploading = false; await removeUploadedFiles(entry, uploaded); throw error; }
    let turnRequestSent = false;
    let startingTurn = false;
    try {
      if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
      checkImageInput(entry, filePaths, orderedContent);
      const imagePaths = filePaths.filter((_, index) => files[index].image);
      const suppliedImages = orderedContent?.filter(part => part.type === "image").map(part => part.path);
      if (orderedContent && (orderedContent.filter(part => part.type === "text").map(part => part.text).join("").trim() !== text.trim()
        || new Set(suppliedImages).size !== suppliedImages.length
        || suppliedImages.some(filePath => !imagePaths.includes(filePath))))
        throw new Error("图片顺序与附件不一致。");
      const fileReferences = files.filter(file => !file.image).map(file => JSON.stringify(file.path));
      const legacyText = [text.trim(), ...(fileReferences.length ? [`请读取以下附件文件：${fileReferences.join("、")}`] : [])].filter(Boolean).join("\n\n");
      const messageParts = orderedContent || [...(legacyText ? [{ type: "text", text: legacyText }] : []),
        ...imagePaths.map(filePath => ({ type: "image", path: filePath }))];
      const orderedInput = messageParts.map(part => part.type === "text" ? { type: "text", text: part.text }
        : { type: "localImage", path: files[filePaths.indexOf(part.path)].path });
      if (orderedContent && fileReferences.length) orderedInput.push({ type: "text", text: `\n\n请读取以下附件文件：${fileReferences.join("、")}` });
      if (orderedContent) orderedInput.push(...imagePaths.filter(filePath => !suppliedImages.includes(filePath))
        .map(filePath => ({ type: "localImage", path: files[filePaths.indexOf(filePath)].path })));
      if (!entry.busy && !entry.model) throw new Error("无法确定 Codex 模型，不能切换协作模式。");
      entry.error = null;
      entry.errorDetails = null;
      startingTurn = !entry.busy;
      if (startingTurn) {
        entry.pendingPlan = null;
        entry.activeTurnMode = entry.mode;
        entry.activeTurnStartIndex = entry.items.length;
        entry.busy = true;
      }
      const localId = `local-${randomUUID()}`;
      entry.items.push({ id: localId, type: "userMessage",
        turnId: entry.turnId || undefined, text: text.trim(),
        attachments: files.map(file => ({ path: file.path, name: path.basename(file.path) })),
        ...(orderedContent ? { parts: messageParts.map(part => part.type === "text" ? part : { type: "image",
          path: files[filePaths.indexOf(part.path)].path, name: path.basename(files[filePaths.indexOf(part.path)].path) }) } : {}) });
      publish(id);
      if (startingTurn || (!entry.approvals.size && !entry.questions.size)) entry.status = "running";
      entry.activitySummary = activitySummary(text.trim() || entry.items.at(-1).text);
      broadcastStatus(id, entry, true);
      try {
        const input = [...orderedInput, ...referenceInput];
        turnRequestSent = true;
        let result;
        if (startingTurn) {
          const permission = entry.configuration.validate(entry.permissionProfileId, entry.executionPermission, entry.mode === "plan");
          const policy = permission.sandboxPolicy?.type === "workspaceWrite"
            ? { ...permission, sandboxPolicy: { ...permission.sandboxPolicy, writableRoots: [projectCwd(entry)] } } : permission;
          result = await request(entry, "turn/start", { threadId: entry.threadId, input, model: entry.model,
            summary: "auto",
            ...(entry.effort ? { effort: entry.effort } : {}),
            ...policy,
            collaborationMode: { mode: entry.mode, settings: { model: entry.model, developer_instructions: null } } });
        } else {
          result = await request(entry, "turn/steer", { threadId: entry.threadId, input, expectedTurnId: entry.turnId });
        }
        for (const filePath of filePaths) entry.allowedFiles.delete(filePath);
        for (const filePath of filePaths) entry.pastedImages.delete(filePath);
        if (startingTurn && entry.busy) entry.turnId = result.turn?.id || entry.turnId;
      } catch (error) {
        if (startingTurn) { entry.busy = false; entry.activeTurnMode = null; }
        entry.error = error.message;
        entry.items = entry.items.filter(item => item.id !== localId);
        if (startingTurn) entry.status = "failed";
        entry.activitySummary = activitySummary(error.message);
        broadcastStatus(id, entry, true); publish(id); throw error;
      }
    } catch (error) {
      if (!turnRequestSent) await removeUploadedFiles(entry, uploaded);
      throw error;
    } finally {
      entry.uploading = false;
    }
  }
  async function interrupt(id) {
    const entry = sessions.get(id);
    if (entry?.review && !entry.review.started) { entry.review.interruptRequested = true; return; }
    if (entry?.turnId) await request(entry, "turn/interrupt", { threadId: entry.threadId, turnId: entry.turnId });
  }
  function resolveApproval(id, requestId, decision) {
    const entry = sessions.get(id);
    const approval = entry?.approvals.get(requestId);
    if (!approval) throw new Error("确认请求已失效。");
    const selected = decision === true ? "accept" : decision === false ? "decline" : decision;
    const { method, params } = approval;
    let result;
    if (method === "item/permissions/requestApproval") {
      if (!["accept", "acceptForSession", "decline"].includes(selected)) throw new Error("无效的权限确认选择。");
      result = { permissions: selected === "decline" ? {} : params.permissions || {},
        scope: selected === "acceptForSession" ? "session" : "turn" };
    } else {
      const allowed = method === "item/commandExecution/requestApproval"
        ? ["accept", "acceptForSession", "decline", "cancel", "acceptWithExecpolicyAmendment"]
        : ["accept", "acceptForSession", "decline", "cancel"];
      if (!allowed.includes(selected)) throw new Error("无效的审批选择。");
      if (Array.isArray(params.availableDecisions) && !params.availableDecisions.some(value =>
        value === selected || (selected === "acceptWithExecpolicyAmendment" && value && typeof value === "object"
          && Object.hasOwn(value, selected)))) throw new Error("当前请求不允许此审批选择。");
      if (selected === "acceptWithExecpolicyAmendment") {
        const amendment = params.proposedExecpolicyAmendment;
        if (!Array.isArray(amendment) || !amendment.length || amendment.some(value => typeof value !== "string" || !value.trim()))
          throw new Error("当前请求没有有效的命令规则修订建议。");
        result = { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...amendment] } } };
      } else result = { decision: selected };
    }
    send(entry, { id: requestId, result });
    entry.approvals.delete(requestId);
    if (!entry.approvals.size && !entry.questions.size && entry.busy) { entry.status = "running"; broadcastStatus(id, entry, true); }
    publish(id);
  }
  function answerQuestion(id, requestId, answers) {
    const entry = sessions.get(id);
    const question = entry?.questions.get(requestId);
    if (!entry?.threadId || !entry.busy || !question || question.submitting || question.params.threadId !== entry.threadId
      || (question.params.turnId && question.params.turnId !== entry.turnId)) throw new Error("问题请求已失效。");
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("问题答案无效。");
    const expected = question.params.questions;
    if (!Array.isArray(expected) || expected.length === 0 || Object.keys(answers).length !== expected.length
      || expected.some(item => !Object.hasOwn(answers, item.id) || !Array.isArray(answers[item.id]?.answers)
        || answers[item.id].answers.length === 0 || answers[item.id].answers.some(value => typeof value !== "string" || !value.trim())))
      throw new Error("请回答所有问题。");
    question.submitting = true;
    const item = questionAnswerItem(question, answers, question.afterItemId);
    let saved = false;
    try {
      questionAnswerStore?.save(entry.threadId, question.params.turnId, requestId, question.afterItemId, item);
      saved = Boolean(questionAnswerStore);
      send(entry, { id: requestId, result: { answers } });
    } catch (error) {
      if (saved) questionAnswerStore.remove(entry.threadId, question.params.turnId, requestId);
      question.submitting = false;
      publish(id);
      throw error;
    }
    entry.items.push(item);
    publish(id);
  }
  function resolveElicitation(id, requestId, action, content = null) {
    const entry = sessions.get(id);
    const elicitation = entry?.elicitations.get(requestId);
    if (!entry?.threadId || !elicitation || elicitation.submitting || elicitation.params.threadId !== entry.threadId
      || (elicitation.params.turnId && elicitation.params.turnId !== entry.turnId)) throw new Error("MCP 交互请求已失效。");
    if (!["accept", "decline", "cancel"].includes(action)) throw new Error("无效的 MCP 交互操作。");
    if (action === "accept" && elicitation.params.mode !== "url"
      && (!content || typeof content !== "object" || Array.isArray(content))) throw new Error("表单内容必须是对象。");
    if (action !== "accept" || elicitation.params.mode === "url") content = null;
    elicitation.submitting = true;
    try { send(entry, { id: requestId, result: { action, content } }); }
    catch (error) { elicitation.submitting = false; throw error; }
    publish(id);
  }
  function setSubAgentView(id, expanded, threadId, rootThreadId) {
    const entry = sessions.get(id);
    if (!entry?.threadId) throw new Error("Codex 会话未就绪。");
    if (rootThreadId && rootThreadId !== entry.threadId) throw new Error("子 Agent 面板所属会话已切换。");
    entry.subAgentObserver.setView(expanded, threadId);
  }
  async function refreshSubAgents(id, rootThreadId) {
    const entry = sessions.get(id);
    if (!entry?.threadId) throw new Error("Codex 会话未就绪。");
    if (rootThreadId && rootThreadId !== entry.threadId) throw new Error("子 Agent 面板所属会话已切换。");
    await entry.subAgentObserver.refresh();
  }
  function shutdown() { for (const id of sessions.keys()) close(id); }
  function accountEntry(id) {
    const entry = sessions.get(id);
    if (!entry || (entry.session.codexBackend || "openai") !== "openai"
      || (entry.session.agentProvider && entry.session.agentProvider !== "codex")) throw new Error("此会话不使用 OpenAI Codex 账号。");
    return entry;
  }
  async function readAccount(id) { return accountEntry(id).accountController.refresh(); }
  async function startLogin(id, type) { return accountEntry(id).accountController.startLogin(type); }
  async function cancelLogin(id) { return accountEntry(id).accountController.cancelLogin(); }
  async function logout(id) {
    const entry = accountEntry(id);
    if (entry.busy) throw new Error("请等待当前回复完成后登出。");
    return entry.accountController.logout();
  }
  async function refreshAccountUsage(id) { return accountEntry(id).accountController.refreshUsage(); }
  return { readConfiguration, setPermissionProfile, setSubAgentView, refreshSubAgents, start, restart, snapshot, setupWindowsSandbox, getWorkspaceCwd, getPluginRuntime, resetUsageBaselines, allowFiles, previewAttachment, allowPastedImage, discardPastedImage, listHistory, readInitialUserInput, renameThread, pinThread, forkThread, archiveThread, unarchiveThread, listSkills, setSkillEnabled, listCapabilities, readPluginDetail, readPluginSkill, readAppDetail, readMcpResource, loginMcpServer, reloadMcpServers, listPlugins, installPlugin, uninstallPlugin, addPluginMarketplace, refreshPluginMarketplace, removePluginMarketplace, resume, newThread, compactThread, listBackgroundTerminals, terminateBackgroundTerminal, cleanBackgroundTerminals, getGoal: refreshGoal, setGoal, clearGoal, setMode, setModel, setEffort, setFastMode, setExecutionPermission, dismissPlan, executePlan, submit, interrupt, resolveApproval, answerQuestion, resolveElicitation, close, shutdown,
    startReview, readAccount, startLogin, cancelLogin, logout, refreshAccountUsage };
}

module.exports = { createCodexAppServerSessionService, buildInvocation };
