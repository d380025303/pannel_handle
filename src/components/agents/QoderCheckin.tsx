import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { QoderCheckinStatus } from "../../vite-env";

export function QoderCheckin({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<QoderCheckinStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  async function run(claim = false) {
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const value = claim ? (await window.qoderCheckinApi.claim()).status : await window.qoderCheckinApi.getStatus();
      if (request.current !== id) return;
      setStatus(value);
      if (claim) onRefresh();
    } catch (failure) {
      if (request.current === id) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === id) setBusy(false);
    }
  }
  useEffect(() => { void run(); return () => { request.current += 1; }; }, []);
  return <section className="workbuddy-checkin" aria-label={t("usage.qoderCheckinTitle")}>
    <strong>{t("usage.qoderCheckinTitle")}</strong>
    {status && <small>{t("usage.qoderCheckinAccount", { account: status.accountLabel })}</small>}
    {busy && <div role="status">{t("usage.workbuddyCheckinLoading")}</div>}
    {error ? <div className="workbuddy-checkin-error" role="alert">
      <small>{error}</small><button disabled={busy} onClick={() => void run()}>{t("usage.workbuddyCheckinRetry")}</button>
    </div> : status && <div className="workbuddy-checkin-ready">
      <span>{status.todayCheckedIn ? t("usage.qoderCheckinClaimed", { credit: status.dailyCredit })
        : status.claimable ? t("usage.workbuddyCheckinReward", { credit: status.dailyCredit }) : t("usage.workbuddyCheckinInactive")}</span>
      <button disabled={busy || !status.claimable} onClick={() => void run(true)}>
        {busy ? t("usage.workbuddyCheckingIn") : status.todayCheckedIn ? t("usage.workbuddyCheckedInButton") : t("usage.workbuddyCheckinButton")}
      </button>
    </div>}
  </section>;
}
