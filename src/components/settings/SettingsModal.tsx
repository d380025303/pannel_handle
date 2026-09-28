import { Bell, Bot, Braces, Database, Settings as SettingsIcon, Smartphone, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { EnvironmentSettings, type EnvironmentSettingsHandle } from "../environment/EnvironmentSettings";
import { LOCALE_OPTIONS, useI18n } from "../../i18n";
import type { AppTheme } from "../../themes";
import type { Locale, ThemeId, TitleBarActionId, WindowsShell } from "../../vite-env";
import { SearchableSelect } from "../shared/SearchableSelect";
import { MobileAccessSettings } from "./MobileAccessSettings";
import { OpenRouterSettings } from "./OpenRouterSettings";
import { CodeBuddyCodexSettings } from "./CodeBuddyCodexSettings";
import { PostgresBackupSettings } from "./PostgresBackupSettings";
import { WINDOWS_SHELL_OPTIONS } from "../../utils/windowsShell";
import { screenshotShortcutFromKeyboardEvent } from "../../utils/screenshotShortcut";
import { getTerminalBackgroundUrl } from "../../utils/terminalBackground";
import { TitleBarActionSettings } from "./TitleBarActionSettings";

type SettingsModalProps = {
  defaultWindowsShell: WindowsShell;
  onDefaultWindowsShellChange: (value: WindowsShell) => Promise<void>;
  autoRestore: boolean;
  autoWorkBuddyCheckin: boolean;
  debugMode: boolean;
  screenshotEnabled: boolean;
  screenshotShortcut: string;
  titleBarActionOrder: TitleBarActionId[];
  titleBarHiddenActions: TitleBarActionId[];
  onTitleBarActionsChange: (change: { titleBarActionOrder?: TitleBarActionId[]; titleBarHiddenActions?: TitleBarActionId[] }) => Promise<void>;
  themeId: ThemeId;
  locale: Locale;
  themes: AppTheme[];
  onToggleAutoRestore: () => void;
  onToggleAutoWorkBuddyCheckin: () => void;
  onToggleDebugMode: () => void;
  onScreenshotEnabledChange: (enabled: boolean) => Promise<void>;
  onScreenshotShortcutChange: (shortcut: string) => Promise<void>;
  onThemeChange: (themeId: ThemeId) => void;
  onLocaleChange: (locale: Locale) => void;
  terminalBackgroundImage: string;
  terminalBackgroundOpacity: number;
  terminalBackgroundBlur: number;
  terminalBackgroundPositionX: number;
  terminalBackgroundPositionY: number;
  onChooseTerminalBackground: () => Promise<void>;
  onClearTerminalBackground: () => Promise<void>;
  onTerminalBackgroundOpacityChange: (value: number) => void;
  onTerminalBackgroundBlurChange: (value: number) => void;
  onTerminalBackgroundPositionPreview: (x: number, y: number) => void;
  onTerminalBackgroundPositionCommit: (x: number, y: number) => Promise<void>;
  onCancel: () => void;
};

type SettingsCategory = "general" | "environment" | "models" | "mobile" | "notifications" | "backup";

export function SettingsModal({
  defaultWindowsShell,
  onDefaultWindowsShellChange,
  autoRestore,
  autoWorkBuddyCheckin,
  debugMode,
  screenshotEnabled,
  screenshotShortcut,
  titleBarActionOrder,
  titleBarHiddenActions,
  onTitleBarActionsChange,
  themeId,
  locale,
  themes,
  onToggleAutoRestore,
  onToggleAutoWorkBuddyCheckin,
  onToggleDebugMode,
  onScreenshotEnabledChange,
  onScreenshotShortcutChange,
  onThemeChange,
  onLocaleChange,
  terminalBackgroundImage,
  terminalBackgroundOpacity,
  terminalBackgroundBlur,
  terminalBackgroundPositionX,
  terminalBackgroundPositionY,
  onChooseTerminalBackground,
  onClearTerminalBackground,
  onTerminalBackgroundOpacityChange,
  onTerminalBackgroundBlurChange,
  onTerminalBackgroundPositionPreview,
  onTerminalBackgroundPositionCommit,
  onCancel
}: SettingsModalProps) {
  const { t } = useI18n();
  const environmentRef = useRef<EnvironmentSettingsHandle>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const [environmentDirty, setEnvironmentDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [dingTalkEnabled, setDingTalkEnabled] = useState(false);
  const [hasWebhook, setHasWebhook] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [webhook, setWebhook] = useState("");
  const [secret, setSecret] = useState("");
  const [dingTalkBusy, setDingTalkBusy] = useState(false);
  const [dingTalkResult, setDingTalkResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
  const [recordingScreenshotShortcut, setRecordingScreenshotShortcut] = useState(false);
  const [screenshotSettingsBusy, setScreenshotSettingsBusy] = useState(false);
  const [screenshotSettingsError, setScreenshotSettingsError] = useState<string | null>(null);
  const [backgroundPositionError, setBackgroundPositionError] = useState<string | null>(null);
  const [backgroundPositionSaving, setBackgroundPositionSaving] = useState(false);
  const backgroundDrag = useRef<{ pointerId: number; startX: number; startY: number; positionX: number; positionY: number; nextX: number; nextY: number } | null>(null);

  const handleBackgroundPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!terminalBackgroundImage || backgroundPositionSaving || event.button !== 0) return;
    backgroundDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      positionX: terminalBackgroundPositionX,
      positionY: terminalBackgroundPositionY,
      nextX: terminalBackgroundPositionX,
      nextY: terminalBackgroundPositionY
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setBackgroundPositionError(null);
  };

  const handleBackgroundPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = backgroundDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    drag.nextX = Math.min(100, Math.max(0, Math.round(drag.positionX - (event.clientX - drag.startX) / bounds.width * 100)));
    drag.nextY = Math.min(100, Math.max(0, Math.round(drag.positionY - (event.clientY - drag.startY) / bounds.height * 100)));
    onTerminalBackgroundPositionPreview(drag.nextX, drag.nextY);
  };

  const handleBackgroundPointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = backgroundDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    backgroundDrag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.nextX === drag.positionX && drag.nextY === drag.positionY) return;
    setBackgroundPositionSaving(true);
    void onTerminalBackgroundPositionCommit(drag.nextX, drag.nextY)
      .catch(error => setBackgroundPositionError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBackgroundPositionSaving(false));
  };

  const handleBackgroundPointerCancel = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = backgroundDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    backgroundDrag.current = null;
    onTerminalBackgroundPositionPreview(drag.positionX, drag.positionY);
  };

  const handleBackgroundPositionReset = () => {
    if (backgroundPositionSaving) return;
    setBackgroundPositionError(null);
    onTerminalBackgroundPositionPreview(50, 50);
    setBackgroundPositionSaving(true);
    void onTerminalBackgroundPositionCommit(50, 50)
      .catch(error => setBackgroundPositionError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBackgroundPositionSaving(false));
  };

  const themeOptions = useMemo(() => themes.map(theme => ({
    value: theme.id,
    label: t(theme.labelKey)
  })), [t, themes]);
  const localeOptions = useMemo(() => LOCALE_OPTIONS.map(option => ({
    value: option.id,
    label: t(option.labelKey)
  })), [t]);
  const categories = useMemo(() => [
    { id: "general" as const, label: t("settings.generalTitle"), description: t("settings.generalDescription"), icon: SettingsIcon },
    { id: "environment" as const, label: t("settings.environmentTitle"), description: t("settings.environmentNavDescription"), icon: Braces },
    { id: "models" as const, label: t("settings.modelsTitle"), description: t("settings.modelsDescription"), icon: Bot },
    { id: "mobile" as const, label: t("settings.mobileTitle"), description: t("settings.mobileNavDescription"), icon: Smartphone },
    { id: "notifications" as const, label: t("settings.notificationsTitle"), description: t("settings.notificationsDescription"), icon: Bell },
    { id: "backup" as const, label: locale === "en-US" ? "Database backup" : "数据库备份", description: locale === "en-US" ? "Back up and browse sessions, statistics and Agent conversations by computer" : "按电脑备份并查看会话、统计和 Agent 对话", icon: Database }
  ], [locale, t]);
  const activeMetadata = categories.find(category => category.id === activeCategory) || categories[0];

  const requestLeave = useCallback((action: () => void) => {
    if (!environmentDirty) action();
    else setPendingAction(() => action);
  }, [environmentDirty]);

  const requestClose = useCallback(() => requestLeave(onCancel), [onCancel, requestLeave]);

  const handleCategoryKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % categories.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + categories.length) % categories.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = categories.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const category = categories[nextIndex];
    requestLeave(() => {
      setActiveCategory(category.id);
      requestAnimationFrame(() => document.getElementById(`settings-tab-${category.id}`)?.focus());
    });
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pendingAction) setPendingAction(null);
      else requestClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [pendingAction, requestClose]);

  useEffect(() => {
    let disposed = false;
    window.dingTalkApi.getConfig().then(config => {
      if (disposed) return;
      setDingTalkEnabled(config.enabled);
      setHasWebhook(config.hasWebhook);
      setHasSecret(config.hasSecret);
    }).catch(err => {
      if (!disposed) setDingTalkResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    });
    return () => { disposed = true; };
  }, []);

  const continuePendingAction = () => {
    const action = pendingAction;
    setPendingAction(null);
    action?.();
  };

  const saveDraftAndContinue = async () => {
    setSavingDraft(true);
    const saved = await environmentRef.current?.save();
    setSavingDraft(false);
    if (saved) continuePendingAction();
    else setPendingAction(null);
  };

  const discardDraftAndContinue = () => {
    environmentRef.current?.discard();
    continuePendingAction();
  };

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

  const handleScreenshotEnabledChange = async (enabled: boolean) => {
    setScreenshotSettingsBusy(true);
    setScreenshotSettingsError(null);
    try {
      await onScreenshotEnabledChange(enabled);
    } catch (error) {
      setScreenshotSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setScreenshotSettingsBusy(false);
    }
  };

  const handleScreenshotShortcutKeyDown = async (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecordingScreenshotShortcut(false);
      setScreenshotSettingsError(null);
      return;
    }
    const candidate = screenshotShortcutFromKeyboardEvent(event.nativeEvent);
    if (!candidate) return;
    if (!candidate.ok) {
      setScreenshotSettingsError(t(candidate.reason === "reserved"
        ? "settings.screenshotShortcutReserved"
        : candidate.reason === "modifier_required"
          ? "settings.screenshotShortcutModifierRequired"
          : "settings.screenshotShortcutUnsupported"));
      return;
    }
    setScreenshotSettingsBusy(true);
    setScreenshotSettingsError(null);
    try {
      await onScreenshotShortcutChange(candidate.shortcut);
      setRecordingScreenshotShortcut(false);
    } catch (error) {
      setScreenshotSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setScreenshotSettingsBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <header className="settings-dialog-header">
          <div>
            <h3 id="settings-dialog-title">{t("settings.title")}</h3>
            <span>{t("settings.subtitle")}</span>
          </div>
          <button className="icon-button" type="button" title={t("settings.close")} aria-label={t("settings.close")} onClick={requestClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="settings-workspace">
          <nav className="settings-navigation" role="tablist" aria-label={t("settings.categories")}>
            {categories.map((category, index) => {
              const Icon = category.icon;
              const selected = activeCategory === category.id;
              return (
                <button
                  key={category.id}
                  id={`settings-tab-${category.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`settings-panel-${category.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={selected ? "active" : ""}
                  onClick={() => requestLeave(() => setActiveCategory(category.id))}
                  onKeyDown={event => handleCategoryKeyDown(event, index)}
                >
                  <Icon aria-hidden="true" />
                  <span>{category.label}</span>
                  {category.id === "environment" && environmentDirty && <i aria-hidden="true" title={t("settings.environmentUnsaved")} />}
                </button>
              );
            })}
          </nav>

          <main className="settings-content">
            <div className="settings-page-header">
              <h2>{activeMetadata.label}</h2>
              <p>{activeMetadata.description}</p>
            </div>

            <section id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={activeCategory !== "general"} className="settings-page">
              <div className="settings-general-column">
                <div className="settings-section general-settings">
                  <label className="settings-field">
                    <span className="modal-label">{t("settings.defaultWindowsShell")}</span>
                    <select className="modal-input" value={defaultWindowsShell} disabled={shellBusy} onChange={async event => {
                      const value = event.target.value as WindowsShell;
                      setShellBusy(true);
                      setShellError(null);
                      try { await onDefaultWindowsShellChange(value); }
                      catch (err) { setShellError(err instanceof Error ? err.message : String(err)); }
                      finally { setShellBusy(false); }
                    }}>
                      {WINDOWS_SHELL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <span className="settings-help">{t("settings.defaultWindowsShellHint")}</span>
                  </label>
                  {shellError && <p className="settings-result error" role="alert">{shellError}</p>}
                  <div className="settings-toggle-list">
                    <label className="settings-toggle-row">
                      <span><strong>{t("settings.autoRestore")}</strong></span>
                      <span className="auto-restore-label">
                        <input type="checkbox" className="auto-restore-checkbox" checked={autoRestore} onChange={onToggleAutoRestore} />
                        <span className="auto-restore-track" />
                      </span>
                    </label>
                    <label className="settings-toggle-row">
                      <span><strong>{t("settings.autoWorkBuddyCheckin")}</strong></span>
                      <span className="auto-restore-label">
                        <input type="checkbox" className="auto-restore-checkbox" checked={autoWorkBuddyCheckin} onChange={onToggleAutoWorkBuddyCheckin} />
                        <span className="auto-restore-track" />
                      </span>
                    </label>
                    <label className="settings-toggle-row">
                      <span><strong>{t("settings.debugMode")}</strong></span>
                      <span className="auto-restore-label">
                        <input type="checkbox" className="auto-restore-checkbox" checked={debugMode} onChange={onToggleDebugMode} />
                        <span className="auto-restore-track" />
                      </span>
                    </label>
                  </div>
                  <div className="settings-choice-grid">
                    <div className="settings-field">
                      <span className="modal-label">{t("settings.theme")}</span>
                      <SearchableSelect className="settings-theme-select" value={themeId} options={themeOptions} ariaLabel={t("settings.theme")} onChange={nextThemeId => onThemeChange(nextThemeId as ThemeId)} />
                    </div>
                    <div className="settings-field">
                      <span className="modal-label">{t("settings.language")}</span>
                      <SearchableSelect className="settings-theme-select" value={locale} options={localeOptions} ariaLabel={t("settings.language")} onChange={nextLocale => onLocaleChange(nextLocale as Locale)} />
                    </div>
                  </div>
                </div>
                <div className="settings-section terminal-background-settings">
                  <div className="settings-card-header">
                    <div>
                      <h4>{t("settings.terminalBackgroundTitle")}</h4>
                      <p className="settings-help">{t("settings.terminalBackgroundDescription")}</p>
                    </div>
                  </div>
                  <div className="settings-field terminal-background-image-row">
                    {terminalBackgroundImage ? (
                      <img
                        className="terminal-background-preview"
                        src={getTerminalBackgroundUrl(terminalBackgroundImage)}
                        alt={t("settings.terminalBackgroundTitle")}
                        draggable={false}
                        style={{ objectPosition: `${terminalBackgroundPositionX}% ${terminalBackgroundPositionY}%` }}
                        onPointerDown={handleBackgroundPointerDown}
                        onPointerMove={handleBackgroundPointerMove}
                        onPointerUp={handleBackgroundPointerUp}
                        onPointerCancel={handleBackgroundPointerCancel}
                      />
                    ) : (
                      <span className="terminal-background-none">{t("settings.terminalBackgroundNone")}</span>
                    )}
                    <div className="terminal-background-actions">
                      <button type="button" className="secondary-button" onClick={() => void onChooseTerminalBackground()}>
                        {t("settings.terminalBackgroundChoose")}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!terminalBackgroundImage}
                        onClick={() => void onClearTerminalBackground()}
                      >
                        {t("settings.terminalBackgroundClear")}
                      </button>
                      <button type="button" className="secondary-button" disabled={!terminalBackgroundImage || backgroundPositionSaving} onClick={handleBackgroundPositionReset}>
                        {t("settings.terminalBackgroundPositionReset")}
                      </button>
                    </div>
                  </div>
                  {terminalBackgroundImage && <p className="settings-help">{t("settings.terminalBackgroundPositionHint")}</p>}
                  {backgroundPositionError && <p className="settings-result error" role="alert">{t("settings.terminalBackgroundPositionError")}: {backgroundPositionError}</p>}
                  <div className="settings-field">
                    <span className="modal-label">
                      {t("settings.terminalBackgroundOpacity")} · {terminalBackgroundOpacity}%
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={terminalBackgroundOpacity}
                      disabled={!terminalBackgroundImage}
                      aria-label={t("settings.terminalBackgroundOpacity")}
                      onChange={event => onTerminalBackgroundOpacityChange(Number(event.target.value))}
                    />
                  </div>
                  <div className="settings-field">
                    <span className="modal-label">
                      {t("settings.terminalBackgroundBlur")} · {terminalBackgroundBlur}px
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={40}
                      step={1}
                      value={terminalBackgroundBlur}
                      disabled={!terminalBackgroundImage}
                      aria-label={t("settings.terminalBackgroundBlur")}
                      onChange={event => onTerminalBackgroundBlurChange(Number(event.target.value))}
                    />
                  </div>
                </div>
              </div>
              <div className="settings-general-column">
                <TitleBarActionSettings order={titleBarActionOrder} hidden={titleBarHiddenActions} screenshotEnabled={screenshotEnabled} onChange={onTitleBarActionsChange} />
                <div className="settings-section screenshot-settings">
                  <div className="settings-card-header">
                    <div>
                      <h4>{t("settings.screenshotTitle")}</h4>
                      <p className="settings-help">{t("settings.screenshotDescription")}</p>
                    </div>
                    <label className="auto-restore-label">
                      <input
                        type="checkbox"
                        className="auto-restore-checkbox"
                        checked={screenshotEnabled}
                        disabled={screenshotSettingsBusy}
                        onChange={event => void handleScreenshotEnabledChange(event.target.checked)}
                      />
                      <span className="auto-restore-track" />
                      <span className="auto-restore-text">{t("settings.screenshotEnabled")}</span>
                    </label>
                  </div>
                  <div className="settings-field">
                    <span className="modal-label">{t("settings.screenshotShortcut")}</span>
                    <button
                      className={`shortcut-recorder${recordingScreenshotShortcut ? " recording" : ""}`}
                      type="button"
                      disabled={!screenshotEnabled || screenshotSettingsBusy}
                      aria-label={t("settings.screenshotShortcut")}
                      onClick={() => {
                        setRecordingScreenshotShortcut(true);
                        setScreenshotSettingsError(null);
                      }}
                      onBlur={() => setRecordingScreenshotShortcut(false)}
                      onKeyDown={event => {
                        if (recordingScreenshotShortcut) void handleScreenshotShortcutKeyDown(event);
                      }}
                    >
                      {recordingScreenshotShortcut ? t("settings.screenshotShortcutRecording") : screenshotShortcut}
                    </button>
                    <span className="settings-help">{t("settings.screenshotShortcutHint")}</span>
                  </div>
                  {screenshotSettingsError && <p className="settings-result error" role="alert">{screenshotSettingsError}</p>}
                </div>
              </div>
            </section>

            <section id="settings-panel-environment" role="tabpanel" aria-labelledby="settings-tab-environment" hidden={activeCategory !== "environment"} className="settings-page environment-settings-page">
              <EnvironmentSettings ref={environmentRef} onDirtyChange={setEnvironmentDirty} requestLeave={requestLeave} />
            </section>

            <section id="settings-panel-models" role="tabpanel" aria-labelledby="settings-tab-models" hidden={activeCategory !== "models"} className="settings-page settings-page-stack">
              <OpenRouterSettings />
              <OpenRouterSettings provider="nararouter" />
              <OpenRouterSettings provider="minimax" />
              <CodeBuddyCodexSettings />
            </section>

            <section id="settings-panel-mobile" role="tabpanel" aria-labelledby="settings-tab-mobile" hidden={activeCategory !== "mobile"} className="settings-page settings-page-stack">
              <MobileAccessSettings />
            </section>

            <section id="settings-panel-backup" role="tabpanel" aria-labelledby="settings-tab-backup" hidden={activeCategory !== "backup"} className="settings-page settings-page-stack">
              {activeCategory === "backup" && <PostgresBackupSettings />}
            </section>

            <section id="settings-panel-notifications" role="tabpanel" aria-labelledby="settings-tab-notifications" hidden={activeCategory !== "notifications"} className="settings-page settings-page-stack">
              <section className="settings-section ding-talk-settings">
                <div className="settings-card-header">
                  <div>
                    <h4>{t("settings.dingTalkTitle")}</h4>
                    <p className="settings-help">{t("settings.dingTalkDescription")}</p>
                  </div>
                  <label className="auto-restore-label ding-talk-toggle">
                    <input type="checkbox" className="auto-restore-checkbox" checked={dingTalkEnabled} disabled={dingTalkBusy} onChange={event => setDingTalkEnabled(event.target.checked)} />
                    <span className="auto-restore-track" />
                    <span className="auto-restore-text">{t("settings.dingTalkEnabled")}</span>
                  </label>
                </div>
                <label className="settings-field">
                  <span className="modal-label">{t("settings.dingTalkWebhook")}</span>
                  <input className="modal-input" type="password" value={webhook} disabled={dingTalkBusy} autoComplete="off" placeholder={hasWebhook ? t("settings.dingTalkConfigured") : "https://oapi.dingtalk.com/robot/send?access_token=..."} onChange={event => setWebhook(event.target.value)} />
                </label>
                <label className="settings-field">
                  <span className="modal-label">{t("settings.dingTalkSecret")}</span>
                  <input className="modal-input" type="password" value={secret} disabled={dingTalkBusy} autoComplete="off" placeholder={hasSecret ? t("settings.dingTalkConfigured") : t("settings.dingTalkSecretOptional")} onChange={event => setSecret(event.target.value)} />
                </label>
                <div className="ding-talk-actions">
                  <button className="modal-button primary" type="button" disabled={dingTalkBusy} onClick={saveDingTalkConfig}>{t("common.save")}</button>
                  <button className="modal-button" type="button" disabled={dingTalkBusy || !hasWebhook} onClick={testDingTalk}>{t("settings.dingTalkTest")}</button>
                  <button className="modal-button danger" type="button" disabled={dingTalkBusy || (!hasWebhook && !hasSecret)} onClick={clearDingTalkCredentials}>{t("settings.dingTalkClear")}</button>
                </div>
                {dingTalkResult && <p className={`ding-talk-result ${dingTalkResult.kind}`} role="status">{dingTalkResult.message}</p>}
              </section>
            </section>
          </main>
        </div>

        {pendingAction && (
          <div className="settings-confirm-overlay">
            <div className="settings-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="settings-unsaved-title" aria-describedby="settings-unsaved-description">
              <h3 id="settings-unsaved-title">{t("settings.environmentUnsavedTitle")}</h3>
              <p id="settings-unsaved-description">{t("settings.environmentUnsavedDescription")}</p>
              <div className="settings-confirm-actions">
                <button className="modal-button primary" type="button" disabled={savingDraft} onClick={() => void saveDraftAndContinue()}>{t("settings.environmentSaveAndContinue")}</button>
                <button className="modal-button danger" type="button" disabled={savingDraft} onClick={discardDraftAndContinue}>{t("settings.environmentDiscardAndContinue")}</button>
                <button className="modal-button" type="button" disabled={savingDraft} onClick={() => setPendingAction(null)}>{t("settings.environmentKeepEditing")}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
