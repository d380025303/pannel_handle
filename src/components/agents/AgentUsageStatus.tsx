import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Gauge, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentUsageLimit, AgentUsageResetResult, WorkBuddyCheckinStatus } from "../../vite-env";
import type { AgentUsageViewState } from "../../hooks/useAgentUsage";

type AgentUsageStatusProps = {
  state: AgentUsageViewState;
  onRefresh: () => void;
  onConsumeResetCredit?: (creditId: string, idempotencyKey: string) => Promise<AgentUsageResetResult | undefined>;
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

export function AgentUsageStatus({ state, onRefresh, onConsumeResetCredit = async () => undefined }: AgentUsageStatusProps) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [checkinState, setCheckinState] = useState<WorkBuddyCheckinViewState>({ status: "idle" });
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [confirmResetCreditId, setConfirmResetCreditId] = useState("");
  const [resetCreditBusyId, setResetCreditBusyId] = useState("");
  const [resetCreditFeedback, setResetCreditFeedback] = useState<{ creditId: string; kind: "success" | "info" | "error"; message: string }>();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const checkinRequestRef = useRef(0);
  const resetCreditRequestRef = useRef(0);
  const resetCreditAttemptRef = useRef<{ creditId: string; idempotencyKey: string } | undefined>(undefined);
  const primaryLimit = useMemo(() => getPrimaryLimit(state), [state]);
  const provider = state.status === "ready" ? state.snapshot.provider : state.status === "hidden" ? undefined : state.provider;
  const isCodeBuddy = provider === "codebuddy";
  const isQoder = provider === "qoder";
  const isCopilot = provider === "copilot";
  const isGemini = provider === "gemini";
  const isGrok = provider === "grok";
  const isCreditProvider = isCodeBuddy || isQoder;
  const creditSummary = state.status === "ready" && state.snapshot.summary?.kind === "credits"
    ? state.snapshot.summary
    : undefined;
  const resetCredits = state.status === "ready" && state.snapshot.provider === "codex"
    ? state.snapshot.resetCredits
    : undefined;
  const activities = state.status === "ready" && state.snapshot.provider === "qoder"
    ? state.snapshot.activities ?? []
    : [];
  const activityError = state.status === "ready" && state.snapshot.provider === "qoder"
    ? state.snapshot.activityError
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
      setConfirmResetCreditId("");
    }
  }, [isCodeBuddy, loadWorkBuddyCheckin, open]);

  useEffect(() => {
    if (provider === "codex") return;
    resetCreditRequestRef.current += 1;
    resetCreditAttemptRef.current = undefined;
    setConfirmResetCreditId("");
    setResetCreditBusyId("");
    setResetCreditFeedback(undefined);
  }, [provider]);

  if (state.status === "hidden") return null;

  if (state.status === "loading") {
    return (
      <div className="agent-usage-status loading" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
        <span>{t(isCodeBuddy ? "usage.codebuddyLoading" : isQoder ? "usage.qoderLoading" : isGemini ? "usage.geminiLoading" : "usage.loading")}</span>
      </div>
    );
  }

  if (state.status === "error" || (!isCreditProvider && !primaryLimit)) {
    return (
      <button
        className="agent-usage-status error"
        type="button"
        title={t(isCopilot ? "usage.copilotUnavailable" : isGrok ? "usage.grokUnavailable" : isCodeBuddy ? "usage.codebuddyRetry" : isQoder ? "usage.qoderRetry" : isGemini ? "usage.geminiRetry" : "usage.retry")}
        onClick={onRefresh}
        disabled={isCopilot || isGrok}
      >
        <Gauge aria-hidden="true" />
        <span>{t(isCopilot ? "usage.copilotUnavailable" : isGrok ? "usage.grokUnavailable" : isCodeBuddy ? "usage.codebuddyUnavailable" : isQoder ? "usage.qoderUnavailable" : isGemini ? "usage.geminiUnavailable" : "usage.unavailable")}</span>
      </button>
    );
  }

  const remainingPercent = creditSummary?.remainingPercent ?? primaryLimit?.remainingPercent ?? 0;
  const primaryClass = getRemainingClass(remainingPercent);
  const resetLabel = primaryLimit?.resetsAt
    ? t("usage.resetsAt", { time: formatTimestamp(locale, primaryLimit.resetsAt) })
    : t("usage.resetUnavailable");
  const triggerLabel = creditSummary
    ? t(isQoder ? "usage.qoderRemaining" : "usage.codebuddyRemaining", { remaining: formatAmount(locale, creditSummary.remaining) })
    : t("usage.remaining", { remaining: primaryLimit?.remainingPercent ?? 0 });
  const dialogTitle = t(isCodeBuddy ? "usage.codebuddyTitle" : isQoder ? "usage.qoderTitle" : isGemini ? "usage.geminiTitle" : "usage.title");
  const groupedLimits = state.status === "ready" && isCreditProvider
    ? (["base", "extra", "bonus", "organization", "other"] as const)
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

  const consumeResetCredit = async (creditId: string) => {
    if (resetCreditBusyId) return;
    const retryAttempt = resetCreditAttemptRef.current?.creditId === creditId
      ? resetCreditAttemptRef.current
      : undefined;
    if (!retryAttempt && confirmResetCreditId !== creditId) {
      resetCreditAttemptRef.current = undefined;
      setResetCreditFeedback(undefined);
      setConfirmResetCreditId(creditId);
      return;
    }

    const attempt = retryAttempt ?? { creditId, idempotencyKey: crypto.randomUUID() };
    resetCreditAttemptRef.current = attempt;
    setConfirmResetCreditId("");
    setResetCreditBusyId(creditId);
    setResetCreditFeedback(undefined);
    const requestId = ++resetCreditRequestRef.current;
    try {
      const result = await onConsumeResetCredit(creditId, attempt.idempotencyKey);
      if (resetCreditRequestRef.current !== requestId || !result) return;
      resetCreditAttemptRef.current = undefined;
      const outcomeKey = result.outcome === "reset"
        ? "usage.resetCreditSuccess"
        : result.outcome === "alreadyRedeemed"
          ? "usage.resetCreditAlreadyRedeemed"
          : result.outcome === "nothingToReset"
            ? "usage.resetCreditNothingToReset"
            : "usage.resetCreditNoCredit";
      setResetCreditFeedback({
        creditId,
        kind: result.outcome === "reset" || result.outcome === "alreadyRedeemed" ? "success" : "info",
        message: result.refreshError
          ? t("usage.resetCreditRefreshFailed", { result: t(outcomeKey), message: result.refreshError })
          : t(outcomeKey)
      });
    } catch (error) {
      if (resetCreditRequestRef.current === requestId) {
        setResetCreditFeedback({
          creditId,
          kind: "error",
          message: t("usage.resetCreditFailed", { message: error instanceof Error ? error.message : String(error) })
        });
      }
    } finally {
      if (resetCreditRequestRef.current === requestId) setResetCreditBusyId("");
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
            {isCreditProvider && creditSummary && (
              <div className={`agent-usage-credit-summary ${primaryClass}`}>
                <strong>{t(isQoder ? "usage.qoderTotal" : "usage.codebuddyTotal")}</strong>
                <span>{t("usage.creditRemaining", {
                  remaining: formatAmount(locale, creditSummary.remaining),
                  total: formatAmount(locale, creditSummary.total)
                })}</span>
              </div>
            )}
            {resetCredits && (
              <section className="codex-reset-credits" aria-label={t("usage.resetCreditsTitle")}>
                <div className="codex-reset-credits-heading">
                  <strong>{t("usage.resetCreditsTitle")}</strong>
                  <span>{t("usage.resetCreditsAvailable", { count: resetCredits.availableCount })}</span>
                </div>
                {resetCredits.availableCount === 0 && (
                  <div className="agent-usage-empty">{t("usage.resetCreditsEmpty")}</div>
                )}
                {resetCredits.availableCount > 0 && (!resetCredits.credits || resetCredits.credits.length === 0) && (
                  <div className="agent-usage-empty">{t("usage.resetCreditDetailsUnavailable")}</div>
                )}
                {resetCredits.credits?.map(credit => (
                  <article className="codex-reset-credit" key={credit.id}>
                    <div className="codex-reset-credit-heading">
                      <strong>{credit.title || t("usage.resetCreditFallback")}</strong>
                      <span className={`codex-reset-credit-status ${credit.status}`}>
                        {t(`usage.resetCreditStatus.${credit.status}`)}
                      </span>
                    </div>
                    {credit.description && <p>{credit.description}</p>}
                    <div className="codex-reset-credit-meta">
                      <span>{t("usage.resetCreditGrantedAt", { time: formatTimestamp(locale, credit.grantedAt) })}</span>
                      <span>{credit.expiresAt
                        ? t("usage.resetCreditExpiresAt", { time: formatTimestamp(locale, credit.expiresAt) })
                        : t("usage.resetCreditNoExpiration")}</span>
                    </div>
                    {credit.status === "available" && credit.resetType === "codexRateLimits" && (
                      <div className="codex-reset-credit-action">
                        <button
                          type="button"
                          className={confirmResetCreditId === credit.id ? "confirm" : ""}
                          disabled={Boolean(resetCreditBusyId) || Boolean(
                            resetCreditAttemptRef.current
                            && resetCreditAttemptRef.current.creditId !== credit.id
                          )}
                          onBlur={() => setConfirmResetCreditId(current => current === credit.id ? "" : current)}
                          onClick={() => void consumeResetCredit(credit.id)}
                        >
                          {resetCreditBusyId === credit.id
                            ? t("usage.resetCreditResetting")
                            : resetCreditAttemptRef.current?.creditId === credit.id
                              ? t("usage.resetCreditRetry")
                              : confirmResetCreditId === credit.id
                                ? t("usage.resetCreditConfirm")
                                : t("usage.resetCreditAction")}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
                {resetCreditFeedback && (
                  <div className={`codex-reset-credit-feedback ${resetCreditFeedback.kind}`} role={resetCreditFeedback.kind === "error" ? "alert" : "status"}>
                    {resetCreditFeedback.message}
                  </div>
                )}
              </section>
            )}
            {!resetCredits && resetCreditFeedback && (
              <div className={`codex-reset-credit-feedback ${resetCreditFeedback.kind}`} role={resetCreditFeedback.kind === "error" ? "alert" : "status"}>
                {resetCreditFeedback.message}
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
            {isCreditProvider && groupedLimits.length === 0 && (
              <div className="agent-usage-empty">{t("usage.noCreditResources")}</div>
            )}
            {isCreditProvider ? groupedLimits.map(group => (
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
                        : limit.available === false
                          ? t("usage.resourceUnavailable")
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
            {isQoder && (
              <section className="agent-usage-limit-group qoder-activity-quota" aria-label={t("usage.qoderActivities")}>
                <h4>{t("usage.qoderActivities")}</h4>
                {activityError ? (
                  <div className="agent-usage-empty" role="status" title={activityError}>
                    {t("usage.qoderActivityUnavailable")}
                  </div>
                ) : activities.length === 0 ? (
                  <div className="agent-usage-empty">{t("usage.qoderActivityEmpty")}</div>
                ) : activities.map(activity => (
                  <div
                    className={`agent-usage-limit ${getRemainingClass(activity.remainingPercent)}`}
                    key={activity.id}
                    title={activity.description}
                  >
                    <div className="agent-usage-limit-heading">
                      <strong>{activity.name}{activity.tag ? ` · ${activity.tag}` : ""}</strong>
                      <span>{t("usage.activityRemaining", {
                        remaining: formatAmount(locale, activity.remainingAmount)
                      })}</span>
                    </div>
                    <div
                      className="agent-usage-progress"
                      role="progressbar"
                      aria-label={activity.name}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={activity.usedPercent}
                      aria-valuetext={t("usage.activityUsed", {
                        used: formatAmount(locale, activity.usedAmount),
                        total: formatAmount(locale, activity.totalAmount)
                      })}
                    >
                      <span style={{ width: `${activity.usedPercent}%` }} />
                    </div>
                    <div className="agent-usage-limit-meta">
                      <span>{t("usage.activityUsed", {
                        used: formatAmount(locale, activity.usedAmount),
                        total: formatAmount(locale, activity.totalAmount)
                      })}</span>
                      <span>{activity.expiresAt
                        ? t("usage.activityExpiresAt", { time: formatTimestamp(locale, activity.expiresAt) })
                        : t("usage.activityNoExpiration")}</span>
                    </div>
                  </div>
                ))}
              </section>
            )}
          </div>
          <small>{t("usage.updatedAt", { time: formatTimestamp(locale, state.snapshot.fetchedAt) })}</small>
        </div>
      )}
    </div>
  );
}
