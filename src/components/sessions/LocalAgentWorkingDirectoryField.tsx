import { useI18n } from "../../i18n";

type LocalAgentWorkingDirectoryFieldProps = {
  value: string;
  onChange: (value: string) => void;
};

export function LocalAgentWorkingDirectoryField({ value, onChange }: LocalAgentWorkingDirectoryFieldProps) {
  const { t } = useI18n();

  const chooseDirectory = async () => {
    const selection = await window.hookConfigApi.selectProjectDirectory(value || undefined);
    if (!selection.canceled) onChange(selection.path);
  };

  return (
    <label className="modal-field">
      <span className="modal-label">{t("session.localAgentCwd")}</span>
      <div className="local-agent-path-row">
        <input
          className="modal-input"
          value={value}
          readOnly
          placeholder={t("session.localAgentCwdPlaceholder")}
        />
        <button className="modal-button" type="button" onClick={() => void chooseDirectory()}>
          {t("common.select")}
        </button>
        {value && (
          <button className="modal-button" type="button" onClick={() => onChange("")}>
            {t("common.clear")}
          </button>
        )}
      </div>
      <span className="modal-hint">{t("session.localAgentCwdHint")}</span>
    </label>
  );
}
