import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { AgentUsageSnapshot } from "../../vite-env";
import { CodeBuddyQuotaDetails } from "../agents/CodeBuddyQuotaDetails";

type QuotaState =
  | { status: "loading" }
  | { status: "ready"; snapshot: AgentUsageSnapshot; refreshing: boolean }
  | { status: "error"; message: string };

export function CodeBuddyQuotaSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<QuotaState>({ status: "loading" });
  const requestIdRef = useRef(0);

  const load = useCallback(async (force = false) => {
    const requestId = ++requestIdRef.current;
    setState(current => current.status === "ready"
      ? { ...current, refreshing: true }
      : { status: "loading" });
    try {
      const snapshot = await window.agentUsageApi.getCodeBuddyUsage({ force });
      if (requestIdRef.current === requestId) {
        setState({ status: "ready", snapshot, refreshing: false });
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
      window.agentUsageApi.cancelCodeBuddyUsage();
    };
  }, [load]);

  return (
    <section className="codebuddy-quota-settings" aria-label={t("usage.codebuddyTitle")}>
      <div className="codebuddy-quota-settings-header">
        <h5>{t("usage.codebuddyTitle")}</h5>
        <button
          type="button"
          className="icon-button"
          title={t("usage.refresh")}
          aria-label={t("usage.refresh")}
          disabled={state.status === "loading" || (state.status === "ready" && state.refreshing)}
          onClick={() => void load(true)}
        >
          <RefreshCw className={state.status === "ready" && state.refreshing ? "spin" : ""} aria-hidden="true" />
        </button>
      </div>
      {state.status === "loading" && (
        <div className="codebuddy-quota-state" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          <span>{t("usage.codebuddyLoading")}</span>
        </div>
      )}
      {state.status === "error" && (
        <div className="codebuddy-quota-error" role="alert">
          <span>{t("usage.codebuddyUnavailable")}</span>
          <small title={state.message}>{state.message}</small>
          <button className="modal-button compact" type="button" onClick={() => void load(true)}>{t("usage.codebuddyRetry")}</button>
        </div>
      )}
      {state.status === "ready" && (
        <div className="agent-usage-limit-list">
          <CodeBuddyQuotaDetails snapshot={state.snapshot} showUpdatedAt />
        </div>
      )}
    </section>
  );
}
