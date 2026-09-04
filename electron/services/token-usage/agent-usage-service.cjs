const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { readCodeBuddyUsage } = require("../codebuddy-usage-client.cjs");
const { QODER_CACHE_TTL_MS, readQoderUsage } = require("./qoder-usage-client.cjs");
const { GEMINI_CACHE_TTL_MS, readGeminiUsage } = require("./gemini-usage-client.cjs");
const { readMiniMaxUsage } = require("./minimax-usage-client.cjs");

const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const CODEBUDDY_CACHE_TTL_MS = 30 * 1000;
const MINIMAX_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
const INITIALIZE_REQUEST_ID = "pannel-handle-initialize";
const RATE_LIMITS_REQUEST_ID = "pannel-handle-rate-limits";
const RESET_CREDIT_REQUEST_ID = "pannel-handle-reset-credit";
const RESET_CREDIT_OUTCOMES = new Set(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]);

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeResetCreditTimestamp(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

function normalizeResetCreditText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function normalizeRateLimitResetCredits(value) {
  if (!value || typeof value !== "object") return undefined;
  const availableCount = Number(value.availableCount);
  if (!Number.isFinite(availableCount) || availableCount < 0) return undefined;

  const summary = { availableCount: Math.floor(availableCount) };
  if (!Array.isArray(value.credits)) return summary;

  summary.credits = value.credits.flatMap((credit) => {
    if (!credit || typeof credit !== "object") return [];
    const id = normalizeResetCreditText(credit.id);
    const grantedAt = normalizeResetCreditTimestamp(credit.grantedAt);
    if (!id || !grantedAt) return [];

    const status = ["available", "redeeming", "redeemed", "unknown"].includes(credit.status)
      ? credit.status
      : "unknown";
    const resetType = credit.resetType === "codexRateLimits" ? "codexRateLimits" : "unknown";
    const title = normalizeResetCreditText(credit.title);
    const description = normalizeResetCreditText(credit.description);
    const expiresAt = normalizeResetCreditTimestamp(credit.expiresAt);
    return [{
      id,
      status,
      resetType,
      grantedAt,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(expiresAt ? { expiresAt } : {})
    }];
  });
  return summary;
}

function normalizeRateLimitResponse(result, fetchedAt = Date.now()) {
  const fallback = result?.rateLimits && typeof result.rateLimits === "object"
    ? result.rateLimits
    : null;
  const byLimitId = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object"
    ? result.rateLimitsByLimitId
    : null;
  const primaryLimitId = String(fallback?.limitId || "codex");
  const snapshots = new Map();

  if (byLimitId) {
    for (const [key, snapshot] of Object.entries(byLimitId)) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const id = String(snapshot.limitId || key || "").trim();
      if (id) snapshots.set(id, snapshot);
    }
  }
  if (fallback) {
    snapshots.set(primaryLimitId, fallback);
  }

  const limits = [];
  for (const [id, snapshot] of snapshots) {
    const used = Number(snapshot.primary?.usedPercent);
    if (!Number.isFinite(used)) continue;
    const usedPercent = clampPercent(used);
    const windowDurationMins = Number(snapshot.primary?.windowDurationMins);
    const resetsAtSeconds = Number(snapshot.primary?.resetsAt);
    limits.push({
      id,
      name: String(snapshot.limitName || (id === primaryLimitId ? "Codex" : id)),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      ...(Number.isFinite(windowDurationMins) && windowDurationMins > 0
        ? { windowDurationMins: Math.round(windowDurationMins) }
        : {}),
      ...(Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0
        ? { resetsAt: Math.round(resetsAtSeconds * 1000) }
        : {})
    });
  }

  limits.sort((left, right) => {
    if (left.id === primaryLimitId) return -1;
    if (right.id === primaryLimitId) return 1;
    return left.name.localeCompare(right.name);
  });
  if (limits.length === 0) {
    throw new Error("Codex did not return a usable rate-limit window.");
  }

  const resetCredits = normalizeRateLimitResetCredits(result?.rateLimitResetCredits);
  return {
    provider: "codex",
    fetchedAt,
    primaryLimitId: limits.some(limit => limit.id === primaryLimitId) ? primaryLimitId : limits[0].id,
    limits,
    ...(resetCredits ? { resetCredits } : {})
  };
}

