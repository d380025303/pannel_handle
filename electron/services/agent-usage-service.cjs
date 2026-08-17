const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { readCodeBuddyUsage } = require("./codebuddy-usage-client.cjs");

const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const CODEBUDDY_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
const INITIALIZE_REQUEST_ID = "pannel-handle-initialize";
const RATE_LIMITS_REQUEST_ID = "pannel-handle-rate-limits";

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
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

  return {
    provider: "codex",
    fetchedAt,
    primaryLimitId: limits.some(limit => limit.id === primaryLimitId) ? primaryLimitId : limits[0].id,
    limits
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

async function createSshTransport(session, sshSessionRuntime, options = {}) {
  if (!sshSessionRuntime) throw new Error("SSH runtime is unavailable.");
  const client = await sshSessionRuntime.connectClient(session.id, {
    actionName: "Codex usage connection",
    timeoutMs: options.timeoutMs
  });

  return new Promise((resolve, reject) => {
    client.exec("bash -lic 'exec codex app-server --stdio'", (error, stream) => {
      if (error) {
        try { client.end(); } catch { /* best effort */ }
        reject(error);
        return;
      }

      const events = new EventEmitter();
      let closed = false;
      stream.on("data", data => events.emit("stdout", data));
      stream.stderr?.on("data", data => events.emit("stderr", data));
      stream.once("error", streamError => events.emit("error", streamError));
      stream.once("close", (code, signal) => events.emit("close", code, signal));

      resolve({
        invocation: { command: "ssh", args: ["bash", "-lic", "exec codex app-server --stdio"] },
        on: (eventName, listener) => events.on(eventName, listener),
        write(data) {
          if (!closed && stream.writable) stream.write(data);
        },
        close() {
          if (closed) return;
          closed = true;
          try { stream.end(); } catch { /* best effort */ }
          try { stream.signal?.("TERM"); } catch { /* best effort */ }
          try { client.end(); } catch { /* best effort */ }
        }
      });
    });
  });
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

function runCodexRateLimitRequest(transport, {
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let outputBytes = 0;
    let rateLimitsRequested = false;

    const timer = setTimeout(() => {
      finish(new Error("Reading Codex usage timed out."));
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
        if (!message.result || rateLimitsRequested) return;
        rateLimitsRequested = true;
        transport.write(`${JSON.stringify({
          id: RATE_LIMITS_REQUEST_ID,
          method: "account/rateLimits/read"
        })}\n`);
        return;
      }
      if (message?.id === RATE_LIMITS_REQUEST_ID) {
        if (message.error) {
          finish(new Error(getProtocolError(message.error, "Codex usage is unavailable.")));
          return;
        }
        if (!message.result) {
          finish(new Error("Codex returned an empty usage response."));
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

function getCacheKey(session) {
  const provider = session.agentProvider || "unknown";
  if (session.type === "windows") return `${provider}:windows`;
  if (session.type === "wsl") return `${provider}:wsl:${String(session.wslDistro || "").trim()}`;
  return `${provider}:ssh:${session.id}`;
}

function createAgentUsageService({
  terminalManager,
  sshSessionRuntime,
  spawn = defaultSpawn,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  transportFactory,
  httpsRequest
}) {
  const cache = new Map();
  const pending = new Map();
  const activeRequests = new Map();
  const cacheKeysBySessionId = new Map();

  async function createTransport(session) {
    if (transportFactory) return transportFactory(session);
    if (session.agentProvider === "codebuddy") return createCodeBuddyProcessTransport(session, spawn);
    return session.type === "ssh"
      ? createSshTransport(session, sshSessionRuntime, { timeoutMs })
      : createProcessTransport(session, spawn);
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
      transport = await createTransport(session);
      if (canceled) {
        transport.close();
        throw new Error("Codex usage request was canceled.");
      }
      const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
      if (remainingTimeoutMs <= 0) {
        transport.close();
        throw new Error(`Reading ${session.agentProvider === "codebuddy" ? "CodeBuddy quota" : "Codex usage"} timed out.`);
      }
      if (session.agentProvider === "codebuddy") {
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
    if (session.agentProvider !== "codex" && session.agentProvider !== "codebuddy") {
      return Promise.reject(new Error("Usage is only available for Codex and CodeBuddy sessions."));
    }
    if (session.agentProvider === "codebuddy" && session.type !== "windows") {
      return Promise.reject(new Error("CodeBuddy quota is only available for Windows sessions."));
    }

    const key = getCacheKey(session);
    cacheKeysBySessionId.set(session.id, key);
    const cached = cache.get(key);
    const effectiveCacheTtlMs = session.agentProvider === "codebuddy"
      ? Math.min(cacheTtlMs, CODEBUDDY_CACHE_TTL_MS)
      : cacheTtlMs;
    if (!options.force && cached && now() - cached.fetchedAt < effectiveCacheTtlMs) {
      return Promise.resolve(cached.snapshot);
    }
    if (pending.has(key)) return pending.get(key);

    const promise = readUsage(session)
      .then(snapshot => {
        cache.set(key, { fetchedAt: now(), snapshot });
        return snapshot;
      })
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  }

  function disconnect(sessionId) {
    activeRequests.get(sessionId)?.cancel();
    activeRequests.delete(sessionId);
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
    pending.clear();
    cache.clear();
    cacheKeysBySessionId.clear();
  }

  return { disconnect, getUsage, shutdown };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  CODEBUDDY_CACHE_TTL_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createAgentUsageService,
  createCodeBuddyProcessTransport,
  createProcessTransport,
  createSshTransport,
  getProcessInvocation,
  normalizeRateLimitResponse,
  runCodexRateLimitRequest,
  terminateWindowsProcessTree
};
