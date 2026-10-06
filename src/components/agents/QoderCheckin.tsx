import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { QoderCheckinStatus } from "../../vite-env";

export function QoderCheckin({ onRefresh, accountId, refreshVersion = 0 }: {
  onRefresh: () => void; accountId?: string; refreshVersion?: number;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<QoderCheckinStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  async function run(claim = false) {
    if (claim && (busy || !status?.claimable || status.todayCheckedIn)) return;
    const id = ++request.current;
    setBusy(true);
    setError("");
    if (!claim) setStatus(undefined);
    try {
      const value = claim ? (await window.qoderCheckinApi.claim(accountId)).status : await window.qoderCheckinApi.getStatus(accountId);
      if (request.current !== id) return;
      if (accountId && value.accountId !== accountId) throw Error(t("usage.qoderAccountChanged"));
      setStatus(value);
      if (claim) onRefresh();
    } catch (failure) {
      if (request.current === id) {
        setStatus(undefined);
        const message = failure instanceof Error ? failure.message : "";
        setError(message && !message.startsWith("Error invoking remote method") ? message : t("usage.qoderCheckinFailed"));
      }
    } finally {
      if (request.current === id) setBusy(false);
    }
  }
  useEffect(() => { void run(); return () => { request.current += 1; }; }, [accountId, refreshVersion]);
  return <section className="workbuddy-checkin" aria-label={t("usage.qoderCheckinTitle")}>
    <strong>{t("usage.qoderCheckinTitle")}</strong>
    {status && <small>{t(accountId ? "usage.qoderUsageAccount" : "usage.qoderCheckinAccount", { account: status.accountLabel })}</small>}
    {busy && <div role="status">{t("usage.workbuddyCheckinLoading")}</div>}
    {error ? <div className="workbuddy-checkin-error" role="alert">
      <small>{error}</small><button disabled={busy} onClick={() => void run()}>{t("usage.workbuddyCheckinRetry")}</button>
    </div> : status && <div className="workbuddy-checkin-ready">
      <span>{status.todayCheckedIn ? t("usage.qoderCheckinClaimed", { credit: status.dailyCredit })
        : status.claimable ? t("usage.workbuddyCheckinReward", { credit: status.dailyCredit }) : t("usage.workbuddyCheckinInactive")}</span>
      <button disabled={busy || !status.claimable || status.todayCheckedIn} onClick={() => void run(true)}>
        {busy ? t("usage.workbuddyCheckingIn") : status.todayCheckedIn ? t("usage.workbuddyCheckedInButton") : t("usage.workbuddyCheckinButton")}
      </button>
    </div>}
  </section>;
}
