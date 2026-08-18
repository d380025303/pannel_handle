const { request: defaultHttpsRequest } = require("node:https");

const CODEBUDDY_ACP_INITIALIZE_ID = "pannel-handle-codebuddy-initialize";
const CODEBUDDY_USER_INFO_ID = "pannel-handle-codebuddy-user-info";
const CODEBUDDY_HOST = "copilot.tencent.com";
const CODEBUDDY_RESOURCE_PATH = "/billing/meter/get-user-resource";
const CODEBUDDY_PRODUCT_CODE = "p_tcaca";
const CODEBUDDY_PACKAGE_GROUPS = {
  base: new Set([
    "TCACA_code_008_cfWoLwvjU4",
    "TCACA_code_002_AkiJS3ZHF5",
    "TCACA_code_023_4xbGhMrE6q",
    "TCACA_code_026_BaESVICNoi",
    "TCACA_code_027_0FCGVA6vSa"
  ]),
  extra: new Set([
    "TCACA_code_009_0XmEQc2xOf",
    "TCACA_code_038_OhvqZtiPKr"
  ]),
  bonus: new Set([
    "TCACA_code_007_nzdH5h4Nl0",
    "TCACA_code_028_NtpWi0jzXs",
    "TCACA_code_029_6wCGEWquYy",
    "TCACA_code_030_BjSt89qTvr"
  ])
};
const CODEBUDDY_PACKAGE_CODES = Object.values(CODEBUDDY_PACKAGE_GROUPS)
  .flatMap(group => [...group]);

function appendLimited(current, chunk, maxBytes) {
  const next = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
  const remaining = maxBytes - Buffer.byteLength(current, "utf-8");
  if (remaining <= 0) return current;
  return current + Buffer.from(next, "utf-8").subarray(0, remaining).toString("utf-8");
}

function getCodeBuddyPackageCategory(packageCode) {
  for (const [category, codes] of Object.entries(CODEBUDDY_PACKAGE_GROUPS)) {
    if (codes.has(packageCode)) return category;
  }
  return "other";
}

function parseAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeCodeBuddyResourceResponse(result, fetchedAt = Date.now()) {
  const accounts = result?.data?.Response?.Data?.Accounts;
  if (!Array.isArray(accounts)) {
    throw new Error("CodeBuddy returned an invalid quota response.");
  }

  const categoryOrder = { base: 0, extra: 1, bonus: 2, other: 3 };
  const allLimits = [];

  for (const account of accounts) {
    if (!account || typeof account !== "object") continue;
    const totalAmount = parseAmount(account.CycleCapacitySizePrecise ?? account.CycleCapacitySize);
    const remainingAmount = parseAmount(account.CycleCapacityRemainPrecise ?? account.CycleCapacityRemain);
    if (totalAmount === null || remainingAmount === null) continue;

    const normalizedTotal = Math.max(totalAmount, remainingAmount);
    const normalizedRemaining = Math.min(remainingAmount, normalizedTotal);
    const usedAmount = Math.max(0, normalizedTotal - normalizedRemaining);
    const usedPercent = normalizedTotal > 0
      ? Math.min(100, Math.max(0, Math.round((usedAmount / normalizedTotal) * 100)))
      : 100;
    const packageCode = String(account.PackageCode || "").trim();
    const category = getCodeBuddyPackageCategory(packageCode);
    const expiresAt = parseTimestamp(account.CycleEndTime)
      ?? parseTimestamp(account.ExpiredTime)
      ?? parseTimestamp(account.DeductionEndTime);

    allLimits.push({
      id: String(account.ResourceId || packageCode || `codebuddy-resource-${allLimits.length + 1}`),
      name: String(account.PackageName || account.DealName || packageCode || "CodeBuddy Credits"),
      usedPercent,
      remainingPercent: 100 - usedPercent,
      category,
      totalAmount: normalizedTotal,
      usedAmount,
      remainingAmount: normalizedRemaining,
      unit: "Credits",
      ...(expiresAt ? { expiresAt } : {})
    });
  }

  if (allLimits.length === 0) {
    throw new Error("CodeBuddy did not return usable quota resources.");
  }

  const limits = allLimits
    .filter(limit => limit.remainingAmount > 0)
    .sort((left, right) => {
      const categoryDifference = categoryOrder[left.category] - categoryOrder[right.category];
      if (categoryDifference !== 0) return categoryDifference;
      const leftExpiry = left.expiresAt ?? Number.MAX_SAFE_INTEGER;
      const rightExpiry = right.expiresAt ?? Number.MAX_SAFE_INTEGER;
      return leftExpiry - rightExpiry || left.name.localeCompare(right.name);
    });
  const total = limits.reduce((sum, limit) => sum + limit.totalAmount, 0);
  const remaining = limits.reduce((sum, limit) => sum + limit.remainingAmount, 0);
  const used = Math.max(0, total - remaining);
  const usedPercent = total > 0
    ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
    : 100;

  return {
    provider: "codebuddy",
    fetchedAt,
    primaryLimitId: "codebuddy-total",
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

function runCodeBuddyUserInfoRequest(transport, {
  timeoutMs,
  maxOutputBytes
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let outputBytes = 0;
    let userInfoRequested = false;
    const timer = setTimeout(() => finish(new Error("Reading CodeBuddy quota timed out.")), timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.close();
      if (error) reject(error); else resolve(result);
    }

    function handleMessage(message) {
      if (message?.id === CODEBUDDY_ACP_INITIALIZE_ID) {
        if (message.error) {
          finish(new Error("CodeBuddy ACP initialization failed."));
          return;
        }
        if (!message.result || userInfoRequested) return;
        userInfoRequested = true;
        transport.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: CODEBUDDY_USER_INFO_ID,
          method: "_codebuddy.ai/getUserInfo",
          params: {}
        })}\n`);
        return;
      }
      if (message?.id !== CODEBUDDY_USER_INFO_ID) return;
      if (message.error) {
        finish(new Error("CodeBuddy login information is unavailable."));
        return;
      }
      const userInfo = message?.result?.userInfo;
      const token = String(userInfo?.token || userInfo?.accessToken || "").trim();
      const userId = String(userInfo?.userId || "").trim();
      if (!token || !userId) {
        finish(new Error("Please sign in to CodeBuddy before reading quota."));
        return;
      }
      finish(undefined, { token, userId });
    }

    transport.on("stdout", chunk => {
      if (settled) return;
      outputBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk || ""));
      if (outputBytes > maxOutputBytes) {
        finish(new Error("CodeBuddy ACP response exceeded the allowed size."));
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
          finish(new Error("CodeBuddy returned an invalid ACP response."));
          return;
        }
      }
    });
    transport.on("stderr", chunk => {
      stderr = appendLimited(stderr, chunk, 64 * 1024);
    });
    transport.on("error", () => finish(new Error("Unable to start CodeBuddy ACP.")));
    transport.on("close", code => {
      const detail = stderr.trim();
      finish(new Error(detail
        ? "CodeBuddy ACP exited before returning login information."
        : `CodeBuddy ACP exited before returning login information${Number.isInteger(code) ? ` (code ${code})` : ""}.`));
    });

    transport.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: CODEBUDDY_ACP_INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "pannel-handle", version: "0.1.0" }
      }
    })}\n`);
  });
}

