import { ArrowLeft, BarChart3, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { useAgentTokenStats, type TokenStatsProvider, type TokenStatsRange } from "../../hooks/useAgentTokenStats";
import type { AgentTokenTotals } from "../../vite-env";

function formatTokens(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function TokenBreakdown({ tokens, locale }: { tokens: AgentTokenTotals; locale: string }) {
  const { t } = useI18n();
  return (
    <span className="token-stats-breakdown" title={`${t("tokenStats.input")}: ${tokens.inputTokens.toLocaleString(locale)} · ${t("tokenStats.cached")}: ${tokens.cachedInputTokens.toLocaleString(locale)} · ${t("tokenStats.output")}: ${tokens.outputTokens.toLocaleString(locale)}`}>
      <strong>{formatTokens(tokens.totalTokens, locale)}</strong>
      <small>{formatTokens(tokens.inputTokens, locale)} / {formatTokens(tokens.outputTokens, locale)}</small>
    </span>
  );
}

function TrendChart({ values, locale }: { values: Array<{ date: string; tokens: AgentTokenTotals }>; locale: string }) {
  const { t } = useI18n();
  const max = Math.max(1, ...values.map(item => item.tokens.totalTokens));
  const points = values.map((item, index) => {
    const x = values.length <= 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 92 - (item.tokens.totalTokens / max) * 78;
    return `${x},${y}`;
  }).join(" ");
  if (values.length === 0) return <div className="token-stats-chart-empty">{t("tokenStats.noTrend")}</div>;
  return (
    <div className="token-stats-trend">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={t("tokenStats.dailyTrend")}>
        <line x1="0" y1="92" x2="100" y2="92" />
        <polyline points={points} />
      </svg>
      <div className="token-stats-trend-labels"><span>{values[0].date}</span><strong>{formatTokens(max, locale)}</strong><span>{values.at(-1)?.date}</span></div>
    </div>
  );
}

export function AgentTokenStatsDashboard({ onClose }: { onClose: () => void }) {
  const { locale, t } = useI18n();
  const [range, setRange] = useState<TokenStatsRange>("30d");
  const [provider, setProvider] = useState<TokenStatsProvider>("all");
  const [offset, setOffset] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { dashboard, loading, error, refresh } = useAgentTokenStats(range, provider, offset);
  useEffect(() => setOffset(0), [provider, range]);
  const maxProviderTokens = useMemo(() => Math.max(1, ...(dashboard?.providerBreakdown.map(item => item.tokens.totalTokens) || [])), [dashboard]);

  const clearAll = async () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    setClearing(true);
    try { await window.agentTokenStatsApi.clear(); setConfirmClear(false); setOffset(0); await refresh(); } finally { setClearing(false); }
  };

  return (
    <main className="token-stats-page">
      <header className="token-stats-header">
        <div><button className="icon-button" type="button" onClick={onClose} title={t("tokenStats.back")}><ArrowLeft aria-hidden="true" /></button><BarChart3 aria-hidden="true" /><div><h1>{t("tokenStats.title")}</h1><p>{t("tokenStats.description")}</p></div></div>
        <div className="token-stats-actions">
          <select value={range} onChange={(event) => setRange(event.target.value as TokenStatsRange)} aria-label={t("tokenStats.range")}><option value="7d">{t("tokenStats.last7Days")}</option><option value="30d">{t("tokenStats.last30Days")}</option><option value="all">{t("tokenStats.allTime")}</option></select>
          <select value={provider} onChange={(event) => setProvider(event.target.value as TokenStatsProvider)} aria-label={t("tokenStats.provider")}><option value="all">{t("tokenStats.allProviders")}</option><option value="codex">Codex</option><option value="claude">Claude</option></select>
          <button className="icon-button" type="button" onClick={() => void refresh()} title={t("common.refresh")} disabled={loading}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" /></button>
          <button className={`token-stats-clear${confirmClear ? " confirm" : ""}`} type="button" onClick={() => void clearAll()} onBlur={() => setConfirmClear(false)} disabled={clearing}><Trash2 aria-hidden="true" />{confirmClear ? t("tokenStats.confirmClear") : t("tokenStats.clear")}</button>
        </div>
      </header>

      {error ? <div className="token-stats-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>{t("common.retry")}</button></div> : dashboard && (
        <div className="token-stats-content">
          <section className="token-stats-cards">
            <article><span>{t("tokenStats.total")}</span><strong>{formatTokens(dashboard.summary.tokens.totalTokens, locale)}</strong><small>{dashboard.summary.tokens.totalTokens.toLocaleString(locale)}</small></article>
            <article><span>{t("tokenStats.sessions")}</span><strong>{dashboard.summary.sessionCount.toLocaleString(locale)}</strong><small>{t("tokenStats.trackedSessions")}</small></article>
            <article><span>{t("tokenStats.average")}</span><strong>{formatTokens(dashboard.summary.averageTokens, locale)}</strong><small>{t("tokenStats.perSession")}</small></article>
            <article><span>{t("tokenStats.inputOutput")}</span><strong>{formatTokens(dashboard.summary.tokens.inputTokens, locale)} / {formatTokens(dashboard.summary.tokens.outputTokens, locale)}</strong><small>{t("tokenStats.inputOutputHint")}</small></article>
          </section>

          <section className="token-stats-visuals">
            <article className="token-stats-panel"><h2>{t("tokenStats.dailyTrend")}</h2><TrendChart values={dashboard.dailyTrend} locale={locale} /></article>
            <article className="token-stats-panel"><h2>{t("tokenStats.providerCompare")}</h2><div className="token-stats-provider-bars">{dashboard.providerBreakdown.map(item => <div key={item.provider}><div><strong>{item.provider === "codex" ? "Codex" : "Claude"}</strong><span>{formatTokens(item.tokens.totalTokens, locale)} · {item.sessionCount} {t("tokenStats.sessionsUnit")}</span></div><div className={`token-provider-bar ${item.provider}`}><span style={{ width: `${item.tokens.totalTokens / maxProviderTokens * 100}%` }} /></div></div>)}</div></article>
          </section>

          <section className="token-stats-panel token-stats-table-panel">
            <div className="token-stats-table-heading"><h2>{t("tokenStats.sessionDetails")}</h2><span>{t("tokenStats.totalRecords", { count: dashboard.totalCount })}</span></div>
            {dashboard.sessions.length === 0 ? <div className="token-stats-empty"><BarChart3 aria-hidden="true" /><strong>{t("tokenStats.noData")}</strong><span>{t("tokenStats.noDataHint")}</span></div> : <div className="token-stats-table-wrap"><table><thead><tr><th>{t("tokenStats.time")}</th><th>{t("tokenStats.provider")}</th><th>{t("tokenStats.session")}</th><th>{t("tokenStats.location")}</th><th>{t("tokenStats.model")}</th><th>{t("tokenStats.tokens")}</th><th>{t("tokenStats.status")}</th></tr></thead><tbody>{dashboard.sessions.map(record => <tr key={record.id}><td>{formatDate(record.updatedAt, locale)}</td><td><span className={`token-provider-pill ${record.provider}`}>{record.provider}</span></td><td><strong title={record.cwd}>{record.title}</strong><small>{record.cwd}</small></td><td>{record.location.toUpperCase()}</td><td>{record.models.join(", ") || "—"}</td><td><TokenBreakdown tokens={record.tokens} locale={locale} /></td><td><span className={`token-session-status ${record.status}`}>{record.status === "active" ? t("tokenStats.active") : t("tokenStats.ended")}</span></td></tr>)}</tbody></table></div>}
            {dashboard.totalCount > dashboard.limit && <div className="token-stats-pagination"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t("tokenStats.previous")}</button><span>{Math.floor(offset / 50) + 1} / {Math.ceil(dashboard.totalCount / 50)}</span><button type="button" disabled={offset + 50 >= dashboard.totalCount} onClick={() => setOffset(offset + 50)}>{t("tokenStats.next")}</button></div>}
          </section>
        </div>
      )}
      {loading && !dashboard && <div className="token-stats-loading">{t("common.loading")}</div>}
    </main>
  );
}
