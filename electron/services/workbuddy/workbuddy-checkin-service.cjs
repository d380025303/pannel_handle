const { getWorkBuddyInvocation, terminateProcessTree, createWorkBuddyAcpTransport } = require("./workbuddy-acp-transport.cjs");
const { WorkBuddyCheckinError, createCheckinError } = require("./checkin-error.cjs");
const { request: defaultHttpsRequest } = require("node:https");
const { runCodeBuddyUserInfoRequest } = require("./codebuddy-user-info-client.cjs");

const WORKBUDDY_HOST = "copilot.tencent.com";
const WORKBUDDY_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const WORKBUDDY_CLAIM_PATH = "/v2/billing/meter/daily-checkin";
const DEFAULT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

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
      finish(createCheckinError("WorkBuddy check-in request timed out.", { code: "timeout" }));
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
          finish(createCheckinError("WorkBuddy check-in response exceeded the allowed size.", {
            code: "response-too-large",
            retryable: false
          }));
          return;
        }
        output += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
      });
      response.on("end", () => {
        if (settled) return;
        if (response.statusCode === 401 || response.statusCode === 403) {
          finish(createCheckinError("WorkBuddy login has expired. Please sign in to WorkBuddy again.", {
            code: "login-expired",
            retryable: false
          }));
          return;
        }
        if (response.statusCode !== 200) {
          const statusCode = response.statusCode || 0;
          finish(createCheckinError(`WorkBuddy check-in service returned HTTP ${statusCode}.`, {
            code: "http-error",
            retryable: statusCode >= 500 || statusCode === 0
          }));
          return;
        }
        try {
          finish(undefined, JSON.parse(output));
        } catch {
          finish(createCheckinError("WorkBuddy returned an invalid check-in response.", {
            code: "invalid-response",
            retryable: true
          }));
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
    const rejected = result?.code !== 0;
    throw createCheckinError(message, {
      code: rejected ? "status-rejected" : "invalid-response",
      retryable: !rejected
    });
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
  throw createCheckinError(message, { code: "claim-rejected", retryable: false });
}

function createWorkBuddyCheckinService({
  transportFactory = () => createWorkBuddyAcpTransport(),
  httpsRequest = defaultHttpsRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  let claimInFlight = null;

  async function getCredentials() {
    try {
      const transport = transportFactory();
      return await runCodeBuddyUserInfoRequest(transport, { timeoutMs, maxOutputBytes });
    } catch (error) {
      if (error instanceof WorkBuddyCheckinError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const loginUnavailable = /login|sign in|unauthori[sz]ed|credential/i.test(message);
      throw createCheckinError(message, {
        code: loginUnavailable ? "login-expired" : "credentials-unavailable",
        retryable: !loginUnavailable
      });
    }
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

  async function performClaim() {
    const credentials = await getCredentials();
    const current = await requestStatus(credentials);
    if (current.todayCheckedIn) {
      return { alreadyCheckedIn: true, status: current };
    }
    if (!current.active) {
      throw createCheckinError("The WorkBuddy daily check-in activity is not active.", {
        code: "activity-inactive",
        retryable: false
      });
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

  function claim() {
    if (!claimInFlight) {
      claimInFlight = performClaim().finally(() => {
        claimInFlight = null;
      });
    }
    return claimInFlight;
  }

  return { getStatus, claim };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  WorkBuddyCheckinError,
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
