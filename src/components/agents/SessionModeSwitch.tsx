import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, LoaderCircle, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { TerminalSession } from "../../vite-env";

type Props = {
  session?: TerminalSession;
  onOpenOtherMode: (id: string) => Promise<void>;
};

const GRAPHICAL_PROVIDERS = new Set(["codex", "codebuddy", "opencode", "claude", "qoder", "gemini", "grok"]);

export function SessionModeSwitch({ session, onOpenOtherMode }: Props) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const pendingRef = useRef(false);

  useEffect(() => { setError(""); }, [session?.id]);

  if (!session?.agentProvider || !GRAPHICAL_PROVIDERS.has(session.agentProvider)) return null;
  const toGraphical = session.runtimeMode !== "app-server";
  if (!toGraphical && session.type === "ssh" && session.agentLocation === "local"
    && (session.agentProvider === "claude" || session.agentProvider === "qoder")) return null;

  const label = t(toGraphical ? "session.openGraphicalMode" : "session.openTerminalMode");
  const openOtherMode = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      await onOpenOtherMode(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return <div className="agent-switcher">
    <button className="agent-switcher-trigger" type="button" title={pending ? t("session.openingOtherMode") : label} aria-label={label} disabled={pending} onClick={() => void openOtherMode()}>
      {pending ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowLeftRight aria-hidden="true" />}
    </button>
    {error && <div className="agent-switcher-error" role="alert">
      <span>{error}</span>
      <button type="button" aria-label={t("common.close")} onClick={() => setError("")}><X aria-hidden="true" /></button>
    </div>}
  </div>;
}
