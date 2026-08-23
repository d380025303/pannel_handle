const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const path = require("node:path");

const QODER_CACHE_TTL_MS = 30 * 1000;
const QODER_ACTIVITY_OUTPUT_PREFIX = "PANNEL_HANDLE_QODER_ACTIVITY:";
const QODER_ACTIVITY_MAX_OUTPUT_BYTES = 1024 * 1024;
const QODER_SDK_ENV_KEYS = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_VERSION",
  "QODER_SDK_AUTH_PAYLOAD_FILE"
];

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function parseTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  return timestamp < 1_000_000_000_000 ? Math.round(timestamp * 1000) : Math.round(timestamp);
}

function normalizeText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function windowsPathToWsl(value) {
  const path = String(value || "");
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) throw new Error("Qoder SDK authentication path is unavailable to WSL.");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function terminateWindowsProcessTree(child, spawnSync = defaultSpawnSync) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return false;
  try {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    return true;
  } catch {
    try { return child.kill(); } catch { return false; }
  }
}

function wrapSpawnedProcess(child, terminateProcessTree) {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    kill() {
      return terminateProcessTree(child);
    },
    on: (...args) => child.on(...args),
    once: (...args) => child.once(...args),
    off: (...args) => child.off(...args)
  };
}

function createQoderProcessSpawner(session, {
  spawn = defaultSpawn,
  terminateProcessTree = terminateWindowsProcessTree
} = {}) {
  return ({ args, cwd, env, signal }) => {
    let child;
    if (session.type === "windows") {
      child = spawn("cmd.exe", ["/d", "/s", "/c", "qoder", ...args], {
        cwd,
        env,
        signal,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } else if (session.type === "wsl") {
      const distro = String(session.wslDistro || "").trim();
      if (!distro) throw new Error("A WSL distribution is required to read Qoder quota.");
      const forwardedEnv = QODER_SDK_ENV_KEYS.flatMap(key => {
        const value = env[key];
        if (!value) return [];
        return [`${key}=${key === "QODER_SDK_AUTH_PAYLOAD_FILE" ? windowsPathToWsl(value) : value}`];
      });
      child = spawn("wsl.exe", [
        "-d",
        distro,
        "--cd",
        String(cwd || session.cwd || "/"),
        "--",
        "env",
        ...forwardedEnv,
        "bash",
        "-lic",
        "exec qoder \"$@\"",
        "qoder",
        ...args
      ], {
        signal,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } else {
      throw new Error(`Unsupported Qoder session type: ${session.type}.`);
    }
    return wrapSpawnedProcess(child, terminateProcessTree);
  };
}

function normalizeBucket({ id, name, category, source, totalKey = "total", expiresAt, available }) {
  if (!source || typeof source !== "object") return undefined;
  const total = parseAmount(source[totalKey]);
  const used = parseAmount(source.used);
  const remaining = parseAmount(source.remaining);
  if (total === undefined || used === undefined || remaining === undefined) return undefined;
  const normalizedTotal = Math.max(total, used, remaining);
  const normalizedUsed = Math.min(used, normalizedTotal);
  const normalizedRemaining = Math.min(remaining, normalizedTotal);
  const usedPercent = Number.isFinite(Number(source.percentage))
    ? clampPercent(Number(source.percentage))
    : normalizedTotal > 0
      ? clampPercent((normalizedUsed / normalizedTotal) * 100)
      : 100;
  return {
    id,
    name,
    category,
    totalAmount: normalizedTotal,
    usedAmount: normalizedUsed,
    remainingAmount: normalizedRemaining,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    unit: "Credits",
    ...(Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0 ? { expiresAt: Number(expiresAt) } : {}),
    ...(typeof available === "boolean" ? { available } : {})
  };
}

function normalizeQoderUsage(usage, fetchedAt = Date.now()) {
  if (!usage || typeof usage !== "object") {
    throw new Error("Qoder quota is unavailable. Please sign in or update Qoder CLI.");
  }
  const planName = String(usage.userType || "").trim();
  const limits = [
    normalizeBucket({
      id: "qoder-plan",
      name: planName || "Plan Credits",
      category: "base",
      source: usage.userQuota,
      expiresAt: usage.expiresAt
    }),
    normalizeBucket({
      id: "qoder-addon",
      name: "Add-on Credits",
      category: "extra",
      source: usage.addOnQuota
    }),
    normalizeBucket({
      id: "qoder-organization",
      name: "Organization Resource Package",
      category: "organization",
      source: usage.orgResourcePackage,
      totalKey: "cap",
      available: usage.orgResourcePackage?.available
    })
  ].filter(Boolean);
  if (limits.length === 0) {
    throw new Error("Qoder did not return usable account quota.");
  }

  const spendableLimits = limits.filter(limit => limit.available !== false);
  if (spendableLimits.length === 0) {
    throw new Error("Qoder did not return usable available quota.");
  }
  const total = spendableLimits.reduce((sum, limit) => sum + limit.totalAmount, 0);
  const used = spendableLimits.reduce((sum, limit) => sum + limit.usedAmount, 0);
  const remaining = spendableLimits.reduce((sum, limit) => sum + limit.remainingAmount, 0);
  const usedPercent = usage.isQuotaExceeded === true
    ? 100
    : Number.isFinite(Number(usage.totalUsagePercentage))
      ? clampPercent(Number(usage.totalUsagePercentage))
      : total > 0
        ? clampPercent((used / total) * 100)
        : 100;

  return {
    provider: "qoder",
    fetchedAt,
    primaryLimitId: "qoder-total",
    summary: {
      kind: "credits",
      total,
      used,
      remaining,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      unit: "Credits"
    },
    limits
  };
}

function normalizeQoderActivities(value, fetchedAt = Date.now()) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.data?.activities)
      ? value.data.activities
      : Array.isArray(value?.activities)
        ? value.activities
        : [];
  return source.flatMap((activity, index) => {
    if (!activity || typeof activity !== "object" || activity.eligible === false || activity.tagStyle === "EXPIRED") return [];
    const expiresAt = parseTimestamp(activity.activityEndAt);
    if (expiresAt && expiresAt <= fetchedAt) return [];
    const reportedTotal = parseAmount(activity.limit);
    const reportedUsed = parseAmount(activity.used);
    const reportedRemaining = parseAmount(activity.remaining);
    if (reportedTotal === undefined || reportedRemaining === undefined) return [];
    const totalAmount = Math.max(reportedTotal, reportedUsed ?? 0, reportedRemaining);
    const remainingAmount = Math.min(reportedRemaining, totalAmount);
    const usedAmount = Math.min(reportedUsed ?? Math.max(0, totalAmount - remainingAmount), totalAmount);
    const usedPercent = totalAmount > 0 ? clampPercent((usedAmount / totalAmount) * 100) : 100;
    const id = normalizeText(activity.activityId) || `qoder-activity-${index}`;
    const name = normalizeText(activity.modelName)
      || normalizeText(activity.type)
      || normalizeText(activity.statusText)
      || "Qoder Activity";
    return [{
      id,
      name,
      totalAmount,
      usedAmount,
      remainingAmount,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      unit: "calls",
      ...(expiresAt ? { expiresAt } : {}),
      ...(normalizeText(activity.resetStrategy) ? { resetStrategy: normalizeText(activity.resetStrategy) } : {}),
      ...(normalizeText(activity.statusText) ? { statusText: normalizeText(activity.statusText) } : {}),
      ...(normalizeText(activity.tag) ? { tag: normalizeText(activity.tag) } : {}),
      ...(normalizeText(activity.description) ? { description: normalizeText(activity.description) } : {}),
      ...(normalizeText(activity.detailUrl) ? { detailUrl: normalizeText(activity.detailUrl) } : {})
    }];
  });
}

function getQoderActivityHelperLaunch() {
  const args = process.defaultApp
    ? [path.resolve(__dirname, "../../.."), "--pannel-handle-qoder-activity-helper"]
    : ["--pannel-handle-qoder-activity-helper"];
  return { command: process.execPath, args };
}

function readQoderActivities({
  signal,
  spawn = defaultSpawn,
  terminateProcessTree = terminateWindowsProcessTree,
  launch = getQoderActivityHelperLaunch()
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let outputBytes = 0;
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: process.env,
      signal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      terminateProcessTree(child);
      finish(new Error("Qoder activity quota request was canceled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    child.stdout?.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > QODER_ACTIVITY_MAX_OUTPUT_BYTES) {
        terminateProcessTree(child);
        finish(new Error("Qoder activity quota response was too large."));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.once("error", error => finish(error));
    child.once("close", code => {
      if (settled) return;
      if (code !== 0) return finish(new Error("Qoder activity quota is unavailable."));
      const line = stdout.split(/\r?\n/u).find(value => value.startsWith(QODER_ACTIVITY_OUTPUT_PREFIX));
      if (!line) return finish(new Error("Qoder activity quota returned no usable response."));
      try {
        const payload = JSON.parse(line.slice(QODER_ACTIVITY_OUTPUT_PREFIX.length));
        finish(undefined, Array.isArray(payload?.activities) ? payload.activities : []);
      } catch {
        finish(new Error("Qoder activity quota response was invalid."));
      }
    });
  });
}

async function readQoderUsage({
  session,
  signal,
  timeoutMs,
  now = () => Date.now(),
  sdkLoader = () => import("@qoder-ai/qoder-agent-sdk"),
  spawn,
  terminateProcessTree,
  activityReader = readQoderActivities
}) {
  const sdk = await sdkLoader();
  const startedAt = Date.now();
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let releaseInput;
  async function* noPrompt() {
    await new Promise(resolve => { releaseInput = resolve; });
  }

  const query = sdk.query({
    prompt: noPrompt(),
    options: {
      auth: sdk.qodercliAuth(),
      cwd: session.cwd,
      abortController,
      controlRequestTimeoutMs: timeoutMs,
      persistSession: false,
      permissionMode: "dontAsk",
      settingSources: [],
      skills: [],
      tools: [],
      pathToQoderCLIExecutable: "qoder",
      spawnQoderCLIProcess: createQoderProcessSpawner(session, { spawn, terminateProcessTree })
    }
  });

  try {
    await query.initializationResult();
    const usage = await query.getUsageInfo();
    if (abortController.signal.aborted) throw new Error("Reading Qoder quota timed out or was canceled.");
    const fetchedAt = now();
    const snapshot = normalizeQoderUsage(usage, fetchedAt);
    if (session.type !== "windows") return snapshot;
    clearTimeout(timer);
    const activityAbortController = new AbortController();
    const abortActivity = () => activityAbortController.abort();
    signal?.addEventListener("abort", abortActivity, { once: true });
    const remainingTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const activityTimer = setTimeout(abortActivity, remainingTimeoutMs);
    try {
      const activities = normalizeQoderActivities(await activityReader({
        signal: activityAbortController.signal,
        spawn,
        terminateProcessTree
      }), fetchedAt);
      return { ...snapshot, activities };
    } catch {
      if (signal?.aborted) throw new Error("Qoder quota request was canceled.");
      return { ...snapshot, activities: [], activityError: "Qoder activity quota is unavailable." };
    } finally {
      clearTimeout(activityTimer);
      signal?.removeEventListener("abort", abortActivity);
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(signal?.aborted ? "Qoder quota request was canceled." : "Reading Qoder quota timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    releaseInput?.();
    await query.close().catch(() => {});
  }
}

module.exports = {
  QODER_CACHE_TTL_MS,
  createQoderProcessSpawner,
  getQoderActivityHelperLaunch,
  normalizeQoderActivities,
  normalizeQoderUsage,
  readQoderActivities,
  readQoderUsage,
  terminateWindowsProcessTree,
  windowsPathToWsl
};
