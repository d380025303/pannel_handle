import { useEffect, useMemo, useRef, useState } from "react";
import { Gauge, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentUsageLimit } from "../../vite-env";
import type { AgentUsageViewState } from "../../hooks/useAgentUsage";

type AgentUsageStatusProps = {
  state: AgentUsageViewState;
  onRefresh: () => void;
};

function getRemainingClass(remainingPercent: number) {
  if (remainingPercent <= 20) return "danger";
  if (remainingPercent < 50) return "warning";
  return "normal";
}

function formatTimestamp(locale: string, timestamp: number) {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function getPrimaryLimit(state: AgentUsageViewState): AgentUsageLimit | undefined {
  if (state.status !== "ready") return undefined;
  return state.snapshot.limits.find(limit => limit.id === state.snapshot.primaryLimitId)
    ?? state.snapshot.limits[0];
}

export function AgentUsageStatus({ state, onRefresh }: AgentUsageStatusProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const primaryLimit = useMemo(() => getPrimaryLimit(state), [state]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (state.status !== "ready") setOpen(false);
  }, [state.status]);

  if (state.status === "hidden") return null;

  if (state.status === "loading") {
    return (
      <div className="agent-usage-status loading" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
        <span>{t("usage.loading")}</span>
      </div>
    );
  }

  if (state.status === "error" || !primaryLimit) {
    return (
      <button className="agent-usage-status error" type="button" title={t("usage.retry")} onClick={onRefresh}>
        <Gauge aria-hidden="true" />
        <span>{t("usage.unavailable")}</span>
      </button>
    );
  }

  const primaryClass = getRemainingClass(primaryLimit.remainingPercent);
  const resetLabel = primaryLimit.resetsAt
    ? t("usage.resetsAt", { time: formatTimestamp(locale, primaryLimit.resetsAt) })
    : t("usage.resetUnavailable");

  return (
    <div className="agent-usage" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`agent-usage-status ${primaryClass}`}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${t("usage.remaining", { remaining: primaryLimit.remainingPercent })} · ${resetLabel}`}
        onClick={() => setOpen(value => !value)}
      >
        <Gauge aria-hidden="true" />
        <span>{t("usage.remaining", { remaining: primaryLimit.remainingPercent })}</span>
        {state.refreshing && <LoaderCircle className="spin agent-usage-refreshing" aria-label={t("usage.refreshing")} />}
      </button>

      {open && (
        <div className="agent-usage-popover" role="dialog" aria-label={t("usage.title")}>
          <div className="agent-usage-popover-header">
            <strong>{t("usage.title")}</strong>
            <span>
              <button type="button" title={t("usage.refresh")} aria-label={t("usage.refresh")} onClick={onRefresh} disabled={state.refreshing}>
                <RefreshCw className={state.refreshing ? "spin" : ""} aria-hidden="true" />
              </button>
              <button type="button" title={t("usage.close")} aria-label={t("usage.close")} onClick={() => setOpen(false)}>
                <X aria-hidden="true" />
              </button>
            </span>
          </div>
          <div className="agent-usage-limit-list">
            {state.snapshot.limits.map(limit => (
              <div className={`agent-usage-limit ${getRemainingClass(limit.remainingPercent)}`} key={limit.id}>
                <div className="agent-usage-limit-heading">
                  <strong>{limit.name}</strong>
                  <span>{t("usage.limitRemaining", { remaining: limit.remainingPercent })}</span>
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
                  <span>{t("usage.used", { used: limit.usedPercent })}</span>
                  <span>{limit.resetsAt
                    ? t("usage.resetsAt", { time: formatTimestamp(locale, limit.resetsAt) })
                    : t("usage.resetUnavailable")}</span>
                </div>
              </div>
            ))}
          </div>
          <small>{t("usage.updatedAt", { time: formatTimestamp(locale, state.snapshot.fetchedAt) })}</small>
        </div>
      )}
    </div>
  );
}
