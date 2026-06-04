type TitleBarProps = {
  activeTitle?: string;
  isMaximized: boolean;
};

export function TitleBar({ activeTitle, isMaximized }: TitleBarProps) {
  return (
    <header className="custom-titlebar" onDoubleClick={() => window.windowApi.toggleMaximize()}>
      <div className="titlebar-brand">Pannel Handle</div>
      <div className="titlebar-session">{activeTitle || "No active session"}</div>
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button
          className="window-control"
          type="button"
          title="Minimize"
          aria-label="Minimize window"
          onClick={() => window.windowApi.minimize()}
        >
          -
        </button>
        <button
          className="window-control"
          type="button"
          title={isMaximized ? "Restore" : "Maximize"}
          aria-label={isMaximized ? "Restore window" : "Maximize window"}
          onClick={() => window.windowApi.toggleMaximize()}
        >
          {isMaximized ? "\u2750" : "\u25a1"}
        </button>
        <button
          className="window-control close"
          type="button"
          title="Close"
          aria-label="Close window"
          onClick={() => window.windowApi.close()}
        >
          {"\u00d7"}
        </button>
      </div>
    </header>
  );
}
