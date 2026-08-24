import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";

export function OpenRouterSettings() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    let disposed = false;
    window.openRouterApi.getConfig().then((config) => {
      if (!disposed) setHasApiKey(config.hasApiKey);
    }).catch((err) => {
      if (!disposed) setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    });
    return () => { disposed = true; };
  }, []);

  const run = async (operation: () => Promise<string>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult({ kind: "success", message: await operation() });
    } catch (err) {
      setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const response = await window.openRouterApi.setApiKey(apiKey.trim());
    setHasApiKey(response.config.hasApiKey);
    setApiKey("");
    return response.keyLabel ? t("settings.openRouterValidatedAs", { label: response.keyLabel }) : t("settings.openRouterSaved");
  });

  const test = () => run(async () => {
    const response = await window.openRouterApi.test();
    return response.keyLabel ? t("settings.openRouterValidatedAs", { label: response.keyLabel }) : t("settings.openRouterTestSuccess");
  });

  const clear = () => run(async () => {
    const config = await window.openRouterApi.clearApiKey();
    setHasApiKey(config.hasApiKey);
    setApiKey("");
    return t("settings.openRouterCleared");
  });

  return (
    <section className="settings-section openrouter-settings">
      <div className="collapsible-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen((value) => !value); }
      }}>
        <span className={`collapsible-chevron${open ? "" : " collapsed"}`} aria-hidden="true">▾</span>
        <h4>{t("settings.openRouterTitle")}</h4>
        <span className={`credential-status ${hasApiKey ? "configured" : ""}`}>{hasApiKey ? t("settings.openRouterConfigured") : t("settings.openRouterNotConfigured")}</span>
      </div>
      {open && (
        <>
          <p className="settings-help">{t("settings.openRouterDescription")}</p>
          <label className="settings-field">
            <span className="modal-label">OpenRouter API Key</span>
            <input className="modal-input" type="password" value={apiKey} disabled={busy} autoComplete="off" placeholder={hasApiKey ? t("settings.openRouterKeyPlaceholder") : "sk-or-v1-..."} onChange={(event) => setApiKey(event.target.value)} />
          </label>
          <div className="ding-talk-actions">
            <button className="modal-button primary" type="button" disabled={busy || !apiKey.trim()} onClick={() => void save()}>{t("common.save")}</button>
            <button className="modal-button" type="button" disabled={busy || !hasApiKey} onClick={() => void test()}>{t("settings.openRouterTest")}</button>
            <button className="modal-button danger" type="button" disabled={busy || !hasApiKey} onClick={() => void clear()}>{t("settings.openRouterClear")}</button>
          </div>
          {result && <p className={`ding-talk-result ${result.kind}`} role="status">{result.message}</p>}
        </>
      )}
    </section>
  );
}
