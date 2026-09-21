import { Activity, ArrowLeft, ArrowLeftRight, BarChart3, ChevronDown, ChevronUp, Gauge, MessageSquare, RefreshCw, Trash2, Wrench } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { useAgentTokenStats, type TokenStatsProvider, type TokenStatsRange } from "../../hooks/useAgentTokenStats";
import type { AgentCapabilityUsage, AgentTokenTotals } from "../../vite-env";
import { mcpServerDisplayName } from "./agentCapabilityLabels";

function formatTokens(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function providerName(provider: "codex" | "claude" | "codebuddy" | "opencode" | "qoder" | "copilot" | "gemini" | "grok") {
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "opencode") return "OpenCode";
  if (provider === "qoder") return "Qoder";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "gemini") return "Gemini CLI";
  if (provider === "grok") return "Grok CLI";
  return provider === "codex" ? "Codex" : "Claude";
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

function MetricCard({ icon, label, value, hint, tone }: { icon: ReactNode; label: string; value: string; hint: string; tone: string }) {
  return (
    <article className={`token-stats-metric token-stats-metric-${tone}`}>
      <div className="token-stats-metric-heading"><span>{label}</span><i aria-hidden="true">{icon}</i></div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function TrendChart({ values, locale }: { values: Array<{ date: string; tokens: AgentTokenTotals }>; locale: string }) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(1, ...values.map(item => item.tokens.totalTokens));
  const points = values.map((item, index) => {
    const x = values.length <= 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 92 - (item.tokens.totalTokens / max) * 78;
    return { ...item, x, y };
  });
  if (values.length === 0) return <div className="token-stats-chart-empty">{t("tokenStats.noTrend")}</div>;
  const pointList = points.map(point => `${point.x},${point.y}`).join(" ");
  const areaPath = `M 0 92 L ${pointList.split(" ").join(" L ")} L 100 92 Z`;
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const tooltipTransform = activePoint
    ? `translate(${activePoint.x <= 10 ? "0" : activePoint.x >= 90 ? "-100%" : "-50%"}, ${activePoint.y <= 30 ? "12px" : "calc(-100% - 12px)"})`
    : undefined;
  return (
    <div className="token-stats-trend">
      <div className="token-stats-trend-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={t("tokenStats.dailyTrend")}>
          <defs><linearGradient id="token-trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" /><stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" /></linearGradient></defs>
          {[14, 40, 66, 92].map(y => <line key={y} x1="0" y1={y} x2="100" y2={y} />)}
          <path className="token-stats-trend-area" d={areaPath} />
          <polyline points={pointList} />
        </svg>
        {points.map((point, index) => (
          <button
            className="token-stats-trend-point"
            type="button"
            key={point.date}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            aria-label={`${point.date}: ${t("tokenStats.total")} ${point.tokens.totalTokens.toLocaleString(locale)}`}
            onMouseEnter={() => setActiveIndex(index)}
            onMouseLeave={() => setActiveIndex(null)}
            onFocus={() => setActiveIndex(index)}
            onBlur={() => setActiveIndex(null)}
          />
        ))}
        {activePoint && (
          <div
            className="token-stats-trend-tooltip"
            role="tooltip"
            style={{ left: `${activePoint.x}%`, top: `${activePoint.y}%`, transform: tooltipTransform }}
          >
            <strong>{activePoint.date}</strong>
            <div><span>{t("tokenStats.total")}</span><b>{activePoint.tokens.totalTokens.toLocaleString(locale)}</b></div>
            <div><span>{t("tokenStats.input")}</span><b>{activePoint.tokens.inputTokens.toLocaleString(locale)}</b></div>
            <div><span>{t("tokenStats.cached")}</span><b>{activePoint.tokens.cachedInputTokens.toLocaleString(locale)}</b></div>
            <div><span>{t("tokenStats.output")}</span><b>{activePoint.tokens.outputTokens.toLocaleString(locale)}</b></div>
          </div>
        )}
      </div>
      <div className="token-stats-trend-labels"><span>{values[0].date}</span><span>{values.at(-1)?.date}</span></div>
    </div>
  );
}

function CapabilityDetails({ capabilities }: { capabilities: AgentCapabilityUsage }) {
  const { t } = useI18n();
  return (
    <div className="token-capability-details">
      <section>
        <div><strong>{t("tokenStats.skillUsage")}</strong><span>{capabilities.skills.totalCalls} {t("tokenStats.callsUnit")}</span></div>
        {capabilities.skills.availability === "unavailable"
          ? <p>{t("tokenStats.capabilityUnavailable")}</p>
          : capabilities.skills.items.length
            ? <ul>{capabilities.skills.items.map(item => <li key={item.name}><span>{item.name}</span><b>{item.count}</b></li>)}</ul>
            : <p>{t("tokenStats.noSkills")}</p>}
      </section>
      <section>
        <div><strong>{t("tokenStats.mcpUsage")}</strong><span>{capabilities.mcp.totalCalls} {t("tokenStats.callsUnit")}</span></div>
        {capabilities.mcp.availability === "unavailable"
          ? <p>{t("tokenStats.capabilityUnavailable")}</p>
          : capabilities.mcp.servers.length
            ? <ul>{capabilities.mcp.servers.map(server => <li key={server.name}><span><strong>{mcpServerDisplayName(server.name, t)}</strong><small>{server.tools.map(tool => `${tool.name} ×${tool.count}`).join(" · ")}</small></span><b>{server.count}</b></li>)}</ul>
            : <p>{t("tokenStats.noMcp")}</p>}
      </section>
      <small>{t("tokenStats.transcriptDetected")}</small>
    </div>
  );
}

function RankingList({ items, emptyText, nameFor = (name) => name }: { items: Array<{ name: string; count: number }>; emptyText: string; nameFor?: (name: string) => string }) {
  if (!items.length) return <div className="token-stats-chart-empty">{emptyText}</div>;
  const max = Math.max(1, ...items.map(item => item.count));
  return <div className="token-capability-ranking">{items.slice(0, 8).map(item => <div key={item.name}><span><strong>{nameFor(item.name)}</strong><b>{item.count}</b></span><i><span style={{ width: `${item.count / max * 100}%` }} /></i></div>)}</div>;
}

export function AgentTokenStatsDashboard({ onClose }: { onClose: () => void }) {
  const { locale, t } = useI18n();
  const [range, setRange] = useState<TokenStatsRange>("30d");
  const [provider, setProvider] = useState<TokenStatsProvider>("all");
  const [offset, setOffset] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("local");
  const [devices, setDevices] = useState<Array<{ id: string; name: string }>>([]);
  const { dashboard, loading, error, refresh } = useAgentTokenStats(range, provider, offset, deviceId);
  useEffect(() => { if (window.postgresBackupApi) void window.postgresBackupApi.listDevices().then(setDevices).catch(() => {}); }, []);
  useEffect(() => { setOffset(0); setExpandedSessionId(null); }, [deviceId]);
  useEffect(() => { setOffset(0); setExpandedSessionId(null); }, [provider, range]);
  const maxProviderTokens = useMemo(() => Math.max(1, ...(dashboard?.providerBreakdown.map(item => item.tokens.totalTokens) || [])), [dashboard]);

  const clearAll = async () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    setClearing(true);
    try { await window.agentTokenStatsApi.clear(); setConfirmClear(false); setOffset(0); await refresh(); } finally { setClearing(false); }
  };

  return (
    <main className="token-stats-page">
      <header className="token-stats-header">
        <div className="token-stats-heading"><button className="icon-button" type="button" onClick={onClose} title={t("tokenStats.back")}><ArrowLeft aria-hidden="true" /></button><span className="token-stats-title-icon"><BarChart3 aria-hidden="true" /></span><div><h1>{t("tokenStats.title")}</h1><p>{t("tokenStats.description")}</p></div></div>
        <div className="token-stats-actions">
          {devices.length > 0 && <select value={deviceId} onChange={event => setDeviceId(event.target.value)} aria-label={locale === "en-US" ? "Source computer" : "来源电脑"}><option value="local">{locale === "en-US" ? "Local" : "本机"}</option><option value="all">{locale === "en-US" ? "All computers" : "全部电脑"}</option>{devices.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>}
          <select value={range} onChange={(event) => setRange(event.target.value as TokenStatsRange)} aria-label={t("tokenStats.range")}><option value="7d">{t("tokenStats.last7Days")}</option><option value="30d">{t("tokenStats.last30Days")}</option><option value="all">{t("tokenStats.allTime")}</option></select>
          <select value={provider} onChange={(event) => setProvider(event.target.value as TokenStatsProvider)} aria-label={t("tokenStats.provider")}><option value="all">{t("tokenStats.allProviders")}</option><option value="codex">Codex</option><option value="claude">Claude</option><option value="codebuddy">CodeBuddy</option><option value="opencode">OpenCode</option><option value="qoder">Qoder</option><option value="copilot">GitHub Copilot</option><option value="gemini">Gemini CLI</option><option value="grok">Grok CLI</option></select>
          <button className="icon-button" type="button" onClick={() => void refresh()} title={t("common.refresh")} disabled={loading}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" /></button>
          {deviceId === "local" && <button className={`token-stats-clear${confirmClear ? " confirm" : ""}`} type="button" onClick={() => void clearAll()} onBlur={() => setConfirmClear(false)} disabled={clearing}><Trash2 aria-hidden="true" />{confirmClear ? t("tokenStats.confirmClear") : t("tokenStats.clear")}</button>}
        </div>
      </header>

      {error ? <div className="token-stats-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>{t("common.retry")}</button></div> : dashboard && (
        <div className="token-stats-content">
          <section className="token-stats-cards">
            <MetricCard icon={<Activity />} label={t("tokenStats.total")} value={formatTokens(dashboard.summary.tokens.totalTokens, locale)} hint={dashboard.summary.tokens.totalTokens.toLocaleString(locale)} tone="accent" />
            <MetricCard icon={<MessageSquare />} label={t("tokenStats.sessions")} value={dashboard.summary.sessionCount.toLocaleString(locale)} hint={t("tokenStats.trackedSessions")} tone="blue" />
            <MetricCard icon={<Gauge />} label={t("tokenStats.average")} value={formatTokens(dashboard.summary.averageTokens, locale)} hint={t("tokenStats.perSession")} tone="violet" />
            <MetricCard icon={<ArrowLeftRight />} label={t("tokenStats.inputOutput")} value={`${formatTokens(dashboard.summary.tokens.inputTokens, locale)} / ${formatTokens(dashboard.summary.tokens.outputTokens, locale)}`} hint={t("tokenStats.inputOutputHint")} tone="cyan" />
            <MetricCard icon={<Wrench />} label={t("tokenStats.skillCalls")} value={dashboard.summary.skillCalls.toLocaleString(locale)} hint={t("tokenStats.transcriptDetected")} tone="green" />
            <MetricCard icon={<BarChart3 />} label={t("tokenStats.mcpCalls")} value={dashboard.summary.mcpCalls.toLocaleString(locale)} hint={t("tokenStats.transcriptDetected")} tone="orange" />
          </section>

          <section className="token-stats-visuals">
            <article className="token-stats-panel"><h2>{t("tokenStats.dailyTrend")}</h2><TrendChart values={dashboard.dailyTrend} locale={locale} /></article>
            <article className="token-stats-panel"><h2>{t("tokenStats.providerCompare")}</h2><div className="token-stats-provider-bars">{dashboard.providerBreakdown.map(item => <div key={item.provider}><div><strong>{providerName(item.provider)}</strong><span>{formatTokens(item.tokens.totalTokens, locale)} · {item.sessionCount} {t("tokenStats.sessionsUnit")}</span></div><div className={`token-provider-bar ${item.provider}`}><span style={{ width: `${item.tokens.totalTokens / maxProviderTokens * 100}%`, minWidth: item.tokens.totalTokens > 0 ? "2px" : 0 }} /></div></div>)}</div></article>
          </section>

          <section className="token-stats-visuals token-capability-visuals">
            <article className="token-stats-panel"><h2>{t("tokenStats.topSkills")}</h2><RankingList items={dashboard.topSkills} emptyText={t("tokenStats.noSkills")} /></article>
            <article className="token-stats-panel"><h2>{t("tokenStats.topMcp")}</h2><RankingList items={dashboard.topMcpServers} emptyText={t("tokenStats.noMcp")} nameFor={(name) => mcpServerDisplayName(name, t)} /></article>
          </section>

          <section className="token-stats-panel token-stats-table-panel">
            <div className="token-stats-table-heading"><h2>{t("tokenStats.sessionDetails")}</h2><span>{t("tokenStats.totalRecords", { count: dashboard.totalCount })}</span></div>
            {dashboard.sessions.length === 0 ? <div className="token-stats-empty"><BarChart3 aria-hidden="true" /><strong>{t("tokenStats.noData")}</strong><span>{t("tokenStats.noDataHint")}</span></div> : <div className="token-stats-table-wrap"><table><thead><tr><th>{t("tokenStats.time")}</th><th>{t("tokenStats.provider")}</th><th>{t("tokenStats.session")}</th><th>{t("tokenStats.location")}</th><th>{t("tokenStats.model")}</th><th>{t("tokenStats.tokens")}</th><th>{t("tokenStats.skillCalls")} / {t("tokenStats.mcpCalls")}</th></tr></thead><tbody>{dashboard.sessions.map(record => {
              const expanded = expandedSessionId === record.id;
              return <Fragment key={record.id}>
                <tr><td>{formatDate(record.updatedAt, locale)}</td><td><span className={`token-provider-pill ${record.provider}`}>{providerName(record.provider)}</span></td><td><strong title={record.cwd}>{record.title}</strong><small>{record.cwd}</small></td><td>{record.location.toUpperCase()}</td><td>{record.models.join(", ") || "—"}</td><td><TokenBreakdown tokens={record.tokens} locale={locale} /></td><td><button className="token-capability-toggle" type="button" aria-expanded={expanded} aria-label={t(expanded ? "tokenStats.collapseUsage" : "tokenStats.expandUsage")} onClick={() => setExpandedSessionId(expanded ? null : record.id)}><span>{record.capabilities.skills.availability === "available" ? record.capabilities.skills.totalCalls : "—"} / {record.capabilities.mcp.availability === "available" ? record.capabilities.mcp.totalCalls : "—"}</span>{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button></td></tr>
                {expanded && <tr className="token-capability-row"><td colSpan={7}><CapabilityDetails capabilities={record.capabilities} /></td></tr>}
              </Fragment>;
            })}</tbody></table></div>}
            {dashboard.totalCount > dashboard.limit && <div className="token-stats-pagination"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t("tokenStats.previous")}</button><span>{Math.floor(offset / 50) + 1} / {Math.ceil(dashboard.totalCount / 50)}</span><button type="button" disabled={offset + 50 >= dashboard.totalCount} onClick={() => setOffset(offset + 50)}>{t("tokenStats.next")}</button></div>}
          </section>
        </div>
      )}
      {loading && !dashboard && <div className="token-stats-loading">{t("common.loading")}</div>}
    </main>
  );
}
