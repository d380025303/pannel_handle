function createAccountController({ request, changed, authenticated = () => {} }) {
  let state = { status: "loading", requiresOpenaiAuth: true, account: null, login: null,
    rateLimits: null, usage: null, rateLimitsError: null, usageError: null, error: null };
  let loginAttempt = null;
  let earlyCompletion = null;
  let revision = 0;
  const snapshot = () => ({ ...state, account: state.account ? { ...state.account } : null,
    login: state.login ? { ...state.login } : null });
  function update(patch) { state = { ...state, ...patch }; changed(); }
  function accountInfo(value) {
    if (!value || typeof value !== "object") return null;
    return { type: String(value.type || "unknown"),
      email: typeof value.email === "string" ? value.email : null,
      planType: typeof value.planType === "string" ? value.planType : null };
  }
  function limitWindow(value) {
    if (!value || typeof value !== "object") return undefined;
    return { usedPercent: Number.isFinite(value.usedPercent) ? value.usedPercent : undefined,
      resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : undefined };
  }
  function limitBucket(value) {
    if (!value || typeof value !== "object") return undefined;
    return { limitName: typeof value.limitName === "string" ? value.limitName : null,
      primary: limitWindow(value.primary), secondary: limitWindow(value.secondary) };
  }
  function normalizeRateLimits(value) {
    if (!value || typeof value !== "object") return null;
    const buckets = value.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === "object"
      ? Object.fromEntries(Object.entries(value.rateLimitsByLimitId).slice(0, 30)
        .map(([id, bucket]) => [id, limitBucket(bucket)]).filter(([, bucket]) => bucket)) : undefined;
    return { rateLimits: limitBucket(value.rateLimits), rateLimitsByLimitId: buckets };
  }
  function normalizeUsage(value) {
    if (!value || typeof value !== "object") return null;
    const summary = value.summary && typeof value.summary === "object" ? Object.fromEntries(
      ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"]
        .filter(key => Number.isFinite(value.summary[key]) && value.summary[key] >= 0)
        .map(key => [key, value.summary[key]])) : undefined;
    const dailyUsageBuckets = Array.isArray(value.dailyUsageBuckets)
      ? value.dailyUsageBuckets.filter(day => typeof day?.startDate === "string" && Number.isFinite(day.tokens) && day.tokens >= 0)
        .slice(-31).map(day => ({ startDate: day.startDate, tokens: day.tokens })) : undefined;
    return { summary, dailyUsageBuckets };
  }
  async function refresh() {
    const expectedRevision = revision;
    const result = await request("account/read", { refreshToken: false });
    if (revision !== expectedRevision) return snapshot();
    const account = accountInfo(result?.account);
    if (!account) revision++;
    update({ account, requiresOpenaiAuth: result?.requiresOpenaiAuth === true,
      status: account ? "signedIn" : result?.requiresOpenaiAuth === true ? "signedOut" : "notRequired",
      error: account ? null : state.error,
      ...(account ? {} : { rateLimits: null, usage: null, rateLimitsError: null, usageError: null }) });
    return snapshot();
  }
  async function refreshUsage() {
    if (state.status !== "signedIn" || state.account?.type !== "chatgpt") return snapshot();
    const expectedRevision = revision;
    const [limits, usage] = await Promise.allSettled([
      request("account/rateLimits/read", {}), request("account/usage/read", {})
    ]);
    if (revision !== expectedRevision) return snapshot();
    update({
      rateLimits: limits.status === "fulfilled" ? normalizeRateLimits(limits.value) : null,
      usage: usage.status === "fulfilled" ? normalizeUsage(usage.value) : null,
      rateLimitsError: limits.status === "rejected" ? String(limits.reason?.message || limits.reason) : null,
      usageError: usage.status === "rejected" ? String(usage.reason?.message || usage.reason) : null
    });
    return snapshot();
  }
  async function complete(params) {
    if (!loginAttempt) return;
    if (loginAttempt.loginId == null) { earlyCompletion = params; return; }
    if (params.loginId !== loginAttempt.loginId) return;
    const canceled = loginAttempt.canceled;
    loginAttempt = null;
    earlyCompletion = null;
    update({ login: null, error: !params.success && !canceled ? String(params.error || "登录失败。") : null });
    if (params.success) {
      try { await refresh(); await authenticated(); await refreshUsage(); }
      catch (error) { update({ error: String(error?.message || error) }); }
    } else await refresh().catch(() => {});
  }
  async function startLogin(type) {
    if (type !== "chatgpt" && type !== "chatgptDeviceCode") throw new Error("不支持的登录方式。");
    if (loginAttempt) throw new Error("登录正在进行中。");
    const attempt = { loginId: null, canceled: false };
    loginAttempt = attempt;
    update({ login: { type, loginId: null }, error: null });
    try {
      const result = await request("account/login/start", type === "chatgpt"
        ? { type, useHostedLoginSuccessPage: true, appBrand: "codex" } : { type });
      if (loginAttempt !== attempt) return snapshot();
      if (!result || typeof result.loginId !== "string" || !result.loginId) throw new Error("Codex 未返回登录 ID。");
      attempt.loginId = result.loginId;
      const login = type === "chatgpt"
        ? { type, loginId: result.loginId, url: result.authUrl }
        : { type, loginId: result.loginId, url: result.verificationUrl, userCode: result.userCode };
      if (typeof login.url !== "string" || !/^https:\/\//i.test(login.url)
        || (type === "chatgptDeviceCode" && typeof login.userCode !== "string")) throw new Error("Codex 登录信息无效。");
      update({ login });
      if (earlyCompletion) void complete(earlyCompletion);
      return snapshot();
    } catch (error) {
      if (loginAttempt === attempt) loginAttempt = null;
      earlyCompletion = null;
      update({ login: null, error: String(error?.message || error) });
      throw error;
    }
  }
  async function cancelLogin() {
    if (!loginAttempt?.loginId) throw new Error("没有可取消的登录。");
    loginAttempt.canceled = true;
    await request("account/login/cancel", { loginId: loginAttempt.loginId });
    loginAttempt = null;
    earlyCompletion = null;
    update({ login: null, error: null });
    return snapshot();
  }
  async function logout() {
    if (loginAttempt) throw new Error("请先取消登录。");
    await request("account/logout", {});
    revision++;
    update({ account: null, status: "signedOut", rateLimits: null, usage: null,
      rateLimitsError: null, usageError: null, error: null });
    await refresh();
    return snapshot();
  }
  function onNotification(method, params = {}) {
    if (method === "account/login/completed") { void complete(params); return true; }
    if (method === "account/updated") {
      void refresh().then(value => value.status === "signedIn" ? authenticated() : undefined).catch(() => {});
      return true;
    }
    if (method === "account/rateLimits/updated") { void refreshUsage().catch(() => {}); return true; }
    return false;
  }
  function reset() {
    revision++;
    loginAttempt = null;
    earlyCompletion = null;
    update({ status: "loading", account: null, login: null, rateLimits: null, usage: null });
  }
  return { snapshot, refresh, refreshUsage, startLogin, cancelLogin, logout, onNotification, reset };
}

module.exports = { createAccountController };
