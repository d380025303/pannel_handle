import { useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentProvider, TerminalSession } from "../../vite-env";
import { AGENT_PROVIDER_OPTIONS, getAgentProviderLabel, supportsLocalBridge } from "../sessions/agentProviders";

type AgentSwitcherProps = {
  session?: TerminalSession;
  onSwitch: (sessionId: string, provider: AgentProvider) => Promise<void>;
};

export function AgentSwitcher({ session, onSwitch }: AgentSwitcherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<AgentProvider>();
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isLocalSshAgent = session?.type === "ssh" && session.agentLocation === "local";

  useEffect(() => {
    setOpen(false);
    setError("");
  }, [session?.id]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!session?.agentProvider) return null;

  const disabled = Boolean(switchingTo);
  const title = t("agentSwitch.title");
  const tooltip = `${title}：${switchingTo ? t("agentSwitch.switching", { provider: getAgentProviderLabel(switchingTo) }) : getAgentProviderLabel(session.agentProvider)}`;

  const switchTo = async (provider: AgentProvider) => {
    setOpen(false);
    setError("");
    setSwitchingTo(provider);
    try {
      await onSwitch(session.id, provider);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setSwitchingTo(undefined);
    }
  };

  return (
    <div className="agent-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className="agent-switcher-trigger"
        type="button"
        title={tooltip}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        {switchingTo ? <LoaderCircle className="spin" aria-hidden="true" /> : <Bot aria-hidden="true" />}
      </button>
      {open && (
        <div className="agent-switcher-menu" role="menu" aria-label={t("agentSwitch.menu")}>
          {AGENT_PROVIDER_OPTIONS.filter(option => option.value !== session.agentProvider
            && (isLocalSshAgent
              ? supportsLocalBridge(option.value) && (option.value !== "claude" || session.runtimeMode === "app-server")
              : !(session.type === "ssh" && (option.value === "copilot" || option.value === "gemini" || option.value === "grok")))).map(option => (
            <button key={option.value} type="button" role="menuitem" onClick={() => void switchTo(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="agent-switcher-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label={t("common.close")} onClick={() => setError("")}><X aria-hidden="true" /></button>
        </div>
      )}
    </div>
  );
}
