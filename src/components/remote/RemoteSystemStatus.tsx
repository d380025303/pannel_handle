import { Activity, LoaderCircle } from "lucide-react";
import { useI18n } from "../../i18n";
import type { RemoteSystemMetricsState } from "../../hooks/useRemoteSystemMetrics";

export function RemoteSystemStatus({ state, active, onOpen }: {
  state: RemoteSystemMetricsState;
  active: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  if (state.status === "hidden") return null;
  const label = state.status === "loading" ? t("system.loading")
    : state.status === "error" ? t("system.unavailable") : t("system.metrics");

  return (
    <button
      className={`remote-system-status ${state.status}`}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onOpen}
    >
      {state.status === "loading" ? <LoaderCircle aria-hidden="true" /> : <Activity aria-hidden="true" />}
    </button>
  );
}
