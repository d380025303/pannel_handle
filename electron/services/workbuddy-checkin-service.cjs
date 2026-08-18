const fs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { request: defaultHttpsRequest } = require("node:https");
const { runCodeBuddyUserInfoRequest } = require("./codebuddy-usage-client.cjs");

const WORKBUDDY_HOST = "copilot.tencent.com";
const WORKBUDDY_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const WORKBUDDY_CLAIM_PATH = "/v2/billing/meter/daily-checkin";
const DEFAULT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function getWorkBuddyInvocation({
  localAppData = process.env.LOCALAPPDATA,
  existsSync = fs.existsSync
} = {}) {
  if (!localAppData) {
    throw new Error("WorkBuddy installation could not be located.");
  }
  const installRoot = path.join(localAppData, "Programs", "WorkBuddy");
  const command = path.join(installRoot, "WorkBuddy.exe");
  const cliScript = path.join(installRoot, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  if (!existsSync(command) || !existsSync(cliScript)) {
    throw new Error("WorkBuddy is not installed in the current Windows account.");
  }
  return {
    command,
    args: [cliScript, "--acp"]
  };
}

function terminateProcessTree(child, spawnSync = defaultSpawnSync) {
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

function createWorkBuddyAcpTransport({
  spawn = defaultSpawn,
  spawnSync = defaultSpawnSync,
  invocation = getWorkBuddyInvocation(),
  environment = process.env
} = {}) {
  const child = spawn(invocation.command, invocation.args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" }
  });
  const events = new EventEmitter();
  let closed = false;

  child.stdout?.on("data", data => events.emit("stdout", data));
  child.stderr?.on("data", data => events.emit("stderr", data));
  child.once("error", error => events.emit("error", error));
  child.once("exit", (code, signal) => events.emit("close", code, signal));

  return {
    on: (eventName, listener) => events.on(eventName, listener),
    write(data) {
      if (!closed && child.stdin?.writable) child.stdin.write(data);
    },
    close() {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(); } catch { /* best effort */ }
      terminateProcessTree(child, spawnSync);
    }
  };
}

function requestWorkBuddyJson({
  path: requestPath,
  token,
  userId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  httpsRequest = defaultHttpsRequest
}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from("{}");
    let settled = false;
    let output = "";
    let outputBytes = 0;
    let request;
    const timer = setTimeout(() => {
      request?.destroy();
      finish(new Error("WorkBuddy check-in request timed out."));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }

    request = httpsRequest({
      hostname: WORKBUDDY_HOST,
      path: requestPath,
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": body.length,
        "x-user-id": userId
      }
    }, response => {
      response.on("data", chunk => {
        if (settled) return;
        outputBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk || ""));
        if (outputBytes > maxOutputBytes) {
          request.destroy();
          finish(new Error("WorkBuddy check-in response exceeded the allowed size."));
          return;
        }
        output += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
      });
      response.on("end", () => {
        if (settled) return;
        if (response.statusCode === 401 || response.statusCode === 403) {
          finish(new Error("WorkBuddy login has expired. Please sign in to WorkBuddy again."));
          return;
        }
        if (response.statusCode !== 200) {
          finish(new Error(`WorkBuddy check-in service returned HTTP ${response.statusCode || 0}.`));
          return;
        }
        try {
          finish(undefined, JSON.parse(output));
        } catch {
          finish(new Error("WorkBuddy returned an invalid check-in response."));
        }
      });
    });
    request.on("error", error => finish(error));
    request.end(body);
  });
}

function normalizeWorkBuddyCheckinStatus(result) {
  if (result?.code !== 0 || !result?.data || typeof result.data !== "object") {
    const message = typeof result?.msg === "string" && result.msg.trim()
      ? result.msg.trim()
      : "WorkBuddy rejected the check-in status request.";
    throw new Error(message);
  }
  const data = result.data;
  const weekProgress = Array.isArray(data.week_progress)
    ? data.week_progress.slice(0, 7).map(Boolean)
    : [];
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: Math.max(0, Number(data.streak_days) || 0),
    dailyCredit: Math.max(0, Number(data.daily_credit) || 0),
    todayCredit: Math.max(0, Number(data.today_credit) || 0),
    totalCredits: Math.max(0, Number(data.total_credits) || 0),
    weekProgress
  };
}

function assertClaimSucceeded(result) {
  if (result?.code === 0) return;
  const message = typeof result?.msg === "string" && result.msg.trim()
    ? result.msg.trim()
    : "WorkBuddy rejected the daily check-in request.";
  throw new Error(message);
}

function createWorkBuddyCheckinService({
  transportFactory = () => createWorkBuddyAcpTransport(),
  httpsRequest = defaultHttpsRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  async function getCredentials() {
    const transport = transportFactory();
    return runCodeBuddyUserInfoRequest(transport, { timeoutMs, maxOutputBytes });
  }

  async function requestStatus(credentials) {
    const result = await requestWorkBuddyJson({
      path: WORKBUDDY_STATUS_PATH,
      ...credentials,
      timeoutMs,
      maxOutputBytes,
      httpsRequest
    });
    return normalizeWorkBuddyCheckinStatus(result);
  }

  async function getStatus() {
    return requestStatus(await getCredentials());
  }

  async function claim() {
    const credentials = await getCredentials();
    const current = await requestStatus(credentials);
    if (current.todayCheckedIn) {
      return { alreadyCheckedIn: true, status: current };
    }
    if (!current.active) {
      throw new Error("The WorkBuddy daily check-in activity is not active.");
    }
    const result = await requestWorkBuddyJson({
      path: WORKBUDDY_CLAIM_PATH,
      ...credentials,
      timeoutMs,
      maxOutputBytes,
      httpsRequest
    });
    assertClaimSucceeded(result);
    return {
      alreadyCheckedIn: false,
      status: await requestStatus(credentials)
    };
  }

  return { getStatus, claim };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  WORKBUDDY_CLAIM_PATH,
  WORKBUDDY_HOST,
  WORKBUDDY_STATUS_PATH,
  createWorkBuddyAcpTransport,
  createWorkBuddyCheckinService,
  getWorkBuddyInvocation,
  normalizeWorkBuddyCheckinStatus,
  requestWorkBuddyJson,
  terminateProcessTree
};
