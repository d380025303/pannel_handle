import { useEffect, useRef, useState } from "react";
import { Activity, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentTokenLiveViewState } from "../../hooks/useAgentTokenLive";

function formatTokens(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(value);
}

function providerName(provider: "codex" | "codebuddy") {
  return provider === "codex" ? "Codex" : "CodeBuddy";
}

function stateLabel(state: "waiting" | "generating" | "completed" | "unavailable") {
  if (state === "generating") return "tokenLive.state.generating" as const;
  if (state === "completed") return "tokenLive.state.completed" as const;
  if (state === "unavailable") return "tokenLive.state.unavailable" as const;
  return "tokenLive.state.waiting" as const;
}

export function AgentTokenLiveStatus({ state }: { state: AgentTokenLiveViewState }) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => setOpen(false), [state.status === "ready" ? state.snapshot.panelSessionId : state.status]);

  if (state.status === "hidden") return null;
  if (state.status === "loading" || state.status === "waiting") {
    return (
      <div className="agent-token-live-status waiting" role="status">
        <Activity aria-hidden="true" />
        <span>{t(state.status === "loading" ? "tokenLive.loading" : "tokenLive.waiting")}</span>
      </div>
    );
  }

  const { snapshot } = state;
  const unavailable = snapshot.state === "unavailable";
  const provider = providerName(snapshot.provider);
  return (
    <div className="agent-token-live" ref={rootRef}>
      <button
        className={`agent-token-live-status ${snapshot.state}`}
        type="button"
        aria-expanded={open}
        aria-label={t("tokenLive.title", { provider })}
        onClick={() => setOpen((current) => !current)}
      >
        <Activity aria-hidden="true" />
        {unavailable ? <span>{t("tokenLive.unavailable")}</span> : (
          <>
            <span>↑ {formatTokens(snapshot.tokens.inputTokens, locale)}</span>
            <span>↓ {formatTokens(snapshot.tokens.outputTokens, locale)}</span>
            <strong>{snapshot.outputTokensPerSecond.toLocaleString(locale, { maximumFractionDigits: 1 })} tok/s</strong>
          </>
        )}
      </button>
      {open && (
        <div className="agent-token-live-popover" role="dialog" aria-label={t("tokenLive.title", { provider })}>
          <header>
            <span><Activity aria-hidden="true" /><strong>{t("tokenLive.title", { provider })}</strong></span>
            <button type="button" onClick={() => setOpen(false)} aria-label={t("common.close")}><X aria-hidden="true" /></button>
          </header>
          {unavailable ? <p className="agent-token-live-empty">{t("tokenLive.unavailableHint")}</p> : (
            <div className="agent-token-live-grid">
              <span>{t("tokenLive.sessionInput")}</span><strong>{snapshot.tokens.inputTokens.toLocaleString(locale)}</strong>
              <span>{t("tokenLive.sessionOutput")}</span><strong>{snapshot.tokens.outputTokens.toLocaleString(locale)}</strong>
              <span>{t("tokenLive.cachedInput")}</span><strong>{snapshot.tokens.cachedInputTokens.toLocaleString(locale)}</strong>
              <span>{t("tokenLive.reasoningOutput")}</span><strong>{snapshot.tokens.reasoningOutputTokens.toLocaleString(locale)}</strong>
              <span>{t("tokenLive.turnOutput")}</span><strong>{snapshot.turnOutputTokens.toLocaleString(locale)}</strong>
              <span>{t("tokenLive.outputRate")}</span><strong>{snapshot.outputTokensPerSecond.toLocaleString(locale, { maximumFractionDigits: 1 })} tok/s</strong>
              <span>{t("tokenLive.model")}</span><strong>{snapshot.models.join(", ") || "—"}</strong>
              <span>{t("tokenLive.updatedAt")}</span><strong>{new Date(snapshot.updatedAt).toLocaleTimeString(locale)}</strong>
            </div>
          )}
          <small>{t(stateLabel(snapshot.state))}</small>
        </div>
      )}
    </div>
  );
}
