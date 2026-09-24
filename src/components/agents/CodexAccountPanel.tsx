import { useEffect, useState } from "react";
import type { CodexAccountState } from "../../vite-env";
import { useI18n } from "../../i18n";

type AccountActions = {
  readAccount: () => Promise<CodexAccountState>;
  startLogin: (type: "chatgpt" | "chatgptDeviceCode") => Promise<CodexAccountState>;
  cancelLogin: () => Promise<CodexAccountState>;
  logout: () => Promise<CodexAccountState>;
  refreshAccountUsage: () => Promise<CodexAccountState>;
};

export function CodexAccountPanel({ account, actions, preferDeviceCode = false, busy = false }: {
  account?: CodexAccountState | null; actions: AccountActions; preferDeviceCode?: boolean; busy?: boolean;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [view, setView] = useState<CodexAccountState | null>(null);
  const current = view || account;
  useEffect(() => { if (account) setView(account); }, [account]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void actions.readAccount().then(async value => {
      if (live) setView(value);
      if (value.status === "signedIn") {
        const usage = await actions.refreshAccountUsage();
        if (live) setView(usage);
      }
    }).catch(cause => { if (live) setError(String(cause?.message || cause)); });
    return () => { live = false; };
  }, [open]);
  async function run(action: () => Promise<CodexAccountState>) {
    setWorking(true); setError("");
    try { setView(await action()); } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  }
  async function login(type: "chatgpt" | "chatgptDeviceCode") {
    await run(async () => {
      const next = await actions.startLogin(type);
      if (type === "chatgpt" && next.login?.url) await window.externalLinkApi.open(next.login.url);
      return next;
    });
  }
  const signedIn = current?.status === "signedIn";
  const limitBuckets = current?.rateLimits?.rateLimitsByLimitId
    ? Object.entries(current.rateLimits.rateLimitsByLimitId)
    : current?.rateLimits?.rateLimits ? [["codex", current.rateLimits.rateLimits] as const] : [];
  const label = signedIn ? current.account?.email || current.account?.planType || (zh ? "已登录" : "Signed in")
    : current?.status === "signedOut" ? (zh ? "未登录" : "Sign in") : (zh ? "Codex 账号" : "Codex account");
  return <div className="codex-account">
    <button type="button" className="codex-account-trigger" aria-expanded={open} onClick={() => setOpen(value => !value)}>{label}</button>
    {open && <div className="codex-account-panel" role="region" aria-label={zh ? "Codex 账号管理" : "Codex account management"}>
      <strong>{zh ? "Codex 账号" : "Codex account"}</strong>
      {current?.account && <p>{current.account.email || current.account.type}{current.account.planType ? ` · ${current.account.planType}` : ""}</p>}
      {current?.status === "signedOut" && !current.login && <div className="codex-account-actions">
        <button type="button" disabled={working} onClick={() => void login(preferDeviceCode ? "chatgptDeviceCode" : "chatgpt")}>{zh ? "使用 ChatGPT 登录" : "Sign in with ChatGPT"}</button>
        <button type="button" disabled={working} onClick={() => void login(preferDeviceCode ? "chatgpt" : "chatgptDeviceCode")}>{preferDeviceCode ? (zh ? "浏览器登录" : "Browser login") : (zh ? "设备码登录" : "Device code login")}</button>
      </div>}
      {current?.login && <div className="codex-account-login" role="status">
        <p>{zh ? "等待完成登录…" : "Waiting for sign in…"}</p>
        {current.login.userCode && <code>{current.login.userCode}</code>}
        {current.login.url && <button type="button" onClick={() => void window.externalLinkApi.open(current.login!.url!)}>{zh ? "打开验证页面" : "Open verification page"}</button>}
        <button type="button" disabled={working || !current.login.loginId} onClick={() => void run(actions.cancelLogin)}>{zh ? "取消登录" : "Cancel sign in"}</button>
      </div>}
      {signedIn && <>
        <div className="codex-account-actions">
          <button type="button" disabled={working} onClick={() => void run(actions.refreshAccountUsage)}>{zh ? "刷新账号用量" : "Refresh account usage"}</button>
          {!confirmLogout ? <button type="button" disabled={working || busy} onClick={() => setConfirmLogout(true)}>{zh ? "登出" : "Sign out"}</button>
            : <><button type="button" disabled={working || busy} onClick={() => void run(actions.logout).then(() => setConfirmLogout(false))}>{zh ? "确认登出" : "Confirm sign out"}</button>
              <button type="button" onClick={() => setConfirmLogout(false)}>{zh ? "返回" : "Back"}</button></>}
        </div>
        {limitBuckets.length > 0 && <section><h3>{zh ? "额度窗口" : "Rate limits"}</h3>{limitBuckets.map(([id, bucket]) => <div key={id}>
          <p>{bucket.limitName || id}：{bucket.primary?.usedPercent ?? "—"}%
            {bucket.primary?.resetsAt ? ` · ${new Date(bucket.primary.resetsAt * 1000).toLocaleString(locale)}` : ""}</p>
          {bucket.secondary && <p>{zh ? "次级窗口" : "Secondary window"}：{bucket.secondary.usedPercent ?? "—"}%
            {bucket.secondary.resetsAt ? ` · ${new Date(bucket.secondary.resetsAt * 1000).toLocaleString(locale)}` : ""}</p>}
        </div>)}</section>}
        {current?.rateLimitsError && <p role="alert">{zh ? "额度读取失败：" : "Rate limits: "}{current.rateLimitsError}</p>}
        {current?.usage?.summary && <section><h3>{zh ? "账号用量" : "Account usage"}</h3>
          <p>{zh ? "累计 Token" : "Lifetime tokens"}：{current.usage.summary.lifetimeTokens?.toLocaleString(locale) ?? "—"}</p>
          <p>{zh ? "单日峰值" : "Peak daily tokens"}：{current.usage.summary.peakDailyTokens?.toLocaleString(locale) ?? "—"}</p>
          <p>{zh ? "最长回合" : "Longest turn"}：{current.usage.summary.longestRunningTurnSec ?? "—"} {zh ? "秒" : "sec"}</p>
          <p>{zh ? "当前连续使用" : "Current streak"}：{current.usage.summary.currentStreakDays ?? "—"} {zh ? "天" : "days"}</p>
          <p>{zh ? "最长连续使用" : "Longest streak"}：{current.usage.summary.longestStreakDays ?? "—"} {zh ? "天" : "days"}</p>
          {current.usage.dailyUsageBuckets?.slice(-7).map(day => <p key={day.startDate}>{day.startDate}：{day.tokens.toLocaleString(locale)}</p>)}
        </section>}
        {current?.usageError && <p role="alert">{zh ? "用量读取失败：" : "Usage: "}{current.usageError}</p>}
      </>}
      {(error || current?.error) && <p role="alert">{error || current?.error}</p>}
    </div>}
  </div>;
}
