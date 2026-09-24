const { spawn, spawnSync } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const readline = require("node:readline");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const { mergeEnvironment } = require("../environment/index.cjs");
const { toWslHostPath } = require("../../core/wsl-paths.cjs");
const SUMMARY_LIMIT = 500;
const SUMMARY_BROADCAST_INTERVAL_MS = 150;
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
  const command = `${runtime.codexCommand || "codex"} app-server${tierArgs(session, runtime.appServerFastMode)}`;
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

function displayItem(item) {
  if (item?.type !== "userMessage") return item;
  const attachments = [];
  const text = item.content?.map(part => {
    if (part.type === "localImage" && typeof part.path === "string") {
      attachments.push({ path: part.path, name: path.basename(part.path) });
      return "";
    }
    if (part.type === "image") return "[图片]";
    if (part.type !== "text") return "";
    const raw = String(part.text || "");
    const marker = "请读取以下附件文件：";
    const position = raw.lastIndexOf(marker);
    if (position < 0 || (position > 0 && raw.slice(position - 2, position) !== "\n\n")) return raw;
    const references = raw.slice(position + marker.length);
    const matches = [...references.matchAll(/"(?:\\.|[^"\\])*"/g)];
    if (!matches.length || matches.map(match => match[0]).join("、") !== references) return raw;
    try {
      for (const match of matches) {
        const filePath = JSON.parse(match[0]);
        if (typeof filePath !== "string") return raw;
        attachments.push({ path: filePath, name: path.basename(filePath) });
      }
      return raw.slice(0, position).trimEnd();
    } catch { return raw; }
  }).filter(Boolean).join("\n");
  return { ...item, text: Array.isArray(item.content) ? text : item.text || "", attachments };
}

function historyItems(thread) {
  return (thread?.turns || []).flatMap(turn => (turn.items || []).map(item => ({ ...displayItem(item),
    ...(turn.id ? { turnId: turn.id } : {}) }))).filter(item => item?.id);
}

function mergeQuestionAnswers(items, records) {
  const merged = [...items];
  for (const record of records) {
    const item = record.item;
    if (merged.some(existing => existing.id === item.id)) continue;
    let index = merged.findIndex(existing => existing.id === record.afterItemId);
    if (index < 0) index = merged.findLastIndex(existing => existing.turnId === record.turnId && existing.type === "userMessage");
    if (index < 0) index = merged.findLastIndex(existing => existing.turnId === record.turnId);
    if (index < 0) index = merged.length - 1;
    while (merged[index + 1]?.type === "questionAnswer" && merged[index + 1].afterItemId === record.afterItemId) index += 1;
    merged.splice(index + 1, 0, item);
  }
  return merged;
}

function questionAnswerItem(question, answers, afterItemId) {
  const { turnId, questions } = question.params;
  return {
    id: `question-answer:${turnId}:${question.requestId}`, type: "questionAnswer", turnId,
    afterItemId, status: "submitted",
    questions: questions.map(prompt => ({
      id: prompt.id, header: prompt.header, question: prompt.question,
      answers: prompt.isSecret ? ["••••••"] : [...answers[prompt.id].answers]
    }))
  };
}

