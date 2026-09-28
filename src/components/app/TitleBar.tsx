import { useEffect, useRef, useState } from "react";
import { BarChart3, BookOpen, Bot, Cable, Library, MessageSquareText, Minus, PanelsTopLeft, Plus, ScanLine, Settings, Square, Terminal, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentProvider, MobileAccessState } from "../../vite-env";
import { AGENT_PROVIDER_OPTIONS } from "../sessions/agentProviders";
import { DEFAULT_TITLE_BAR_ACTION_ORDER } from "./titleBarActions";
import type { TitleBarActionId } from "./titleBarActions";

type TitleBarProps = {
  activeTitle?: string;
  isMaximized: boolean;
  onOpenSettings: () => void;
  onOpenPicker: () => void;
  onOpenCreate: () => void;
  onQuickCreateAgent?: (provider: AgentProvider) => Promise<void>;
  onOpenStats?: () => void;
  onOpenTerminal?: () => void;
  onOpenSkills?: () => void;
  onOpenMcp?: () => void;
  onOpenProjectAssistant?: () => void;
  mobileAccessState: MobileAccessState | null;
  screenshotEnabled?: boolean;
  onCaptureScreenshot?: () => void;
  actionOrder?: TitleBarActionId[];
  hiddenActions?: TitleBarActionId[];
};

export function TitleBar({ activeTitle, isMaximized, mobileAccessState, screenshotEnabled = false, onCaptureScreenshot, onOpenSettings, onOpenPicker, onOpenCreate, onQuickCreateAgent, onOpenStats, onOpenTerminal, onOpenSkills, onOpenMcp, onOpenProjectAssistant, actionOrder = DEFAULT_TITLE_BAR_ACTION_ORDER, hiddenActions = [] }: TitleBarProps) {
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

  const simpleActions = {
    terminal: { label: t("app.openTerminal"), icon: Terminal, onClick: onOpenTerminal },
    stats: { label: t("tokenStats.open"), icon: BarChart3, onClick: onOpenStats },
    skills: { label: t("skills.open"), icon: BookOpen, onClick: onOpenSkills },
    mcp: { label: t("mcp.open"), icon: Cable, onClick: onOpenMcp },
    assistant: { label: t("projectAssistant.open"), icon: MessageSquareText, onClick: onOpenProjectAssistant },
    screenshot: { label: t("screenshot.capture"), icon: ScanLine, onClick: onCaptureScreenshot },
    library: { label: t("sidebar.openLibrary"), icon: Library, onClick: onOpenPicker },
    create: { label: t("sidebar.newSession"), icon: Plus, onClick: onOpenCreate }
  };

  const renderAction = (id: TitleBarActionId) => {
    if (hiddenActions.includes(id) || (id === "screenshot" && !screenshotEnabled)) return null;
    if (id === "quickAgent") return (
      <div className="titlebar-quick-agent" ref={quickAgentMenuRef} key={id}>
        <button className="titlebar-action-btn" type="button" title={t("session.quickAgent")} aria-label={t("session.quickAgent")}
          aria-haspopup="menu" aria-expanded={quickAgentMenuOpen} disabled={Boolean(creatingProvider)}
          onClick={() => setQuickAgentMenuOpen((open) => !open)}><Bot aria-hidden="true" /></button>
        {quickAgentMenuOpen && (
          <div className="quick-agent-menu" role="menu" aria-label={t("session.quickAgentMenu")}>
            {AGENT_PROVIDER_OPTIONS.map((provider) => (
              <button key={provider.value} type="button" role="menuitem" onClick={() => void handleQuickCreate(provider.value)}>{provider.label}</button>
            ))}
          </div>
        )}
      </div>
    );
    const action = simpleActions[id];
    const Icon = action.icon;
    return <button key={id} className={id === "create" ? "titlebar-action-btn primary" : id === "library" ? "titlebar-action-btn" : "titlebar-settings-btn"}
      type="button" title={action.label} aria-label={action.label} onClick={action.onClick}><Icon aria-hidden="true" /></button>;
  };

  return (
    <header className="custom-titlebar" onDoubleClick={() => window.windowApi.toggleMaximize()}>
      <div className="titlebar-brand">
        <span className="titlebar-brand-label">Pannel Handle</span>
        <div className="titlebar-actions" onDoubleClick={(event) => event.stopPropagation()}>
          {actionOrder.slice(0, 7).map(renderAction)}
          <button
            className="titlebar-settings-btn"
            type="button"
            title={t("settings.title")}
            aria-label={t("settings.open")}
            onClick={onOpenSettings}
          >
            <Settings aria-hidden="true" />
          </button>
          {actionOrder.slice(7).map(renderAction)}
        </div>
      </div>
      {mobileAccessState?.running && (
        <button className={`titlebar-mobile-status${mobileAccessState.activeConnections.length ? " connected" : ""}`} type="button" title={mobileAccessState.activeConnections.map(connection => connection.name).join("、") || "局域网移动终端已启用"} onClick={onOpenSettings}>
          <span className="titlebar-mobile-dot" aria-hidden="true" />
          <span className="titlebar-mobile-label">
            {mobileAccessState.activeConnections.length ? `移动访问 ${mobileAccessState.activeConnections.length}` : "移动访问"}
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
