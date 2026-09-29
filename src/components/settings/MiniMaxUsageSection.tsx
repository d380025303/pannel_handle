import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n";
import type { MiniMaxUsageSnapshot } from "../../vite-env";

type MiniMaxUsageSectionProps = { hasApiKey: boolean; defaultExpanded?: boolean };

type MiniMaxUsageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; snapshot: MiniMaxUsageSnapshot }
  | { status: "error"; message: string };

function getRemainingClass(remainingPercent: number) {
  if (remainingPercent <= 20) return "danger";
  if (remainingPercent < 50) return "warning";
  return "normal";
}

function formatAmount(locale: string, amount: number) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount);
}

function formatTimestamp(locale: string, timestamp: number) {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

export function MiniMaxUsageSection({ hasApiKey, defaultExpanded = false }: MiniMaxUsageSectionProps) {
  const { locale, t } = useI18n();
  const [usage, setUsage] = useState<MiniMaxUsageState>({ status: "idle" });
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async (force: boolean) => {
    const requestId = ++requestRef.current;
    setRefreshing(true);
    try {
      const snapshot = await window.miniMaxApi.getUsage(force ? { force: true } : undefined);
      if (requestRef.current === requestId) setUsage({ status: "ready", snapshot });
    } catch (error) {
      if (requestRef.current === requestId) {
        setUsage({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (requestRef.current === requestId) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!hasApiKey) return;
    setUsage({ status: "loading" });
    void refresh(false);
  }, [hasApiKey, refresh]);

  if (!hasApiKey) return null;

  const snapshot = usage.status === "ready" ? usage.snapshot : undefined;
  const currencySummary = snapshot?.summary?.kind === "currency" ? snapshot.summary : undefined;
  const primaryLimit = snapshot
    ? snapshot.limits.find(limit => limit.id === snapshot.primaryLimitId) ?? snapshot.limits[0]
    : undefined;

  const summaryLabel = usage.status === "loading"
    ? t("usage.miniMaxLoading")
    : usage.status === "error"
      ? t("settings.miniMaxUsageRetryHint")
      : currencySummary
        ? t("settings.miniMaxUsageBalanceSummary", { available: formatAmount(locale, currencySummary.available) })
        : t("settings.miniMaxUsagePlanSummary", { remaining: primaryLimit?.remainingPercent ?? 0 });
  const summaryClass = usage.status === "ready" && !currencySummary
    ? ` ${getRemainingClass(primaryLimit?.remainingPercent ?? 0)}`
    : "";

  return (
    <section className="minimax-usage-section" aria-label={t("settings.miniMaxUsageTitle")}>
      <div className="minimax-usage-header">
        {usage.status === "ready"
          ? <div
              className="minimax-usage-summary"
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpanded(value => !value); } }}
            >
              <span className={`collapsible-chevron${expanded ? "" : " collapsed"}`} aria-hidden="true">▾</span>
              <span className={`minimax-usage-summary-text${summaryClass}`}>{summaryLabel}</span>
            </div>
          : <span className={`minimax-usage-summary-text${summaryClass}`}>{summaryLabel}</span>}
        <button className="modal-button compact" type="button" disabled={refreshing} onClick={() => void refresh(true)}>
          {refreshing
            ? <LoaderCircle className="minimax-usage-spin" aria-hidden="true" />
            : <RefreshCw aria-hidden="true" />}
          {t("settings.miniMaxUsageRefresh")}
        </button>
      </div>
      {usage.status === "error" && <p className="settings-result error" role="alert">{usage.message}</p>}
      {expanded && snapshot && (currencySummary
        ? <div className="minimax-usage-details">
            <div className="agent-usage-credit-summary normal">
              <strong>{t("settings.miniMaxUsageBalanceSummary", { available: formatAmount(locale, currencySummary.available) })}</strong>
              <span>{t("usage.miniMaxBalanceDetails", {
                cash: formatAmount(locale, currencySummary.cash),
                voucher: formatAmount(locale, currencySummary.voucher),
                credit: formatAmount(locale, currencySummary.credit),
                owed: formatAmount(locale, currencySummary.owed)
              })}</span>
            </div>
            <small>{t("usage.updatedAt", { time: formatTimestamp(locale, snapshot.fetchedAt) })}</small>
          </div>
        : <div className="minimax-usage-details">
            {snapshot.limits.map(limit => (
              <div className={`agent-usage-limit ${getRemainingClass(limit.remainingPercent)}`} key={limit.id}>
                <div className="agent-usage-limit-heading">
                  <strong>{limit.name}</strong>
                  <span>{limit.unlimited ? t("usage.unlimited") : limit.available === false ? t("usage.notInPlan") : t("usage.limitRemaining", { remaining: limit.remainingPercent })}</span>
                </div>
                <div
                  className="agent-usage-progress"
                  role="progressbar"
                  aria-label={limit.name}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={limit.usedPercent}
                  aria-valuetext={t("usage.used", { used: limit.usedPercent })}
                >
                  <span style={{ width: `${limit.usedPercent}%` }} />
                </div>
                <div className="agent-usage-limit-meta">
                  <span>{limit.unlimited ? t("usage.unlimited") : limit.available === false ? t("usage.notInPlan") : t("usage.used", { used: limit.usedPercent })}</span>
                  <span>{limit.resetsAt
                    ? t("usage.resetsAt", { time: formatTimestamp(locale, limit.resetsAt) })
                    : t("usage.resetUnavailable")}</span>
                </div>
              </div>
            ))}
            <small>{t("usage.updatedAt", { time: formatTimestamp(locale, snapshot.fetchedAt) })}</small>
          </div>)}
    </section>
  );
}
