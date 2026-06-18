import { useEffect } from "react";
import { LOCALE_OPTIONS, useI18n } from "../i18n";
import type { AppTheme } from "../themes";
import type { Locale, ThemeId } from "../vite-env";

type SettingsModalProps = {
  autoRestore: boolean;
  debugMode: boolean;
  themeId: ThemeId;
  locale: Locale;
  themes: AppTheme[];
  onToggleAutoRestore: () => void;
  onToggleDebugMode: () => void;
  onThemeChange: (themeId: ThemeId) => void;
  onLocaleChange: (locale: Locale) => void;
  onCancel: () => void;
};

export function SettingsModal({
  autoRestore,
  debugMode,
  themeId,
  locale,
  themes,
  onToggleAutoRestore,
  onToggleDebugMode,
  onThemeChange,
  onLocaleChange,
  onCancel
}: SettingsModalProps) {
  const { t } = useI18n();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="modal-overlay">
      <div className="modal-dialog settings-dialog">
        <div className="modal-header">
          <h3>{t("settings.title")}</h3>
        </div>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <label className="auto-restore-label">
              <input
                type="checkbox"
                className="auto-restore-checkbox"
                checked={autoRestore}
                onChange={onToggleAutoRestore}
              />
              <span className="auto-restore-track" />
              <span className="auto-restore-text">{t("settings.autoRestore")}</span>
            </label>
            <label className="auto-restore-label">
              <input
                type="checkbox"
                className="auto-restore-checkbox"
                checked={debugMode}
                onChange={onToggleDebugMode}
              />
              <span className="auto-restore-track" />
              <span className="auto-restore-text">{t("settings.debugMode")}</span>
            </label>
            <label className="settings-field">
              <span className="modal-label">{t("settings.theme")}</span>
              <select
                className="modal-input settings-theme-select"
                value={themeId}
                onChange={(event) => onThemeChange(event.target.value as ThemeId)}
              >
                {themes.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {t(theme.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span className="modal-label">{t("settings.language")}</span>
              <select
                className="modal-input settings-theme-select"
                value={locale}
                onChange={(event) => onLocaleChange(event.target.value as Locale)}
              >
                {LOCALE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
            </label>
          </section>
        </div>
        <div className="modal-footer">
          <button className="modal-button primary" type="button" onClick={onCancel}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
