import { useEffect, useMemo } from "react";
import { LOCALE_OPTIONS, useI18n } from "../i18n";
import type { AppTheme } from "../themes";
import type { Locale, ThemeId } from "../vite-env";
import { SearchableSelect } from "./SearchableSelect";

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
  const themeOptions = useMemo(() => themes.map((theme) => ({
    value: theme.id,
    label: t(theme.labelKey)
  })), [t, themes]);
  const localeOptions = useMemo(() => LOCALE_OPTIONS.map((option) => ({
    value: option.id,
    label: t(option.labelKey)
  })), [t]);

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
            <div className="settings-field">
              <span className="modal-label">{t("settings.theme")}</span>
              <SearchableSelect
                className="settings-theme-select"
                value={themeId}
                options={themeOptions}
                ariaLabel={t("settings.theme")}
                onChange={(nextThemeId) => onThemeChange(nextThemeId as ThemeId)}
              />
            </div>
            <div className="settings-field">
              <span className="modal-label">{t("settings.language")}</span>
              <SearchableSelect
                className="settings-theme-select"
                value={locale}
                options={localeOptions}
                ariaLabel={t("settings.language")}
                onChange={(nextLocale) => onLocaleChange(nextLocale as Locale)}
              />
            </div>
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