function activitySummary(value, recent = false) {
  const text = String(value || "").replace(/<\/?proposed_plan>/gi, "").replace(/\s+/g, " ").trim();
  if (text.length <= SUMMARY_LIMIT) return text;
  return recent ? `…${text.slice(-(SUMMARY_LIMIT - 1))}` : `${text.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function itemSummary(item) {
  if (item?.type === "agentMessage" || item?.type === "plan") return activitySummary(item.text, true);
  if (item?.type === "userMessage") return activitySummary(item.text);
  if (item?.type === "commandExecution") return activitySummary(`执行命令：${item.command || "命令"}`);
  if (item?.type === "fileChange") return "修改文件";
  if (item?.type === "turnPlan") {
    const step = item.plan?.find(value => value.status === "inProgress")
      || item.plan?.find(value => value.status === "pending") || item.plan?.at(-1);
    return activitySummary(step?.step || item.explanation);
  }
  return "";
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function tokenBreakdown(value) {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.inputTokens)
    || !Number.isSafeInteger(value.outputTokens)) return null;
  return {
    inputTokens: tokenCount(value.inputTokens), cachedInputTokens: tokenCount(value.cachedInputTokens),
    cacheWriteInputTokens: tokenCount(value.cacheWriteInputTokens), outputTokens: tokenCount(value.outputTokens),
    reasoningOutputTokens: tokenCount(value.reasoningOutputTokens), totalTokens: tokenCount(value.totalTokens)
  };
}

function updateTokenUsage(entry, params) {
  const total = tokenBreakdown(params.tokenUsage?.total);
  const last = tokenBreakdown(params.tokenUsage?.last);
  if (!total || !last) return false;
  const previousOutput = entry.tokenUsage?.total.outputTokens;
  const previousAt = entry.tokenUpdatedAt;
  const updatedAt = Date.now();
  if (previousOutput != null && total.outputTokens > previousOutput && previousAt != null && updatedAt > previousAt) {
    entry.outputTokensPerSecond = Math.round((total.outputTokens - previousOutput) * 10000 / (updatedAt - previousAt)) / 10;
    entry.outputRateAvailable = true;
  }
  entry.tokenUsage = { total, last, modelContextWindow: params.tokenUsage.modelContextWindow ?? null };
  entry.tokenUpdatedAt = updatedAt;
  entry.turnOutputTokens = Math.max(0, total.outputTokens - entry.turnOutputBaseline);
  return true;
}

function createCodexAppServerSessionService({ environmentService, terminalManager, broadcast, sessionStore = null, questionAnswerStore = null, spawnProcess = spawn, spawnSyncProcess = spawnSync,
  sshAgentTransport = null, sshFileSystem = null, removePastedImage = null, onTokenUsage = () => {} }) {
  const sessions = new Map();
  const isRemote = entry => entry.session.type === "ssh" && !entry.runtime.localBridge;
  const projectCwd = entry => entry.runtime.workspaceCwd || entry.session.cwd;
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

  function snapshot(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    return { threadId: entry.threadId, mode: entry.mode, executionPermission: entry.executionPermission,
      backend: entry.session.codexBackend || "openai", models: entry.models || [], fastMode: entry.fastMode, effort: entry.effort,
      busy: entry.busy, error: entry.error, pendingPlan: entry.pendingPlan,
      model: entry.model, tokenUsage: entry.tokenUsage, tokenUpdatedAt: entry.tokenUpdatedAt,
      turnOutputTokens: entry.turnOutputTokens, outputTokensPerSecond: entry.outputTokensPerSecond,
      outputRateAvailable: entry.outputRateAvailable,
      items: [...entry.items], approvals: [...entry.approvals.values()].map(({ requestId, method, params }) => ({ requestId, method, params })),
      questions: [...entry.questions.values()].map(({ requestId, params, submitting }) => ({ requestId, params, submitting })) };
  }
  function getWorkspaceCwd(id) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    return projectCwd(entry);
  }
  function publish(id) { broadcast("codex-app-server:changed", { id, snapshot: snapshot(id) }); }
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
  async function refreshModels(entry) {
    if ((entry.session.codexBackend || "openai") !== "openai") return;
    const models = [];
    let cursor = null;
    do {
      const result = await request(entry, "model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...(result.data || []).filter(model => model?.id && !model.hidden).map(model => ({
        id: model.id, displayName: model.displayName || model.id,
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
    sessions.delete(id);
    if (entry.statusTimer) clearTimeout(entry.statusTimer);
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
        else {
          entry.approvals.set(message.id, { requestId: message.id, method, params: message.params || {} });
          entry.status = "waiting_for_permission";
          updateSummary(id, entry, message.params?.reason || message.params?.command || "等待操作确认");
          broadcastStatus(id, entry, true);
          publish(id);
        }
      } else if (method === "item/tool/requestUserInput") {
        if (!entry.busy || (message.params?.turnId && entry.turnId && message.params.turnId !== entry.turnId)) return;
        entry.questions.set(message.id, { requestId: message.id, params: message.params || {}, submitting: false,
          afterItemId: entry.items.at(-1)?.id || null });
        entry.status = "e_prompt";
        updateSummary(id, entry, message.params?.questions?.[0]?.question || "等待回答问题");
        broadcastStatus(id, entry, true);
        publish(id);
      } else {
        const result = method === "mcpServer/elicitation/request" ? { action: "decline", content: null } : { decision: "decline" };
        send(entry, { id: message.id, result });
      }
      return;
    }
    const params = message.params || {};
    if (params.threadId && params.threadId !== entry.threadId) {
      if (message.method === "thread/tokenUsage/updated" && params.threadId === entry.pendingThreadId)
        entry.pendingTokenUsage = params;
      return;
    }
    if (message.method === "thread/tokenUsage/updated" && updateTokenUsage(entry, params)) recordTokenUsage(entry);
    if (message.method === "serverRequest/resolved") {
      entry.approvals.delete(params.requestId);
      const answered = entry.questions.get(params.requestId);
      settleQuestionAnswer(entry, answered, "completed");
      entry.questions.delete(params.requestId);
      if (entry.busy) {
        entry.status = entry.questions.size ? "e_prompt" : entry.approvals.size ? "waiting_for_permission" : "running";
        broadcastStatus(id, entry, true);
      }
    }
    if (message.method === "turn/started") {
      entry.turnId = params.turn?.id; entry.busy = true;
      for (const item of entry.items.slice(entry.activeTurnStartIndex)) if (item.type === "userMessage"
        && String(item.id).startsWith("local-") && !item.turnId)
        item.turnId = entry.turnId;
      entry.turnOutputBaseline = entry.tokenUsage?.total.outputTokens || 0;
      entry.turnOutputTokens = 0; entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = displayItem(params.item);
      if (item?.id) {
        const previous = entry.items.find(value => value.id === item.id);
        item.turnId = params.turnId || entry.turnId || previous?.turnId;
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
        const index = entry.items.findIndex(value => value.id === item.id);
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
      entry.error = params.error?.message || "Codex 运行失败。";
      updateSummary(id, entry, entry.error);
    }
    if (message.method === "turn/completed") {
      for (const question of entry.questions.values()) settleQuestionAnswer(entry, question,
        params.turn?.status === "completed" ? "completed" : "failed");
      entry.questions.clear();
      if (entry.activeTurnMode === "plan" && params.turn?.status === "completed") {
        const plan = entry.items.slice(entry.activeTurnStartIndex).filter(item =>
          (item.type === "plan" && item.text?.trim())
          || (item.type === "agentMessage" && /<proposed_plan>[\s\S]*?<\/proposed_plan>/i.test(item.text || ""))).at(-1);
        if (plan) entry.pendingPlan = { itemId: plan.id };
      }
      entry.activeTurnMode = null;
      entry.busy = false; entry.turnId = null;
      entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
      const finalItem = entry.items.slice(entry.activeTurnStartIndex).filter(item =>
        (item.type === "agentMessage" || item.type === "plan") && item.text?.trim()).at(-1);
      if (finalItem) entry.activitySummary = itemSummary(finalItem);
      entry.status = params.turn?.status === "completed" ? "completed" : "failed";
      broadcastStatus(id, entry, true);
    }
    publish(id);
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
    const entry = { child, session, runtime, nextId: 0, pending: new Map(), approvals: new Map(), questions: new Map(), allowedFiles: new Set(), pastedImages: new Set(), threadId: null,
      turnId: null, mode: "default", executionPermission: template?.codexExecutionPermission || session.codexExecutionPermission || "askApproval",
      model: template?.codexAppServerModel || session.codexAppServerModel || session.codexModel || null,
      effort: template?.codexAppServerEffort || session.codexAppServerEffort || null, fastMode, models: [], busy: false, error: null, items: [],
      pendingPlan: null, activeTurnMode: null, activeTurnStartIndex: 0,
      tokenUsage: null, tokenUpdatedAt: null, turnOutputBaseline: 0, turnOutputTokens: 0,
      outputTokensPerSecond: 0, outputRateAvailable: false, pendingThreadId: null, pendingTokenUsage: null,
      usageNeedsBaseline: Boolean(runtime.resumeThreadId),
      status: "completed", activitySummary: "", statusTimer: null, lastStatusBroadcastAt: 0 };
    sessions.set(id, entry);
    const lines = readline.createInterface({ input: child.stdout });
    let startupStderr = "";
    child.stderr.on("data", chunk => {
      if (!entry.threadId) startupStderr = (startupStderr + chunk.toString()).slice(-4096);
    });
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
      entry.questions.clear();
      const detail = session.type === "wsl" && !entry.threadId ? startupStderrDetail(startupStderr, environment) : "";
      entry.error ||= `Codex App Server 已退出（代码 ${code ?? "未知"}）。${detail ? ` 启动输出：${detail}` : ""}`;
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(entry.error)); }
      entry.pending.clear(); publish(id);
      entry.status = "exited";
      broadcastStatus(id, entry, true, "AppServerExit");
      if (session.type === "ssh") terminalManager.setAppServerConnectionState?.(id, "disconnected");
    });
    try {
      await request(entry, "initialize", { clientInfo: { name: "pannel_handle", title: "Pannel Handle", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      send(entry, { method: "initialized", params: {} });
      await refreshModels(entry).catch(() => {});
      const result = runtime.resumeThreadId
        ? await request(entry, "thread/resume", { threadId: runtime.resumeThreadId, cwd: projectCwd(entry) })
        : await request(entry, "thread/start", { cwd: projectCwd(entry), approvalPolicy: "on-request", sandbox: "workspace-write", serviceName: "pannel_handle_session" });
      entry.threadId = result.thread.id;
      entry.model = runtime.resumeThreadId && !runtime.preferTemplateModel
        ? (result.thread.model || entry.model)
        : (template?.codexAppServerModel || session.codexAppServerModel || result.thread.model || entry.model);
      entry.effort = compatibleEffort(entry);
      if (entry.pendingTokenUsage?.threadId === entry.threadId && updateTokenUsage(entry, entry.pendingTokenUsage)) recordTokenUsage(entry);
      entry.pendingThreadId = null; entry.pendingTokenUsage = null;
      if (runtime.resumeThreadId) {
        entry.items = mergeQuestionAnswers(historyItems(result.thread), questionAnswerStore?.list(result.thread.id) || []);
        const lastTurn = result.thread.turns?.at(-1);
        entry.busy = lastTurn?.status === "inProgress";
        entry.turnId = entry.busy ? lastTurn.id : null;
        entry.status = entry.busy ? "running" : "completed";
      }
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
  async function restart(id) {
    const entry = sessions.get(id);
    const session = terminalManager.getSession(id);
    if (!entry || !session || session.type !== "ssh") throw new Error("SSH App Server 会话不存在。");
    const threadId = entry.threadId;
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
    if (!entry?.threadId || entry.busy) throw new Error("Codex 会话未就绪或正在运行。");
    return entry;
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
  async function listHistory(id, cursor = null) {
    const entry = sessions.get(id);
    if (!entry) throw new Error("Codex App Server 会话不存在。");
    const result = await request(entry, "thread/list", { cwd: projectCwd(entry), sourceKinds: ["cli", "vscode", "appServer"],
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
    if (detail.thread?.cwd !== projectCwd(entry)) throw new Error("只能恢复当前项目的历史会话。");
    entry.pendingThreadId = threadId;
    entry.pendingTokenUsage = null;
    let result;
    try { result = await request(entry, "thread/resume", { threadId, cwd: projectCwd(entry) }); }
    catch (error) { entry.pendingThreadId = null; entry.pendingTokenUsage = null; throw error; }
    await releasePastedImages(id, entry);
    const previousThreadId = entry.threadId;
    entry.threadId = result.thread.id;
    entry.model = result.thread.model || entry.session.codexAppServerModel || entry.session.codexModel || null;
    entry.effort = compatibleEffort(entry, sessionStore?.getTemplate(entry.session.templateId)?.codexAppServerEffort || entry.session.codexAppServerEffort);
    entry.tokenUsage = null; entry.tokenUpdatedAt = null;
    entry.usageNeedsBaseline = true;
    entry.turnOutputBaseline = 0; entry.turnOutputTokens = 0;
    entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
    if (entry.pendingTokenUsage && updateTokenUsage(entry, entry.pendingTokenUsage)) recordTokenUsage(entry);
    entry.pendingThreadId = null; entry.pendingTokenUsage = null;
    entry.items = mergeQuestionAnswers(historyItems(result.thread), questionAnswerStore?.list(result.thread.id) || []);
    const lastTurn = result.thread.turns?.at(-1);
    entry.busy = lastTurn?.status === "inProgress";
    entry.turnId = entry.busy ? lastTurn.id : null;
    entry.mode = "default";
    entry.pendingPlan = null;
    entry.error = null;
    entry.approvals.clear();
    entry.questions.clear();
    entry.allowedFiles.clear();
    entry.activitySummary = itemSummary(entry.items.filter(item =>
      (item.type === "agentMessage" || item.type === "plan") && item.text?.trim()).at(-1)
      || entry.items.filter(item => item.type === "userMessage" && item.text?.trim()).at(-1));
    entry.status = entry.busy ? "running" : "completed";
    broadcastStatus(id, entry, true);
    if (previousThreadId) void request(entry, "thread/unsubscribe", { threadId: previousThreadId }).catch(() => {});
    publish(id);
    return snapshot(id);
  }
  async function newThread(id) {
    const entry = ready(id);
    const result = await request(entry, "thread/start", { cwd: projectCwd(entry), approvalPolicy: "on-request",
      sandbox: "workspace-write", serviceName: "pannel_handle_session" });
    await releasePastedImages(id, entry);
    const previousThreadId = entry.threadId;
    entry.threadId = result.thread.id;
    entry.model = sessionStore?.getTemplate(entry.session.templateId)?.codexAppServerModel || result.thread.model || entry.session.codexAppServerModel || entry.session.codexModel || null;
    entry.effort = compatibleEffort(entry, sessionStore?.getTemplate(entry.session.templateId)?.codexAppServerEffort || entry.session.codexAppServerEffort);
    entry.tokenUsage = null; entry.tokenUpdatedAt = null;
    entry.usageNeedsBaseline = false;
    entry.turnOutputBaseline = 0; entry.turnOutputTokens = 0;
    entry.outputTokensPerSecond = 0; entry.outputRateAvailable = false;
    entry.mode = "default";
    entry.pendingPlan = null;
    entry.items = [];
    entry.error = null;
    entry.approvals.clear();
    entry.questions.clear();
    entry.allowedFiles.clear();
    entry.activitySummary = "";
    entry.status = "cleared";
    broadcastStatus(id, entry, true);
    if (previousThreadId) void request(entry, "thread/unsubscribe", { threadId: previousThreadId }).catch(() => {});
    publish(id);
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
  function setExecutionPermission(id, permission) {
    const entry = ready(id);
    if (!Object.hasOwn(EXECUTION_PERMISSIONS, permission)) throw new Error("无效的 Codex 执行权限。");
    const templateId = entry.session.templateId;
    const template = templateId && sessionStore?.getTemplate(templateId);
    if (template) sessionStore.setCodexExecutionPermission(templateId, permission);
    for (const [sessionId, current] of sessions) {
      if (sessionId !== id && (!template || current.session.templateId !== templateId)) continue;
      current.executionPermission = permission;
      publish(sessionId);
    }
    return snapshot(id);
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
  async function submit(id, text, filePaths = []) {
    const entry = sessions.get(id);
    if (!entry?.threadId || entry.uploading || typeof text !== "string" || !Array.isArray(filePaths) || filePaths.length > 10
      || (!text.trim() && filePaths.length === 0)) throw new Error("Codex 会话未就绪或正在运行。");
    if (entry.busy && !entry.turnId) throw new Error("当前回合尚未就绪，请稍后重试。");
    if (filePaths.some(filePath => !entry.allowedFiles.has(filePath))) throw new Error("只能发送通过文件选择器附加的文件。");
    entry.uploading = true;
    const uploaded = [];
    let files;
    try { files = await prepareRemoteFiles(entry, filePaths.map(filePath => fileInput(entry, filePath)), uploaded); }
    catch (error) { entry.uploading = false; await removeUploadedFiles(entry, uploaded); throw error; }
    let turnRequestSent = false;
    let startingTurn = false;
    try {
      if (sessions.get(id) !== entry) throw new Error("会话已关闭。");
      const fileReferences = files.filter(file => !file.image).map(file => JSON.stringify(file.path));
      const messageText = [text.trim(), ...(fileReferences.length ? [`请读取以下附件文件：${fileReferences.join("、")}`] : [])].filter(Boolean).join("\n\n");
      if (!entry.busy && !entry.model) {
        const models = await request(entry, "model/list", {});
        entry.model = models.data?.find(model => model.isDefault)?.id || models.data?.[0]?.id;
        entry.effort = compatibleEffort(entry);
      }
      if (!entry.busy && !entry.model) throw new Error("无法确定 Codex 模型，不能切换协作模式。");
      entry.error = null;
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
        attachments: files.map(file => ({ path: file.path, name: path.basename(file.path) })) });
      publish(id);
      if (startingTurn || (!entry.approvals.size && !entry.questions.size)) entry.status = "running";
      entry.activitySummary = activitySummary(text.trim() || entry.items.at(-1).text);
      broadcastStatus(id, entry, true);
      try {
        const input = [...(messageText ? [{ type: "text", text: messageText }] : []),
          ...files.filter(file => file.image).map(file => ({ type: "localImage", path: file.path }))];
        turnRequestSent = true;
        let result;
        if (startingTurn) {
          const permission = entry.mode === "plan" ? EXECUTION_PERMISSIONS.readOnly : EXECUTION_PERMISSIONS[entry.executionPermission];
          const sandboxPolicy = permission.sandboxPolicy.type === "workspaceWrite"
            ? { ...permission.sandboxPolicy, writableRoots: [projectCwd(entry)] } : permission.sandboxPolicy;
          result = await request(entry, "turn/start", { threadId: entry.threadId, input, model: entry.model,
            ...(entry.effort ? { effort: entry.effort } : {}),
            approvalPolicy: permission.approvalPolicy, sandboxPolicy,
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
  function shutdown() { for (const id of sessions.keys()) close(id); }
  return { start, restart, snapshot, getWorkspaceCwd, resetUsageBaselines, allowFiles, previewAttachment, allowPastedImage, discardPastedImage, listHistory, resume, newThread, setMode, setModel, setEffort, setFastMode, setExecutionPermission, dismissPlan, executePlan, submit, interrupt, resolveApproval, answerQuestion, close, shutdown };
}

module.exports = { createCodexAppServerSessionService, buildInvocation };
