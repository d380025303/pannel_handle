import { useEffect, useRef, useState } from "react";
import { BarChart3, BookOpen, Bot, Cable, Library, Minus, PanelsTopLeft, Plus, ScanLine, Settings, Square, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentProvider, MobileAccessState } from "../../vite-env";
import { AGENT_PROVIDER_OPTIONS } from "../sessions/agentProviders";

type TitleBarProps = {
  activeTitle?: string;
  isMaximized: boolean;
  onOpenSettings: () => void;
  onOpenPicker: () => void;
  onOpenCreate: () => void;
  onQuickCreateAgent?: (provider: AgentProvider) => Promise<void>;
  onOpenStats?: () => void;
  onOpenSkills?: () => void;
  onOpenMcp?: () => void;
  mobileAccessState: MobileAccessState | null;
  screenshotEnabled?: boolean;
  onCaptureScreenshot?: () => void;
};

export function TitleBar({ activeTitle, isMaximized, mobileAccessState, screenshotEnabled = false, onCaptureScreenshot, onOpenSettings, onOpenPicker, onOpenCreate, onQuickCreateAgent, onOpenStats, onOpenSkills, onOpenMcp }: TitleBarProps) {
  const { t } = useI18n();
  const [quickAgentMenuOpen, setQuickAgentMenuOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState<AgentProvider>();
  const quickAgentMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!quickAgentMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!quickAgentMenuRef.current?.contains(event.target as Node)) {
        setQuickAgentMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuickAgentMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [quickAgentMenuOpen]);

  const handleQuickCreate = async (provider: AgentProvider) => {
    setQuickAgentMenuOpen(false);
    setCreatingProvider(provider);
    try {
      await onQuickCreateAgent?.(provider);
    } finally {
      setCreatingProvider(undefined);
    }
  };

  return (
    <header className="custom-titlebar" onDoubleClick={() => window.windowApi.toggleMaximize()}>
      <div className="titlebar-brand">
        <span className="titlebar-brand-label">Pannel Handle</span>
        <div className="titlebar-actions" onDoubleClick={(event) => event.stopPropagation()}>
          <button className="titlebar-settings-btn" type="button" title={t("tokenStats.title")} aria-label={t("tokenStats.open")} onClick={() => onOpenStats?.()}><BarChart3 aria-hidden="true" /></button>
          <button className="titlebar-settings-btn" type="button" title={t("skills.title")} aria-label={t("skills.open")} onClick={() => onOpenSkills?.()}><BookOpen aria-hidden="true" /></button>
          <button className="titlebar-settings-btn" type="button" title={t("mcp.title")} aria-label={t("mcp.open")} onClick={() => onOpenMcp?.()}><Cable aria-hidden="true" /></button>
          {screenshotEnabled && (
            <button className="titlebar-settings-btn" type="button" title={t("screenshot.capture")} aria-label={t("screenshot.capture")} onClick={onCaptureScreenshot}>
              <ScanLine aria-hidden="true" />
            </button>
          )}
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
          <div className="titlebar-quick-agent" ref={quickAgentMenuRef}>
            <button
              className="titlebar-action-btn"
              type="button"
              title={t("session.quickAgent")}
              aria-label={t("session.quickAgent")}
              aria-haspopup="menu"
              aria-expanded={quickAgentMenuOpen}
              disabled={Boolean(creatingProvider)}
              onClick={() => setQuickAgentMenuOpen((open) => !open)}
            >
              <Bot aria-hidden="true" />
            </button>
            {quickAgentMenuOpen && (
              <div className="quick-agent-menu" role="menu" aria-label={t("session.quickAgentMenu")}>
                {AGENT_PROVIDER_OPTIONS.map((provider) => (
                  <button
                    key={provider.value}
                    type="button"
                    role="menuitem"
                    onClick={() => void handleQuickCreate(provider.value)}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
            )}
          </div>
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
          <span className="titlebar-mobile-dot" aria-hidden="true" />
          <span className="titlebar-mobile-label">
            {mobileAccessState.activeDevice?.connected ? mobileAccessState.activeDevice.name : "移动访问"}
          </span>
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
