const MINIMAX_TOKEN_PLAN_USAGE_URL = "https://www.minimaxi.com/v1/token_plan/remains";
const MINIMAX_ACCOUNT_BALANCE_URL = "https://api.minimaxi.com/account/query_balance";

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value))));
}

function resolveQuotaCounts(reportedCount, total, remainingPercent) {
  const count = Number(reportedCount);
  const maximum = Number(total);
  if (!Number.isFinite(count) || !Number.isFinite(maximum) || maximum <= 0 || count < 0 || count > maximum) return undefined;
  let remaining = count;
  if (Number.isFinite(Number(remainingPercent))) {
    const percent = Number(remainingPercent);
    const remainingDistance = Math.abs((count / maximum) * 100 - percent);
    const usedDistance = Math.abs(((maximum - count) / maximum) * 100 - percent);
    if (Math.min(remainingDistance, usedDistance) > 1) return undefined;
    if (usedDistance < remainingDistance) remaining = maximum - count;
  }
  return { total: maximum, used: maximum - remaining, remaining };
}

function assertBusinessSuccess(payload) {
  if (payload?.base_resp && Number(payload.base_resp.status_code) !== 0) {
    throw new Error(String(payload.base_resp.status_msg || `MiniMax 请求失败（code ${payload.base_resp.status_code}）。`));
  }
}

function quotaPercent(entry, prefix) {
  const status = Number(entry?.[`${prefix}_status`]);
  const total = Number(entry?.[`${prefix}_total_count`]);
  const explicit = Number(entry?.[`${prefix}_remaining_percent`]);
  if (status === 3) return { remainingPercent: 100, unlimited: true };
  if (Number.isFinite(explicit)) {
    const counts = resolveQuotaCounts(entry?.[`${prefix}_usage_count`], total, explicit);
    return { remainingPercent: clampPercent(explicit), available: true, ...counts };
  }
  if (total === 0) return { remainingPercent: 0, available: false };
  const resolved = resolveQuotaCounts(entry?.[`${prefix}_usage_count`], total);
  if (!resolved) return undefined;
  return { remainingPercent: clampPercent((resolved.remaining / resolved.total) * 100), available: true, ...resolved };
}

function normalizeMiniMaxQuota(payload, fetchedAt = Date.now()) {
  assertBusinessSuccess(payload);
  const rows = Array.isArray(payload?.model_remains) ? payload.model_remains : [];
  const limits = [];
  for (const row of rows) {
    const modelName = String(row?.model_name || "").trim();
    if (!modelName) continue;
    for (const window of [
      { prefix: "current_interval", suffix: "interval", label: "5 小时", end: "end_time", duration: 300 },
      { prefix: "current_weekly", suffix: "weekly", label: "每周", end: "weekly_end_time", duration: 7 * 24 * 60 }
    ]) {
      const normalized = quotaPercent(row, window.prefix);
      if (!normalized) continue;
      const resetsAt = Number(row?.[window.end]);
      limits.push({
        id: `${modelName}:${window.suffix}`,
        name: `${modelName} · ${window.label}`,
        usedPercent: 100 - normalized.remainingPercent,
        remainingPercent: normalized.remainingPercent,
        windowDurationMins: window.duration,
        ...(Number.isFinite(normalized.total) ? { total: normalized.total, used: normalized.used, remaining: normalized.remaining } : {}),
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        ...(normalized.available === false ? { available: false } : {}),
        ...(normalized.unlimited ? { unlimited: true } : {})
      });
    }
  }
  if (!limits.length) throw new Error("MiniMax 未返回可用的 Token Plan 额度窗口。");
  const preferred = limits.find(limit => limit.id.endsWith(":interval") && /^(general|MiniMax-M)/i.test(limit.id))
    || limits.find(limit => limit.id.endsWith(":interval"))
    || limits[0];
  return { provider: "minimax", fetchedAt, primaryLimitId: preferred.id, limits };
}

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMiniMaxBalance(payload, fetchedAt = Date.now()) {
  assertBusinessSuccess(payload);
  if (payload?.available_amount === undefined) throw new Error("MiniMax 未返回账户余额。");
  return {
    provider: "minimax",
    fetchedAt,
    primaryLimitId: "",
    limits: [],
    summary: {
      kind: "currency",
      currency: "CNY",
      available: amount(payload.available_amount),
      cash: amount(payload.cash_balance),
      voucher: amount(payload.voucher_balance),
      credit: amount(payload.credit_balance),
      owed: amount(payload.owed_amount)
    }
  };
}

async function readMiniMaxUsage({ apiKey, signal, timeoutMs = 10_000, now = Date.now, fetchImpl = globalThis.fetch }) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("请先在设置中配置 MiniMax API Key。");
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持 MiniMax 额度请求。");
  const isPayAsYouGo = key.startsWith("sk-api-");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(isPayAsYouGo ? MINIMAX_ACCOUNT_BALANCE_URL : MINIMAX_TOKEN_PLAN_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = String(payload?.error?.message || payload?.base_resp?.status_msg || payload?.message || "").trim();
      } catch {}
      throw new Error(detail || `MiniMax 额度请求失败（HTTP ${response.status}）。`);
    }
    const payload = await response.json();
    return isPayAsYouGo ? normalizeMiniMaxBalance(payload, now()) : normalizeMiniMaxQuota(payload, now());
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("读取 MiniMax 额度超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abort);
  }
}

module.exports = {
  MINIMAX_TOKEN_PLAN_USAGE_URL,
  MINIMAX_ACCOUNT_BALANCE_URL,
  resolveQuotaCounts,
  normalizeMiniMaxQuota,
  normalizeMiniMaxBalance,
  readMiniMaxUsage
};
