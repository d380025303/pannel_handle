import { useEffect, useMemo, useState } from "react";
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
  const [dingTalkEnabled, setDingTalkEnabled] = useState(false);
  const [hasWebhook, setHasWebhook] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [webhook, setWebhook] = useState("");
  const [secret, setSecret] = useState("");
  const [dingTalkBusy, setDingTalkBusy] = useState(false);
  const [dingTalkResult, setDingTalkResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
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

  useEffect(() => {
    let disposed = false;
    window.dingTalkApi.getConfig().then((config) => {
      if (disposed) return;
      setDingTalkEnabled(config.enabled);
      setHasWebhook(config.hasWebhook);
      setHasSecret(config.hasSecret);
    }).catch((err) => {
      if (!disposed) {
        setDingTalkResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  const saveDingTalkConfig = async () => {
    setDingTalkBusy(true);
    setDingTalkResult(null);
    try {
      const config = await window.dingTalkApi.setConfig({
        enabled: dingTalkEnabled,
        ...(webhook.trim() ? { webhook: webhook.trim() } : {}),
        ...(secret.trim() ? { secret: secret.trim() } : {})
      });
      setHasWebhook(config.hasWebhook);
      setHasSecret(config.hasSecret);
      setWebhook("");
      setSecret("");
      setDingTalkResult({ kind: "success", message: t("settings.dingTalkSaved") });
    } catch (err) {
      setDingTalkResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setDingTalkBusy(false);
    }
  };

  const clearDingTalkCredentials = async () => {
    setDingTalkBusy(true);
    setDingTalkResult(null);
    try {
      await window.dingTalkApi.clearCredentials();
      setDingTalkEnabled(false);
      setHasWebhook(false);
      setHasSecret(false);
      setWebhook("");
      setSecret("");
      setDingTalkResult({ kind: "success", message: t("settings.dingTalkCleared") });
    } catch (err) {
      setDingTalkResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setDingTalkBusy(false);
    }
  };

  const testDingTalk = async () => {
    setDingTalkBusy(true);
    setDingTalkResult(null);
    try {
      const result = await window.dingTalkApi.test();
      setDingTalkResult(result.ok
        ? { kind: "success", message: t("settings.dingTalkTestSuccess") }
        : { kind: "error", message: result.error });
    } catch (err) {
      setDingTalkResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setDingTalkBusy(false);
    }
  };

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
          <section className="settings-section ding-talk-settings">
            <h4>{t("settings.dingTalkTitle")}</h4>
            <p className="settings-help">{t("settings.dingTalkDescription")}</p>
            <label className="auto-restore-label">
              <input
                type="checkbox"
                className="auto-restore-checkbox"
                checked={dingTalkEnabled}
                disabled={dingTalkBusy}
                onChange={(event) => setDingTalkEnabled(event.target.checked)}
              />
              <span className="auto-restore-track" />
              <span className="auto-restore-text">{t("settings.dingTalkEnabled")}</span>
            </label>
            <label className="settings-field">
              <span className="modal-label">{t("settings.dingTalkWebhook")}</span>
              <input
                className="modal-input"
                type="password"
                value={webhook}
                disabled={dingTalkBusy}
                autoComplete="off"
                placeholder={hasWebhook ? t("settings.dingTalkConfigured") : "https://oapi.dingtalk.com/robot/send?access_token=..."}
                onChange={(event) => setWebhook(event.target.value)}
              />
            </label>
            <label className="settings-field">
              <span className="modal-label">{t("settings.dingTalkSecret")}</span>
              <input
                className="modal-input"
                type="password"
                value={secret}
                disabled={dingTalkBusy}
                autoComplete="off"
                placeholder={hasSecret ? t("settings.dingTalkConfigured") : t("settings.dingTalkSecretOptional")}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
            <div className="ding-talk-actions">
              <button className="modal-button primary" type="button" disabled={dingTalkBusy} onClick={saveDingTalkConfig}>
                {t("common.save")}
              </button>
              <button className="modal-button" type="button" disabled={dingTalkBusy || !hasWebhook} onClick={testDingTalk}>
                {t("settings.dingTalkTest")}
              </button>
              <button className="modal-button danger" type="button" disabled={dingTalkBusy || (!hasWebhook && !hasSecret)} onClick={clearDingTalkCredentials}>
                {t("settings.dingTalkClear")}
              </button>
            </div>
            {dingTalkResult && (
              <p className={`ding-talk-result ${dingTalkResult.kind}`} role="status">{dingTalkResult.message}</p>
            )}
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
