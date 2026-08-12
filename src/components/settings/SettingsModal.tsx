import { useEffect, useMemo, useState } from "react";
import { LOCALE_OPTIONS, useI18n } from "../../i18n";
import type { AppTheme } from "../../themes";
import type { Locale, ThemeId } from "../../vite-env";
import { SearchableSelect } from "../shared/SearchableSelect";
import { MobileAccessSettings } from "./MobileAccessSettings";

type SettingsModalProps = {
  autoRestore: boolean;
  debugMode: boolean;
  themeId: ThemeId;
  locale: Locale;
  themes: AppTheme[];
  agentOutputHistoryMaxEntries: number;
  agentOutputMaxBytes: number;
  onToggleAutoRestore: () => void;
  onToggleDebugMode: () => void;
  onThemeChange: (themeId: ThemeId) => void;
  onLocaleChange: (locale: Locale) => void;
  onSaveAgentOutputHistory: (maxEntries: number, maxOutputBytes: number) => Promise<void>;
  onCancel: () => void;
};

export function SettingsModal({
  autoRestore,
  debugMode,
  themeId,
  locale,
  themes,
  agentOutputHistoryMaxEntries,
  agentOutputMaxBytes,
  onToggleAutoRestore,
  onToggleDebugMode,
  onThemeChange,
  onLocaleChange,
  onSaveAgentOutputHistory,
  onCancel
}: SettingsModalProps) {
  const { t } = useI18n();
  const [dingTalkEnabled, setDingTalkEnabled] = useState(false);
  const [hasWebhook, setHasWebhook] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [webhook, setWebhook] = useState("");
  const [secret, setSecret] = useState("");
  const [dingTalkBusy, setDingTalkBusy] = useState(false);
  const [dingTalkOpen, setDingTalkOpen] = useState(false);
  const [dingTalkResult, setDingTalkResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [generalOpen, setGeneralOpen] = useState(true);
  const [agentLogOpen, setAgentLogOpen] = useState(false);
  const [agentHistoryMaxEntries, setAgentHistoryMaxEntries] = useState(String(agentOutputHistoryMaxEntries));
  const [agentOutputMaxKiB, setAgentOutputMaxKiB] = useState(String(agentOutputMaxBytes / 1024));
  const [agentLogBusy, setAgentLogBusy] = useState(false);
  const [agentLogResult, setAgentLogResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
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

  const saveAgentOutputHistory = async () => {
    const maxEntries = Number(agentHistoryMaxEntries);
    const maxOutputKiB = Number(agentOutputMaxKiB);
    const maxOutputBytes = maxOutputKiB * 1024;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000
      || !Number.isInteger(maxOutputKiB) || maxOutputKiB < 16 || maxOutputKiB > 16 * 1024) {
      setAgentLogResult({ kind: "error", message: t("settings.agentLogInvalid") });
      return;
    }
    setAgentLogBusy(true);
    setAgentLogResult(null);
    try {
      await onSaveAgentOutputHistory(maxEntries, maxOutputBytes);
      setAgentLogResult({ kind: "success", message: t("settings.agentLogSaved") });
    } catch (err) {
      setAgentLogResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setAgentLogBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog settings-dialog">
        <div className="modal-header">
          <h3>{t("settings.title")}</h3>
        </div>
        <div className="modal-body settings-body">
          <section className="settings-section general-settings">
            <div
              className="collapsible-header"
              role="button"
              tabIndex={0}
              aria-expanded={generalOpen}
              onClick={() => setGeneralOpen((value) => !value)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setGeneralOpen((value) => !value); } }}
            >
              <span className={`collapsible-chevron${generalOpen ? "" : " collapsed"}`} aria-hidden="true">▾</span>
              <h4>{t("settings.generalTitle")}</h4>
            </div>
            {generalOpen && (
              <>
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
              </>
            )}
          </section>
          <section className="settings-section agent-log-settings">
            <div
              className="collapsible-header"
              role="button"
              tabIndex={0}
              aria-expanded={agentLogOpen}
              onClick={() => setAgentLogOpen((value) => !value)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setAgentLogOpen((value) => !value); } }}
            >
              <span className={`collapsible-chevron${agentLogOpen ? "" : " collapsed"}`} aria-hidden="true">▾</span>
              <h4>{t("settings.agentLogTitle")}</h4>
            </div>
            {agentLogOpen && (
              <>
                <p className="settings-help">{t("settings.agentLogDescription")}</p>
                <label className="settings-field">
                  <span className="modal-label">{t("settings.agentLogHistoryMaxEntries")}</span>
                  <input
                    className="modal-input"
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={agentHistoryMaxEntries}
                    disabled={agentLogBusy}
                    onChange={(event) => setAgentHistoryMaxEntries(event.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span className="modal-label">{t("settings.agentLogOutputMaxKiB")}</span>
                  <input
                    className="modal-input"
                    type="number"
                    min="16"
                    max={16 * 1024}
                    step="1"
                    value={agentOutputMaxKiB}
                    disabled={agentLogBusy}
                    onChange={(event) => setAgentOutputMaxKiB(event.target.value)}
                  />
                </label>
                <p className="settings-help">{t("settings.agentLogRange")}</p>
                <div className="settings-actions">
                  <button className="modal-button primary" type="button" disabled={agentLogBusy} onClick={saveAgentOutputHistory}>
                    {t("common.save")}
                  </button>
                </div>
                {agentLogResult && <p className={`settings-result ${agentLogResult.kind}`} role="status">{agentLogResult.message}</p>}
              </>
            )}
          </section>
          <MobileAccessSettings />
          <section className="settings-section ding-talk-settings">
            <div
              className="collapsible-header"
              role="button"
              tabIndex={0}
              aria-expanded={dingTalkOpen}
              onClick={() => setDingTalkOpen((v) => !v)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDingTalkOpen((v) => !v); } }}
            >
              <span className={`collapsible-chevron${dingTalkOpen ? "" : " collapsed"}`}>▾</span>
              <h4>{t("settings.dingTalkTitle")}</h4>
              <label
                className="auto-restore-label ding-talk-toggle"
                onClick={(e) => e.stopPropagation()}
              >
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
            </div>
            {dingTalkOpen && (
              <>
                <p className="settings-help">{t("settings.dingTalkDescription")}</p>
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
              </>
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
