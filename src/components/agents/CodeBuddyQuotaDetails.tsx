import { useI18n } from "../../i18n";
import type { AgentUsageSnapshot } from "../../vite-env";

type CodeBuddyQuotaDetailsProps = {
  snapshot: AgentUsageSnapshot;
  showUpdatedAt?: boolean;
};

const CATEGORIES = ["base", "extra", "bonus", "organization", "other"] as const;

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

export function CodeBuddyQuotaDetails({ snapshot, showUpdatedAt = false }: CodeBuddyQuotaDetailsProps) {
  const { locale, t } = useI18n();
  const summary = snapshot.summary?.kind === "credits" ? snapshot.summary : undefined;
  const groupedLimits = CATEGORIES
    .map(category => ({ category, limits: snapshot.limits.filter(limit => limit.category === category) }))
    .filter(group => group.limits.length > 0);
  const primaryClass = getRemainingClass(summary?.remainingPercent ?? snapshot.limits[0]?.remainingPercent ?? 0);

  return (
    <>
      {summary && (
        <div className={`agent-usage-credit-summary ${primaryClass}`}>
          <strong>{t("usage.codebuddyTotal")}</strong>
          <span>{t("usage.creditRemaining", {
            remaining: formatAmount(locale, summary.remaining),
            total: formatAmount(locale, summary.total)
          })}</span>
        </div>
      )}
      {groupedLimits.length === 0 && (
        <div className="agent-usage-empty">{t("usage.noCreditResources")}</div>
      )}
      {groupedLimits.map(group => (
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
      ))}
      {showUpdatedAt && (
        <small className="codebuddy-quota-updated-at">{t("usage.updatedAt", { time: formatTimestamp(locale, snapshot.fetchedAt) })}</small>
      )}
    </>
  );
}
