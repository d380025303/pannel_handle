import { Minus, PanelsTopLeft, Settings, Square, X } from "lucide-react";

type TitleBarProps = {
  activeTitle?: string;
  isMaximized: boolean;
  onOpenSettings: () => void;
};

export function TitleBar({ activeTitle, isMaximized, onOpenSettings }: TitleBarProps) {
  return (
    <header className="custom-titlebar" onDoubleClick={() => window.windowApi.toggleMaximize()}>
      <div className="titlebar-brand">
        Pannel Handle
        <button
          className="titlebar-settings-btn"
          type="button"
          title="设置"
          aria-label="打开设置"
          onClick={onOpenSettings}
        >
          <Settings aria-hidden="true" />
        </button>
      </div>
      <div className="titlebar-session">{activeTitle || "No active session"}</div>
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button
          className="window-control"
          type="button"
          title="Minimize"
          aria-label="Minimize window"
          onClick={() => window.windowApi.minimize()}
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          className="window-control"
          type="button"
          title={isMaximized ? "Restore" : "Maximize"}
          aria-label={isMaximized ? "Restore window" : "Maximize window"}
          onClick={() => window.windowApi.toggleMaximize()}
        >
          {isMaximized ? <PanelsTopLeft aria-hidden="true" /> : <Square aria-hidden="true" />}
        </button>
        <button
          className="window-control close"
          type="button"
          title="Close"
          aria-label="Close window"
          onClick={() => window.windowApi.close()}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
