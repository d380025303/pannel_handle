import type { AgentProvider } from "../../vite-env";
import { useI18n } from "../../i18n";
import { AGENT_PROVIDER_OPTIONS } from "./agentProviders";

type AgentProviderSelectProps = {
  value?: AgentProvider;
  exclude?: AgentProvider[];
  onChange: (provider?: AgentProvider) => void;
};

export function AgentProviderSelect({ value, exclude = [], onChange }: AgentProviderSelectProps) {
  const { t } = useI18n();
  const providers: Array<{ value?: AgentProvider; label: string }> = [
    { label: t("session.normalTerminal") },
    ...AGENT_PROVIDER_OPTIONS.filter((provider) => !exclude.includes(provider.value))
  ];
  return (
    <fieldset className="modal-field agent-provider-field">
      <legend className="modal-label">{t("session.agentCli")}</legend>
      <div className="shell-list agent-provider-list">
        {providers.map((provider) => (
          <button
            type="button"
            className={`shell-item ${value === provider.value ? "selected" : ""}`}
            key={provider.value || "terminal"}
            onClick={() => onChange(provider.value)}
          >
            {provider.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