function getProcessInvocation(session) {
  if (session.type === "windows") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "codex app-server --stdio"]
    };
  }
  if (session.type === "wsl") {
    const distro = String(session.wslDistro || "").trim();
    if (!distro) throw new Error("A WSL distribution is required to read Codex usage.");
    return {
      command: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-lic", "exec codex app-server --stdio"]
    };
  }
  throw new Error(`Unsupported local Codex session type: ${session.type}.`);
}

function createProcessTransport(session, spawn = defaultSpawn) {
  const invocation = getProcessInvocation(session);
  const child = spawn(invocation.command, invocation.args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events = new EventEmitter();
  let closed = false;

  child.stdout?.on("data", data => events.emit("stdout", data));
  child.stderr?.on("data", data => events.emit("stderr", data));
  child.once("error", error => events.emit("error", error));
  child.once("exit", (code, signal) => events.emit("close", code, signal));

  return {
    invocation,
    on: (eventName, listener) => events.on(eventName, listener),
    write(data) {
      if (!closed && child.stdin?.writable) child.stdin.write(data);
    },
    close() {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(); } catch { /* best effort */ }
      try { child.kill(); } catch { /* best effort */ }
    }
  };
}

function terminateWindowsProcessTree(child, spawnSync = defaultSpawnSync) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  try {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
  } catch {
    try { child.kill(); } catch { /* best effort */ }
  }
}

function createCodeBuddyProcessTransport(session, spawn = defaultSpawn, terminateProcessTree = terminateWindowsProcessTree) {
  if (session.type !== "windows") {
    throw new Error(`Unsupported CodeBuddy session type: ${session.type}.`);
  }
  const invocation = {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "codebuddy --acp"]
  };
  const child = spawn(invocation.command, invocation.args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events = new EventEmitter();
  let closed = false;

  child.stdout?.on("data", data => events.emit("stdout", data));
  child.stderr?.on("data", data => events.emit("stderr", data));
  child.once("error", error => events.emit("error", error));
  child.once("exit", (code, signal) => events.emit("close", code, signal));

  return {
    invocation,
    on: (eventName, listener) => events.on(eventName, listener),
    write(data) {
      if (!closed && child.stdin?.writable) child.stdin.write(data);
    },
    close() {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(); } catch { /* best effort */ }
      terminateProcessTree(child);
    }
  };
}

function appendLimited(current, chunk, maxBytes) {
  const next = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
  const remaining = maxBytes - Buffer.byteLength(current, "utf-8");
  if (remaining <= 0) return current;
  return current + Buffer.from(next, "utf-8").subarray(0, remaining).toString("utf-8");
}

function getProtocolError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error?.message) return String(error.message);
  return fallback;
}

function runCodexAppServerRequest(transport, {
  requestId,
  method,
  params,
  timeoutMessage,
  emptyMessage,
  protocolErrorMessage,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let outputBytes = 0;
    let requestSent = false;

    const timer = setTimeout(() => {
      finish(new Error(timeoutMessage));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.close();
      if (error) reject(error); else resolve(result);
    }

    function handleMessage(message) {
      if (message?.id === INITIALIZE_REQUEST_ID) {
        if (message.error) {
          finish(new Error(getProtocolError(message.error, "Codex App Server initialization failed.")));
          return;
        }
        if (!message.result || requestSent) return;
        requestSent = true;
        transport.write(`${JSON.stringify({ id: requestId, method, ...(params ? { params } : {}) })}\n`);
        return;
      }
      if (message?.id === requestId) {
        if (message.error) {
          finish(new Error(getProtocolError(message.error, protocolErrorMessage)));
          return;
        }
        if (!message.result) {
          finish(new Error(emptyMessage));
          return;
        }
        finish(undefined, message.result);
      }
    }

    transport.on("stdout", chunk => {
      if (settled) return;
      outputBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk || ""));
      if (outputBytes > maxOutputBytes) {
        finish(new Error("Codex usage response exceeded the allowed size."));
        return;
      }
      stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          finish(new Error("Codex returned an invalid App Server response."));
          return;
        }
      }
    });
    transport.on("stderr", chunk => {
      stderr = appendLimited(stderr, chunk, STDERR_LIMIT_BYTES);
    });
    transport.on("error", error => finish(error));
    transport.on("close", (code) => {
      const detail = stderr.trim();
      finish(new Error(detail || `Codex App Server exited before returning usage${Number.isInteger(code) ? ` (code ${code})` : ""}.`));
    });

    transport.write(`${JSON.stringify({
      id: INITIALIZE_REQUEST_ID,
      method: "initialize",
      params: {
        clientInfo: {
          name: "pannel-handle",
          title: "Pannel Handle",
          version: "0.1.0"
        }
      }
    })}\n`);
  });
}

