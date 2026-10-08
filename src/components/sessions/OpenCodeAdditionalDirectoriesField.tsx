import { useI18n } from "../../i18n";

export function OpenCodeAdditionalDirectoriesField({ value, onChange, windows, disabled }: {
  value: string; onChange: (value: string) => void; windows: boolean; disabled: boolean;
}) {
  const { t } = useI18n();
  return <label className="modal-field">
    <span className="modal-label">{t("session.openCodeAdditionalDirectories")}</span>
    <textarea className="modal-input modal-textarea" rows={3} value={value} disabled={disabled}
      placeholder={windows ? "C:\\projects\\shared" : "/work/shared"} onChange={event => onChange(event.target.value)} />
    <span className="modal-hint">{t(windows ? "session.openCodeDirectoriesWindows" : "session.openCodeDirectoriesPosix")}</span>
    <span className="modal-hint">{t("session.openCodeDirectoriesHint")}</span>
  </label>;
}
