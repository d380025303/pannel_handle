import { Library, Minus, PanelsTopLeft, Plus, Settings, Square, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { MobileAccessState } from "../../vite-env";

type TitleBarProps = {
  activeTitle?: string;
  isMaximized: boolean;
  onOpenSettings: () => void;
  onOpenPicker: () => void;
  onOpenCreate: () => void;
  mobileAccessState: MobileAccessState | null;
};

export function TitleBar({ activeTitle, isMaximized, mobileAccessState, onOpenSettings, onOpenPicker, onOpenCreate }: TitleBarProps) {
  const { t } = useI18n();

  return (
    <header className="custom-titlebar" onDoubleClick={() => window.windowApi.toggleMaximize()}>
      <div className="titlebar-brand">
        <span className="titlebar-brand-label">Pannel Handle</span>
        <div className="titlebar-actions" onDoubleClick={(event) => event.stopPropagation()}>
          <button
            className="titlebar-settings-btn"
            type="button"
            title={t("settings.title")}
            aria-label={t("settings.open")}
            onClick={onOpenSettings}
          >
            <Settings aria-hidden="true" />
          </button>
          <button
            className="titlebar-action-btn"
            type="button"
            title={t("sidebar.openLibrary")}
            aria-label={t("sidebar.openLibrary")}
            onClick={onOpenPicker}
          >
            <Library aria-hidden="true" />
          </button>
          <button
            className="titlebar-action-btn primary"
            type="button"
            title={t("sidebar.newSession")}
            aria-label={t("sidebar.newSession")}
            onClick={onOpenCreate}
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
      </div>
      {mobileAccessState?.running && (
        <button className={`titlebar-mobile-status${mobileAccessState.activeDevice?.connected ? " connected" : ""}`} type="button" title={mobileAccessState.activeDevice?.name || "局域网移动终端已启用"} onClick={onOpenSettings}>
          <span />{mobileAccessState.activeDevice?.connected ? mobileAccessState.activeDevice.name : "移动访问"}
        </button>
      )}
      <div className="titlebar-session">{activeTitle || t("app.noActiveSession")}</div>
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button
          className="window-control"
          type="button"
          title={t("window.minimize")}
          aria-label={t("window.minimize")}
          onClick={() => window.windowApi.minimize()}
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          className="window-control"
          type="button"
          title={isMaximized ? t("window.restore") : t("window.maximize")}
          aria-label={isMaximized ? t("window.restore") : t("window.maximize")}
          onClick={() => window.windowApi.toggleMaximize()}
        >
          {isMaximized ? <PanelsTopLeft aria-hidden="true" /> : <Square aria-hidden="true" />}
        </button>
        <button
          className="window-control close"
          type="button"
          title={t("window.close")}
          aria-label={t("window.close")}
          onClick={() => window.windowApi.close()}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