function runCodexRateLimitRequest(transport, options = {}) {
  return runCodexAppServerRequest(transport, {
    requestId: RATE_LIMITS_REQUEST_ID,
    method: "account/rateLimits/read",
    timeoutMessage: "Reading Codex usage timed out.",
    emptyMessage: "Codex returned an empty usage response.",
    protocolErrorMessage: "Codex usage is unavailable.",
    ...options
  });
}

async function runCodexResetCreditRequest(transport, { creditId, idempotencyKey, ...options }) {
  const result = await runCodexAppServerRequest(transport, {
    requestId: RESET_CREDIT_REQUEST_ID,
    method: "account/rateLimitResetCredit/consume",
    params: { creditId, idempotencyKey },
    timeoutMessage: "Resetting Codex usage timed out.",
    emptyMessage: "Codex returned an empty reset response.",
    protocolErrorMessage: "Codex usage reset is unavailable.",
    ...options
  });
  if (!RESET_CREDIT_OUTCOMES.has(result.outcome)) {
    throw new Error("Codex returned an invalid reset outcome.");
  }
  return result.outcome;
}

function getCacheKey(session) {
  const provider = session.agentProvider === "codex" && session.codexBackend === "codebuddy"
    ? "codebuddy"
    : session.agentProvider === "codex" && session.codexBackend === "minimax"
      ? "minimax"
      : session.agentProvider || "unknown";
  if (session.type === "windows" || isLocalSshBridge(session)) return `${provider}:windows`;
  if (session.type === "wsl") return `${provider}:wsl:${String(session.wslDistro || "").trim()}`;
  return `${provider}:ssh:${session.id}`;
}

function isLocalSshBridge(session) {
  return session?.type === "ssh" && session.agentLocation === "local";
}

function isCodeBuddyQuotaSession(session) {
  return session?.agentProvider === "codebuddy" || (session?.agentProvider === "codex" && session?.codexBackend === "codebuddy");
}

