import { Minus, PanelsTopLeft, Settings, Square, X } from "lucide-react";
import { useI18n } from "../i18n";

type TitleBarProps = {
  activeTitle?: string;
  isMaximized: boolean;
  onOpenSettings: () => void;
};

export function TitleBar({ activeTitle, isMaximized, onOpenSettings }: TitleBarProps) {
  const { t } = useI18n();

  return (
    <header className="custom-titlebar" onDoubleClick={() => window.windowApi.toggleMaximize()}>
      <div className="titlebar-brand">
        Pannel Handle
        <button
          className="titlebar-settings-btn"
          type="button"
          title={t("settings.title")}
          aria-label={t("settings.open")}
          onClick={onOpenSettings}
        >
          <Settings aria-hidden="true" />
        </button>
      </div>
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
