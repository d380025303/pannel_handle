import { useI18n } from "../../i18n";

type GraphicalAgentProvider = "codex" | "codebuddy" | "opencode" | "claude";

type AgentSessionModeCheckboxProps = {
  provider: GraphicalAgentProvider;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function AgentSessionModeCheckbox({ provider, checked, onChange }: AgentSessionModeCheckboxProps) {
  const { t } = useI18n();
  const mode = provider === "codex" ? "Codex App Server" : "ACP";

  return <div className="modal-field">
    <label className="modal-checkbox-field">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{t("session.graphicalMode")}</span>
    </label>
    <div className="settings-help">{t("session.graphicalModeHint", { mode })}</div>
  </div>;
}
