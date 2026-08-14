import type { AgentLocation, AgentProvider } from "../../vite-env";
import { useI18n } from "../../i18n";

type AgentLocationSelectProps = {
  value: AgentLocation;
  provider: AgentProvider;
  onChange: (value: AgentLocation) => void;
};

export function AgentLocationSelect({ value, provider, onChange }: AgentLocationSelectProps) {
  const { t } = useI18n();
  const localAvailable = provider === "codex";
  return (
    <fieldset className="modal-field agent-location-field">
      <legend className="modal-label">{t("session.agentLocation")}</legend>
      <div className="shell-list agent-provider-list">
        <button
          type="button"
          className={`shell-item ${value === "local" ? "selected" : ""}`}
          disabled={!localAvailable}
          title={localAvailable ? t("session.agentLocationLocalHint") : t("session.agentLocationCodexOnly")}
          onClick={() => onChange("local")}
        >
          {t("session.agentLocationLocal")}
        </button>
        <button
          type="button"
          className={`shell-item ${value === "remote" ? "selected" : ""}`}
          onClick={() => onChange("remote")}
        >
          {t("session.agentLocationRemote")}
        </button>
      </div>
    </fieldset>
  );
}
