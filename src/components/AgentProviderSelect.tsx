import type { AgentProvider } from "../vite-env";
import { useI18n } from "../i18n";

type AgentProviderSelectProps = {
  value?: AgentProvider;
  onChange: (provider?: AgentProvider) => void;
};

const providers: Array<{ value?: AgentProvider; label: string }> = [
  { label: "Terminal" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "qoder", label: "Qoder" }
];

export function AgentProviderSelect({ value, onChange }: AgentProviderSelectProps) {
  const { t } = useI18n();
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
            {provider.value ? provider.label : t("session.normalTerminal")}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
