import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { CodexVersionState } from "../../vite-env";

export function CodexVersionControl({ sessionId, provider = "codex", api: suppliedApi }: { api?: typeof window.codexVersionApi; sessionId: string; provider?: "codex" | "codebuddy" | "opencode" }) {
  const { t } = useI18n();
  const api = suppliedApi || (provider === "codebuddy" ? window.codeBuddyVersionApi
    : provider === "opencode" ? window.openCodeVersionApi : window.codexVersionApi);
  const target = `${provider}:${sessionId}`;
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const label = (key: "title" | "update" | "confirmTitle" | "confirm" | "updating") =>
    t(provider === "codebuddy" ? `codeBuddyVersion.${key}`
      : provider === "opencode" ? `openCodeVersion.${key}` : `codexVersion.${key}`);
  const [state, setState] = useState<CodexVersionState | null>(null);
  const [checking, setChecking] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setState(null);
    setChecking(true);
    setConfirming(false);
    setError("");
    void api.check(sessionId).then(value => { if (active) setState(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [sessionId, provider]);
  useEffect(() => {
    if (state?.status !== "updating") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await api.check(sessionId);
        if (active) setState(value);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1000);
      }
    }
    timer = setTimeout(() => void refresh(), 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, provider, state?.status]);
  async function check() {
    const requestedTarget = target;
    setChecking(true);
    setError("");
    try { const value = await api.check(sessionId, true); if (currentTarget.current === requestedTarget) setState(value); }
    catch (cause) { if (currentTarget.current === requestedTarget) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentTarget.current === requestedTarget) setChecking(false); }
  }
  async function update() {
    const requestedTarget = target;
    setConfirming(false);
    setState(current => current ? { ...current, status: "updating", progress: { stage: "checking", output: "" } } : current);
    setError("");
    try { const value = await api.update(sessionId); if (currentTarget.current === requestedTarget) setState(value); }
    catch (cause) {
      if (currentTarget.current === requestedTarget) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const updating = state?.status === "updating";
  const available = state?.status === "available";
  return <div className="codex-version-control" role="group" aria-label={label("title")}>
    <strong className="codex-version-title">{label("title")}</strong>
    <div className="codex-version-detail" aria-live="polite">
      {(["current", "latest"] as const).map(kind => {
        const version = kind === "current" ? state?.currentVersion : state?.latestVersion;
        return <div key={kind} className="codex-version-row" aria-busy={checking}>
          <span>{t(`codexVersion.${kind}`, { version: version || (checking ? t("codexVersion.checking") : t("codexVersion.unavailable")) })}</span>
          {checking && <span className="codex-version-checking">
            <span className="codex-version-spinner" aria-hidden="true" />
            {version && <span>{t("codexVersion.checking")}</span>}
          </span>}
        </div>;
      })}
      {!checking && state?.status === "current" && !state.restartRequired && <span>{t("codexVersion.upToDate")}</span>}
      {state?.restartRequired && <span>{t("codexVersion.restart")}</span>}
      {state?.guidance && available && <span>{t("codexVersion.manual")}</span>}
      {state?.error && <span role="alert">{state.error}</span>}
      {error && error !== state?.error && <span role="alert">{error}</span>}
    </div>
    <div className="codex-version-actions">
      <button type="button" disabled={checking || updating} onClick={() => void check()}>{t("codexVersion.check")}</button>
      {available && state.method !== "unknown" && !confirming &&
        <button type="button" disabled={checking || updating} onClick={() => setConfirming(true)}>{label("update")}</button>}
    </div>
    {confirming && <div className="codex-version-confirm" role="group" aria-label={label("confirmTitle")}>
      <p>{t(provider === "codebuddy" ? "codeBuddyVersion.confirm" : provider === "opencode" ? "openCodeVersion.confirm" : "codexVersion.confirm", { environment: state?.environment || "", version: state?.latestVersion || "" })}</p>
      <button type="button" onClick={() => setConfirming(false)}>{t("codexVersion.cancel")}</button>
      <button type="button" disabled={checking || updating} onClick={() => void update()}>{t("codexVersion.confirmUpdate")}</button>
    </div>}
    {updating && <span role="status">{label("updating")}</span>}
    {state?.progress && <div className="codex-version-progress">
      <span>{t(`codexVersion.progress.${state.progress.stage}`)}</span>
      {state.progress.output && <pre aria-label={t("codexVersion.progress.output")}>{state.progress.output}</pre>}
    </div>}
  </div>;
}
