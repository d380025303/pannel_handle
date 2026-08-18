import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Gauge, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentUsageLimit, WorkBuddyCheckinStatus } from "../../vite-env";
import type { AgentUsageViewState } from "../../hooks/useAgentUsage";

type AgentUsageStatusProps = {
  state: AgentUsageViewState;
  onRefresh: () => void;
};

type WorkBuddyCheckinViewState =
  | { status: "idle" | "loading" }
  | { status: "ready"; value: WorkBuddyCheckinStatus }
  | { status: "error"; message: string };

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

function formatAmount(locale: string, amount: number) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount);
}

function getPrimaryLimit(state: AgentUsageViewState): AgentUsageLimit | undefined {
  if (state.status !== "ready") return undefined;
  return state.snapshot.limits.find(limit => limit.id === state.snapshot.primaryLimitId)
    ?? state.snapshot.limits[0];
}

export function AgentUsageStatus({ state, onRefresh }: AgentUsageStatusProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [checkinState, setCheckinState] = useState<WorkBuddyCheckinViewState>({ status: "idle" });
  const [checkinBusy, setCheckinBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const checkinRequestRef = useRef(0);
  const primaryLimit = useMemo(() => getPrimaryLimit(state), [state]);
  const provider = state.status === "ready" ? state.snapshot.provider : state.status === "hidden" ? undefined : state.provider;
  const isCodeBuddy = provider === "codebuddy";
  const creditSummary = state.status === "ready" && state.snapshot.summary?.kind === "credits"
    ? state.snapshot.summary
    : undefined;

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

  const loadWorkBuddyCheckin = useCallback(async () => {
    const requestId = ++checkinRequestRef.current;
    setCheckinState({ status: "loading" });
    try {
      const value = await window.workBuddyCheckinApi.getStatus();
      if (checkinRequestRef.current === requestId) setCheckinState({ status: "ready", value });
    } catch (error) {
      if (checkinRequestRef.current === requestId) {
        setCheckinState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, []);

  useEffect(() => {
    if (open && isCodeBuddy) void loadWorkBuddyCheckin();
    if (!open) {
      checkinRequestRef.current += 1;
      setCheckinBusy(false);
    }
  }, [isCodeBuddy, loadWorkBuddyCheckin, open]);

  if (state.status === "hidden") return null;

  if (state.status === "loading") {
    return (
      <div className="agent-usage-status loading" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
        <span>{t(isCodeBuddy ? "usage.codebuddyLoading" : "usage.loading")}</span>
      </div>
    );
  }

  if (state.status === "error" || (!isCodeBuddy && !primaryLimit)) {
    return (
      <button
        className="agent-usage-status error"
        type="button"
        title={t(isCodeBuddy ? "usage.codebuddyRetry" : "usage.retry")}
        onClick={onRefresh}
      >
        <Gauge aria-hidden="true" />
        <span>{t(isCodeBuddy ? "usage.codebuddyUnavailable" : "usage.unavailable")}</span>
      </button>
    );
  }

  const remainingPercent = creditSummary?.remainingPercent ?? primaryLimit?.remainingPercent ?? 0;
  const primaryClass = getRemainingClass(remainingPercent);
  const resetLabel = primaryLimit?.resetsAt
    ? t("usage.resetsAt", { time: formatTimestamp(locale, primaryLimit.resetsAt) })
    : t("usage.resetUnavailable");
  const triggerLabel = creditSummary
    ? t("usage.codebuddyRemaining", { remaining: formatAmount(locale, creditSummary.remaining) })
    : t("usage.remaining", { remaining: primaryLimit?.remainingPercent ?? 0 });
  const dialogTitle = t(isCodeBuddy ? "usage.codebuddyTitle" : "usage.title");
  const groupedLimits = state.status === "ready" && isCodeBuddy
    ? (["base", "extra", "bonus", "other"] as const)
      .map(category => ({ category, limits: state.snapshot.limits.filter(limit => limit.category === category) }))
      .filter(group => group.limits.length > 0)
    : [];

  const claimWorkBuddyCheckin = async () => {
    if (checkinBusy || checkinState.status !== "ready" || checkinState.value.todayCheckedIn) return;
    const requestId = ++checkinRequestRef.current;
    setCheckinBusy(true);
    try {
      const result = await window.workBuddyCheckinApi.claim();
      if (checkinRequestRef.current === requestId) {
        setCheckinState({ status: "ready", value: result.status });
        onRefresh();
      }
    } catch (error) {
      if (checkinRequestRef.current === requestId) {
        setCheckinState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (checkinRequestRef.current === requestId) setCheckinBusy(false);
    }
  };

  return (
    <div className="agent-usage" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`agent-usage-status ${primaryClass}`}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={creditSummary ? triggerLabel : `${triggerLabel} · ${resetLabel}`}
        onClick={() => setOpen(value => !value)}
      >
        <Gauge aria-hidden="true" />
        <span>{triggerLabel}</span>
        {state.refreshing && <LoaderCircle className="spin agent-usage-refreshing" aria-label={t("usage.refreshing")} />}
      </button>

      {open && (
        <div className="agent-usage-popover" role="dialog" aria-label={dialogTitle}>
          <div className="agent-usage-popover-header">
            <strong>{dialogTitle}</strong>
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
            {isCodeBuddy && creditSummary && (
              <div className={`agent-usage-credit-summary ${primaryClass}`}>
                <strong>{t("usage.codebuddyTotal")}</strong>
                <span>{t("usage.creditRemaining", {
                  remaining: formatAmount(locale, creditSummary.remaining),
                  total: formatAmount(locale, creditSummary.total)
                })}</span>
              </div>
            )}
            {isCodeBuddy && (
              <section className="workbuddy-checkin" aria-label={t("usage.workbuddyCheckinTitle")}>
                <div className="workbuddy-checkin-heading">
                  <strong>{t("usage.workbuddyCheckinTitle")}</strong>
                  {checkinState.status === "ready" && checkinState.value.todayCheckedIn && <CheckCircle2 aria-hidden="true" />}
                </div>
                {checkinState.status === "loading" && (
                  <div className="workbuddy-checkin-state" role="status">
                    <LoaderCircle className="spin" aria-hidden="true" />
                    <span>{t("usage.workbuddyCheckinLoading")}</span>
                  </div>
                )}
                {checkinState.status === "error" && (
                  <div className="workbuddy-checkin-error" role="alert">
                    <span>{t("usage.workbuddyCheckinUnavailable")}</span>
                    <small title={checkinState.message}>{checkinState.message}</small>
                    <button type="button" onClick={() => void loadWorkBuddyCheckin()}>{t("usage.workbuddyCheckinRetry")}</button>
                  </div>
                )}
                {checkinState.status === "ready" && !checkinState.value.active && (
                  <div className="workbuddy-checkin-state">{t("usage.workbuddyCheckinInactive")}</div>
                )}
                {checkinState.status === "ready" && checkinState.value.active && (
                  <div className="workbuddy-checkin-ready">
                    <span>{checkinState.value.todayCheckedIn
                      ? t("usage.workbuddyCheckedIn", {
                        credit: formatAmount(locale, checkinState.value.todayCredit),
                        days: checkinState.value.streakDays
                      })
                      : t("usage.workbuddyCheckinReward", {
                        credit: formatAmount(locale, checkinState.value.dailyCredit)
                      })}</span>
                    <button
                      type="button"
                      disabled={checkinBusy || checkinState.value.todayCheckedIn}
                      onClick={() => void claimWorkBuddyCheckin()}
                    >
                      {checkinBusy
                        ? t("usage.workbuddyCheckingIn")
                        : checkinState.value.todayCheckedIn
                          ? t("usage.workbuddyCheckedInButton")
                          : t("usage.workbuddyCheckinButton")}
                    </button>
                  </div>
                )}
              </section>
            )}
            {isCodeBuddy && groupedLimits.length === 0 && (
              <div className="agent-usage-empty">{t("usage.noCreditResources")}</div>
            )}
            {isCodeBuddy ? groupedLimits.map(group => (
              <section className="agent-usage-limit-group" key={group.category}>
                <h4>{t(`usage.category.${group.category}`)}</h4>
                {group.limits.map(limit => (
                  <div className={`agent-usage-limit ${getRemainingClass(limit.remainingPercent)}`} key={limit.id}>
                    <div className="agent-usage-limit-heading">
                      <strong>{limit.name}</strong>
                      <span>{t("usage.creditRemaining", {
                        remaining: formatAmount(locale, limit.remainingAmount ?? 0),
                        total: formatAmount(locale, limit.totalAmount ?? 0)
                      })}</span>
                    </div>
                    <div
                      className="agent-usage-progress"
                      role="progressbar"
                      aria-label={limit.name}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={limit.usedPercent}
                      aria-valuetext={t("usage.creditUsed", {
                        used: formatAmount(locale, limit.usedAmount ?? 0),
                        total: formatAmount(locale, limit.totalAmount ?? 0)
                      })}
                    >
                      <span style={{ width: `${limit.usedPercent}%` }} />
                    </div>
                    <div className="agent-usage-limit-meta">
                      <span>{t("usage.creditUsed", {
                        used: formatAmount(locale, limit.usedAmount ?? 0),
                        total: formatAmount(locale, limit.totalAmount ?? 0)
                      })}</span>
                      <span>{limit.expiresAt
                        ? t("usage.expiresAt", { time: formatTimestamp(locale, limit.expiresAt) })
                        : t("usage.expirationUnavailable")}</span>
                    </div>
                  </div>
                ))}
              </section>
            )) : state.snapshot.limits.map(limit => (
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
