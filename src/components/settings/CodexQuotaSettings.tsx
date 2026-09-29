import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { AgentUsageSnapshot } from "../../vite-env";

type QuotaState =
  | { status: "loading" }
  | { status: "ready"; snapshot: AgentUsageSnapshot; refreshing: boolean }
  | { status: "error"; message: string };

function formatTimestamp(locale: string, timestamp: number) {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(timestamp);
}

function remainingClass(percent: number) {
  if (percent <= 20) return "danger";
  if (percent < 50) return "warning";
  return "normal";
}

export function CodexQuotaSettings() {
  const { locale, t } = useI18n();
  const [state, setState] = useState<QuotaState>({ status: "loading" });
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const requestIdRef = useRef(0);

  const load = useCallback(async (force = false) => {
    const requestId = ++requestIdRef.current;
    setState(current => current.status === "ready"
      ? { ...current, refreshing: true }
      : { status: "loading" });
    try {
      const snapshot = await window.agentUsageApi.getCodexUsage({ force });
      if (requestIdRef.current === requestId) {
        setState(snapshot ? { status: "ready", snapshot, refreshing: false }
          : { status: "error", message: t("settings.quotaCanceled") });
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, [t]);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
      window.agentUsageApi.cancelCodexUsage();
    };
  }, [load]);

  return <section className="settings-section codebuddy-quota-settings" aria-label={t("settings.codexQuotaTitle")}>
    <div className="codebuddy-quota-settings-header">
      <h5><button type="button" className="quota-collapse-button" aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}>
        <span className={`collapsible-chevron${expanded ? "" : " collapsed"}`} aria-hidden="true">▾</span>
        {t("settings.codexQuotaTitle")}
      </button></h5>
      <button type="button" className="icon-button" title={t("usage.refresh")} aria-label={t("settings.codexQuotaRefresh")}
        disabled={state.status === "loading" || (state.status === "ready" && state.refreshing)} onClick={() => void load(true)}>
        <RefreshCw className={state.status === "ready" && state.refreshing ? "spin" : ""} aria-hidden="true" />
      </button>
    </div>
    <div id={contentId} className="quota-collapsible-body" hidden={!expanded}>
    <p className="settings-help">{t("settings.codexQuotaLocal")}</p>
    {state.status === "loading" && <div className="codebuddy-quota-state" role="status"><LoaderCircle className="spin" aria-hidden="true" />{t("usage.loading")}</div>}
    {state.status === "error" && <div className="codebuddy-quota-error" role="alert">
      <span>{t("usage.unavailable")}</span><small title={state.message}>{state.message}</small>
      <button className="modal-button compact" type="button" onClick={() => void load(true)}>{t("usage.retry")}</button>
    </div>}
    {state.status === "ready" && <div className="agent-usage-limit-list">
      {state.snapshot.resetCredits && <div className="agent-usage-credit-summary normal">
        <strong>{t("usage.resetCreditsTitle")}</strong>
        <span>{t("usage.resetCreditsAvailable", { count: state.snapshot.resetCredits.availableCount })}</span>
        {state.snapshot.resetCredits.credits?.filter(credit => credit.status === "available").map(credit => <small key={credit.id}>
          {credit.title || t("usage.resetCreditFallback")}
          {credit.expiresAt ? ` · ${t("usage.expiresAt", { time: formatTimestamp(locale, credit.expiresAt) })}` : ""}
        </small>)}
      </div>}
      {state.snapshot.limits.map(limit => <div className={`agent-usage-limit ${remainingClass(limit.remainingPercent)}`} key={limit.id}>
        <div className="agent-usage-limit-heading"><strong>{limit.name}</strong>
          <span>{limit.unlimited ? t("usage.unlimited") : limit.available === false ? t("usage.notInPlan") : t("usage.limitRemaining", { remaining: limit.remainingPercent })}</span></div>
        <div className="agent-usage-progress" role="progressbar" aria-label={limit.name} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={limit.usedPercent} aria-valuetext={t("usage.used", { used: limit.usedPercent })}>
          <span style={{ width: `${limit.usedPercent}%` }} />
        </div>
        <div className="agent-usage-limit-meta"><span>{t("usage.used", { used: limit.usedPercent })}</span>
          <span>{limit.resetsAt ? t("usage.resetsAt", { time: formatTimestamp(locale, limit.resetsAt) }) : t("usage.resetUnavailable")}</span></div>
      </div>)}
      <small>{t("usage.updatedAt", { time: formatTimestamp(locale, state.snapshot.fetchedAt) })}</small>
    </div>}
    </div>
  </section>;
}