function requestCodeBuddyResources({
  token,
  userId,
  signal,
  timeoutMs,
  maxOutputBytes,
  httpsRequest = defaultHttpsRequest
}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      PageNumber: 1,
      PageSize: 200,
      ProductCode: CODEBUDDY_PRODUCT_CODE,
      Status: [0, 3],
      OnlyValidPeriod: true,
      PackageCodes: CODEBUDDY_PACKAGE_CODES
    }));
    let settled = false;
    let output = "";
    let outputBytes = 0;
    let request;
    const timer = setTimeout(() => {
      request?.destroy();
      finish(new Error("Reading CodeBuddy quota timed out."));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }

    request = httpsRequest({
      hostname: CODEBUDDY_HOST,
      path: CODEBUDDY_RESOURCE_PATH,
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "content-length": body.length,
        authorization: `Bearer ${token}`,
        "x-user-id": userId
      }
    }, response => {
      response.on("data", chunk => {
        if (settled) return;
        outputBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk || ""));
        if (outputBytes > maxOutputBytes) {
          request.destroy();
          finish(new Error("CodeBuddy quota response exceeded the allowed size."));
          return;
        }
        output += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk || "");
      });
      response.on("end", () => {
        if (settled) return;
        if (response.statusCode !== 200) {
          finish(new Error("CodeBuddy quota service is unavailable."));
          return;
        }
        try {
          const result = JSON.parse(output);
          if (result?.code !== 0) {
            finish(new Error("CodeBuddy quota service rejected the request."));
            return;
          }
          finish(undefined, result);
        } catch {
          finish(new Error("CodeBuddy returned an invalid quota response."));
        }
      });
    });
    request.on("error", error => {
      if (signal?.aborted || error?.name === "AbortError") {
        finish(new Error("CodeBuddy quota request was canceled."));
      } else {
        finish(new Error("Unable to connect to the CodeBuddy quota service."));
      }
    });
    request.end(body);
  });
}

async function readCodeBuddyUsage({
  transport,
  signal,
  timeoutMs,
  maxOutputBytes,
  httpsRequest,
  now = () => Date.now()
}) {
  const startedAt = Date.now();
  const userInfo = await runCodeBuddyUserInfoRequest(transport, { timeoutMs, maxOutputBytes });
  const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
  if (remainingTimeoutMs <= 0) throw new Error("Reading CodeBuddy quota timed out.");
  const result = await requestCodeBuddyResources({
    ...userInfo,
    signal,
    timeoutMs: remainingTimeoutMs,
    maxOutputBytes,
    httpsRequest
  });
  return normalizeCodeBuddyResourceResponse(result, now());
}

module.exports = {
  CODEBUDDY_HOST,
  CODEBUDDY_PACKAGE_CODES,
  CODEBUDDY_RESOURCE_PATH,
  normalizeCodeBuddyResourceResponse,
  readCodeBuddyUsage,
  requestCodeBuddyResources,
  runCodeBuddyUserInfoRequest
};
