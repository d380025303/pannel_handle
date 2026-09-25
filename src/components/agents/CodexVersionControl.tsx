import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { CodexVersionState } from "../../vite-env";

export function CodexVersionControl({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<CodexVersionState | null>(null);
  const [checking, setChecking] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setState(null);
    setChecking(true);
    setConfirming(false);
    setError("");
    void window.codexVersionApi.check(sessionId).then(value => { if (active) setState(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [sessionId]);
  async function check() {
    setChecking(true);
    setError("");
    try { setState(await window.codexVersionApi.check(sessionId, true)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  }
  async function update() {
    setConfirming(false);
    setUpdating(true);
    setError("");
    try { setState(await window.codexVersionApi.update(sessionId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUpdating(false); }
  }
  const available = state?.status === "available";
  return <div className="codex-version-control" role="group" aria-label={t("codexVersion.title")}>
    <strong className="codex-version-title">{t("codexVersion.title")}</strong>
    <div className="codex-version-detail" role="status">
      {checking ? t("codexVersion.checking") : state?.currentVersion
        ? t("codexVersion.current", { version: state.currentVersion }) : t("codexVersion.unknown")}
      {state?.latestVersion && <span>{t("codexVersion.latest", { version: state.latestVersion })}</span>}
      {state?.status === "current" && !state.restartRequired && <span>{t("codexVersion.upToDate")}</span>}
      {state?.restartRequired && <span>{t("codexVersion.restart")}</span>}
      {state?.guidance && available && <span>{t("codexVersion.manual")}</span>}
      {state?.error && <span role="alert">{state.error}</span>}
      {error && <span role="alert">{error}</span>}
    </div>
    <div className="codex-version-actions">
      <button type="button" disabled={checking || updating} onClick={() => void check()}>{t("codexVersion.check")}</button>
      {available && state.method !== "unknown" && !confirming &&
        <button type="button" disabled={checking || updating} onClick={() => setConfirming(true)}>{t("codexVersion.update")}</button>}
    </div>
    {confirming && <div className="codex-version-confirm" role="group" aria-label={t("codexVersion.confirmTitle")}>
      <p>{t("codexVersion.confirm", { environment: state?.environment || "", version: state?.latestVersion || "" })}</p>
      <button type="button" onClick={() => setConfirming(false)}>{t("codexVersion.cancel")}</button>
      <button type="button" disabled={updating} onClick={() => void update()}>{t("codexVersion.confirmUpdate")}</button>
    </div>}
    {updating && <span role="status">{t("codexVersion.updating")}</span>}
  </div>;
}
