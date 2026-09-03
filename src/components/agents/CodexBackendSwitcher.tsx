import { ChevronDown, Cpu, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { CodexBackend, TerminalSession } from "../../vite-env";

type CodexBackendSwitcherProps = {
  session?: TerminalSession;
  onSwitch: (sessionId: string, backend: CodexBackend) => Promise<void>;
};

const BACKEND_OPTIONS: Array<{ value: CodexBackend; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "nararouter", label: "NaraRouter" },
  { value: "minimax", label: "MiniMax" },
  { value: "codebuddy", label: "CodeBuddy" }
];

function getBackendLabel(backend?: CodexBackend) {
  return BACKEND_OPTIONS.find(option => option.value === (backend || "openai"))?.label || "OpenAI";
}

export function CodexBackendSwitcher({ session, onSwitch }: CodexBackendSwitcherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<CodexBackend>();
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  if (session?.agentProvider !== "codex" || session.type === "ssh") return null;

  const currentBackend = session.codexBackend || "openai";
  const disabled = Boolean(switchingTo);
  const title = t("codexBackendSwitch.title");

  const switchTo = async (backend: CodexBackend) => {
    setOpen(false);
    setError("");
    setSwitchingTo(backend);
    try {
      await onSwitch(session.id, backend);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setSwitchingTo(undefined);
    }
  };

  return (
    <div className="agent-switcher codex-backend-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className="agent-switcher-trigger"
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        {switchingTo ? <LoaderCircle className="spin" aria-hidden="true" /> : <Cpu aria-hidden="true" />}
        <span>{switchingTo ? t("codexBackendSwitch.switching", { backend: getBackendLabel(switchingTo) }) : getBackendLabel(currentBackend)}</span>
        {!switchingTo && <ChevronDown aria-hidden="true" />}
      </button>
      {open && (
        <div className="agent-switcher-menu" role="menu" aria-label={t("codexBackendSwitch.menu")}>
          {BACKEND_OPTIONS.filter(option => option.value !== currentBackend).map(option => (
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