function createAgentUsageService({
  terminalManager,
  sshAgentTransport,
  spawn = defaultSpawn,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  transportFactory,
  httpsRequest,
  qoderSdkLoader,
  qoderSpawn,
  qoderTerminateProcessTree,
  geminiSpawn,
  geminiHelperFile,
  miniMaxConfigStore,
  miniMaxFetch
}) {
  const cache = new Map();
  const pending = new Map();
  const activeRequests = new Map();
  const activeRedemptions = new Map();
  const pendingRedemptions = new Map();
  const cacheKeysBySessionId = new Map();
  const cacheVersions = new Map();

  async function createTransport(session) {
    if (transportFactory) return transportFactory(session);
    if (isCodeBuddyQuotaSession(session)) return createCodeBuddyProcessTransport({ ...session, type: "windows" }, spawn);
    if (session.type === "ssh" && !isLocalSshBridge(session)) {
      return sshAgentTransport.createStdioTransport(session.id, {
        actionName: "Codex usage connection",
        timeoutMs
      });
    }
    const runtimeSession = isLocalSshBridge(session) ? { ...session, type: "windows" } : session;
    return createProcessTransport(runtimeSession, spawn);
  }

  async function readUsage(session) {
    const startedAt = Date.now();
    let transport;
    let canceled = false;
    const abortController = new AbortController();
    const request = {
      cancel() {
        canceled = true;
        abortController.abort();
        transport?.close();
      }
    };
    activeRequests.set(session.id, request);
    try {
      if (session.agentProvider === "qoder") {
        return await readQoderUsage({
          session,
          signal: abortController.signal,
          timeoutMs,
          now,
          sdkLoader: qoderSdkLoader,
          spawn: qoderSpawn,
          terminateProcessTree: qoderTerminateProcessTree
        });
      }
      if (session.agentProvider === "gemini") {
        return await readGeminiUsage({
          session,
          signal: abortController.signal,
          timeoutMs,
          now,
          spawn: geminiSpawn || spawn,
          ...(geminiHelperFile ? { helperFile: geminiHelperFile } : {})
        });
      }
      if (session.agentProvider === "codex" && session.codexBackend === "minimax") {
        if (!miniMaxConfigStore?.getApiKey) throw new Error("MiniMax 配置服务不可用。");
        return await readMiniMaxUsage({
          apiKey: miniMaxConfigStore.getApiKey(),
          signal: abortController.signal,
          timeoutMs,
          now,
          fetchImpl: miniMaxFetch || globalThis.fetch
        });
      }
      transport = await createTransport(session);
      if (canceled) {
        transport.close();
        throw new Error("Codex usage request was canceled.");
      }
      const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
      if (remainingTimeoutMs <= 0) {
        transport.close();
        throw new Error(`Reading ${isCodeBuddyQuotaSession(session) ? "CodeBuddy quota" : "Codex usage"} timed out.`);
      }
      if (isCodeBuddyQuotaSession(session)) {
        return await readCodeBuddyUsage({
          transport,
          signal: abortController.signal,
          timeoutMs: remainingTimeoutMs,
          maxOutputBytes,
          httpsRequest,
          now
        });
      }
      const result = await runCodexRateLimitRequest(transport, {
        timeoutMs: remainingTimeoutMs,
        maxOutputBytes
      });
      return normalizeRateLimitResponse(result, now());
    } finally {
      if (activeRequests.get(session.id) === request) activeRequests.delete(session.id);
    }
  }

  function getUsage(sessionId, options = {}) {
    const session = terminalManager.getSession(sessionId);
    if (!session) return Promise.reject(new Error("Session is not running."));
    if (session.agentProvider === "codex" && (session.codexBackend === "openrouter" || session.codexBackend === "nararouter")) {
      return Promise.reject(new Error(`${session.codexBackend === "nararouter" ? "NaraRouter" : "OpenRouter"} sessions do not use ChatGPT Codex rate limits.`));
    }
    if (!["codex", "codebuddy", "qoder", "gemini"].includes(session.agentProvider)) {
      return Promise.reject(new Error("Usage is only available for Codex, CodeBuddy, Qoder, and Gemini sessions."));
    }
    if (session.agentProvider === "codebuddy" && session.type !== "windows" && !isLocalSshBridge(session)) {
      return Promise.reject(new Error("CodeBuddy quota is only available for Windows sessions."));
    }
    if (session.agentProvider === "qoder" && session.type !== "windows" && session.type !== "wsl") {
      return Promise.reject(new Error("Qoder quota is only available for Windows and WSL sessions."));
    }
    if (session.agentProvider === "gemini" && session.type !== "windows" && session.type !== "wsl") {
      return Promise.reject(new Error("Gemini quota is only available for Windows and WSL sessions."));
    }

    const key = getCacheKey(session);
    cacheKeysBySessionId.set(session.id, key);
    const cached = cache.get(key);
    const effectiveCacheTtlMs = isCodeBuddyQuotaSession(session)
      ? Math.min(cacheTtlMs, CODEBUDDY_CACHE_TTL_MS)
      : session.agentProvider === "codex" && session.codexBackend === "minimax"
        ? Math.min(cacheTtlMs, MINIMAX_CACHE_TTL_MS)
      : session.agentProvider === "qoder"
        ? Math.min(cacheTtlMs, QODER_CACHE_TTL_MS)
        : session.agentProvider === "gemini"
          ? (cacheTtlMs === DEFAULT_CACHE_TTL_MS ? GEMINI_CACHE_TTL_MS : cacheTtlMs)
        : cacheTtlMs;
    if (!options.force && cached && now() - cached.fetchedAt < effectiveCacheTtlMs) {
      return Promise.resolve(cached.snapshot);
    }
    if (pending.has(key)) return pending.get(key);

    const cacheVersion = cacheVersions.get(key) || 0;
    const promise = readUsage(session)
      .then(snapshot => {
        if ((cacheVersions.get(key) || 0) === cacheVersion) {
          cache.set(key, { fetchedAt: now(), snapshot });
        }
        return snapshot;
      })
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  }

  function consumeResetCredit(sessionId, options = {}) {
    const session = terminalManager.getSession(sessionId);
    if (!session) return Promise.reject(new Error("Session is not running."));
    if (session.agentProvider !== "codex") {
      return Promise.reject(new Error("Usage resets are only available for Codex sessions."));
    }
    const creditId = String(options.creditId || "").trim();
    const idempotencyKey = String(options.idempotencyKey || "").trim();
    if (!creditId) return Promise.reject(new Error("A reset credit ID is required."));
    if (!idempotencyKey) return Promise.reject(new Error("An idempotency key is required."));

    const redemptionKey = `${session.id}:${creditId}:${idempotencyKey}`;
    if (pendingRedemptions.has(redemptionKey)) return pendingRedemptions.get(redemptionKey);

    const promise = (async () => {
      let transport;
      let canceled = false;
      const request = {
        cancel() {
          canceled = true;
          transport?.close();
        }
      };
      activeRedemptions.set(redemptionKey, request);
      try {
        transport = await createTransport(session);
        if (canceled) {
          transport.close();
          throw new Error("Codex usage reset was canceled.");
        }
        const outcome = await runCodexResetCreditRequest(transport, {
          creditId,
          idempotencyKey,
          timeoutMs,
          maxOutputBytes
        });
        const key = getCacheKey(session);
        cacheKeysBySessionId.set(session.id, key);
        cacheVersions.set(key, (cacheVersions.get(key) || 0) + 1);
        cache.delete(key);
        pending.delete(key);

        try {
          const snapshot = await readUsage(session);
          cache.set(key, { fetchedAt: now(), snapshot });
          return { outcome, snapshot };
        } catch (error) {
          return {
            outcome,
            refreshError: error instanceof Error ? error.message : String(error)
          };
        }
      } finally {
        activeRedemptions.delete(redemptionKey);
      }
    })().finally(() => {
      if (pendingRedemptions.get(redemptionKey) === promise) pendingRedemptions.delete(redemptionKey);
    });
    pendingRedemptions.set(redemptionKey, promise);
    return promise;
  }

  function disconnect(sessionId) {
    activeRequests.get(sessionId)?.cancel();
    activeRequests.delete(sessionId);
    for (const [key, request] of activeRedemptions) {
      if (key.startsWith(`${sessionId}:`)) request.cancel();
    }
    const key = cacheKeysBySessionId.get(sessionId);
    cacheKeysBySessionId.delete(sessionId);
    if (key) {
      pending.delete(key);
      if (key.includes(":ssh:")) cache.delete(key);
    }
  }

  function shutdown() {
    for (const request of activeRequests.values()) request.cancel();
    activeRequests.clear();
    for (const request of activeRedemptions.values()) request.cancel();
    activeRedemptions.clear();
    pending.clear();
    pendingRedemptions.clear();
    cache.clear();
    cacheVersions.clear();
    cacheKeysBySessionId.clear();
  }

  return { consumeResetCredit, disconnect, getUsage, shutdown };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  CODEBUDDY_CACHE_TTL_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createAgentUsageService,
  createCodeBuddyProcessTransport,
  createProcessTransport,
  getProcessInvocation,
  normalizeRateLimitResetCredits,
  normalizeRateLimitResponse,
  runCodexAppServerRequest,
  runCodexRateLimitRequest,
  runCodexResetCreditRequest,
  terminateWindowsProcessTree
};
