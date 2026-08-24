import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatOpenRouterPricing } from "../../utils/openRouterPricing";
import type { OpenRouterConfig, OpenRouterModel } from "../../vite-env";

function verificationStageKey(stage?: string) {
  if (stage === "responses") return "settings.openRouterStageResponses" as const;
  if (stage === "function_tools") return "settings.openRouterStageFunctionTools" as const;
  return "settings.openRouterStageCodexTools" as const;
}

export function OpenRouterSettings() {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<OpenRouterConfig>({ hasApiKey: false, favoriteModelIds: [] });
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyingModelId, setVerifyingModelId] = useState("");
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const load = async () => {
    const [nextConfig, nextModels] = await Promise.all([window.openRouterApi.getConfig(), window.openRouterApi.listModels()]);
    setConfig(nextConfig);
    setModels(nextModels);
  };

  useEffect(() => { void load().catch((error) => setResult({ kind: "error", message: String(error?.message || error) })); }, []);

  const compatibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter(model => model.compatible && (!needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle)));
  }, [models, query]);

  const verificationText = (model: OpenRouterModel) => {
    const verification = model.verification;
    if (!verification) return t("settings.openRouterVerificationPending");
    if (verification.status === "passed") return t("settings.openRouterVerificationPassed");
    const stage = verification.failedStage ? `${t(verificationStageKey(verification.failedStage))} · ` : "";
    if (verification.status === "partial") return `${t("settings.openRouterVerificationPartial")}：${stage}${verification.error || ""}`;
    if (verification.status === "unavailable") return `${t("settings.openRouterVerificationUnavailable")}：${stage}${verification.error || ""}`;
    return `${t("settings.openRouterVerificationFailed")}：${stage}${verification.error || ""}`;
  };

  const run = async (action: () => Promise<void>, successMessage: string) => {
    setBusy(true);
    setResult(null);
    try {
      await action();
      await load();
      setResult({ kind: "success", message: successMessage });
    } catch (error) {
      setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = (id: string) => {
    const favoriteModelIds = config.favoriteModelIds.includes(id)
      ? config.favoriteModelIds.filter(item => item !== id)
      : [...config.favoriteModelIds, id];
    setConfig(current => ({
      ...current,
      favoriteModelIds,
      defaultModelId: favoriteModelIds.includes(current.defaultModelId || "") ? current.defaultModelId : favoriteModelIds[0]
    }));
  };

  const verifyModel = async (modelId: string) => {
    setVerifyingModelId(modelId);
    setResult(null);
    try {
      const [verification] = await window.openRouterApi.verifyModels({ modelIds: [modelId], force: true });
      await load();
      if (verification.status === "failed" || verification.status === "unavailable") throw new Error(`${modelId}：${verification.error || t("settings.openRouterVerificationFailed")}`);
      setResult({ kind: "success", message: verification.status === "partial" ? t("settings.openRouterVerificationPartialSuccess") : t("settings.openRouterVerificationSuccess") });
    } catch (error) {
      setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setVerifyingModelId("");
    }
  };

  return (
    <section className="settings-section openrouter-settings">
      <div className="collapsible-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(value => !value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(value => !value); } }}>
        <span className={`collapsible-chevron${open ? "" : " collapsed"}`} aria-hidden="true">▾</span>
        <h4>OpenRouter</h4>
        <span className="settings-section-status">{config.hasApiKey ? t("settings.openRouterConfigured") : t("settings.openRouterNotConfigured")}</span>
      </div>
      {open && <>
        <p className="settings-help">{t("settings.openRouterDescription")}</p>
        <label className="settings-field">
          <span className="modal-label">API Key</span>
          <input className="modal-input" type="password" autoComplete="off" disabled={busy} value={apiKey} placeholder={config.hasApiKey ? t("settings.openRouterKeyStored") : "sk-or-v1-..."} onChange={event => setApiKey(event.target.value)} />
        </label>
        <div className="settings-actions">
          <button className="modal-button primary" type="button" disabled={busy || !apiKey.trim()} onClick={() => void run(async () => { await window.openRouterApi.saveApiKey(apiKey.trim()); setApiKey(""); }, t("settings.openRouterSaved"))}>{t("common.save")}</button>
          <button className="modal-button" type="button" disabled={busy || !config.hasApiKey} onClick={() => void run(async () => { await window.openRouterApi.test(); }, t("settings.openRouterTestSuccess"))}>{t("settings.openRouterTest")}</button>
          <button className="modal-button danger" type="button" disabled={busy || !config.hasApiKey} onClick={() => void run(async () => { await window.openRouterApi.clearApiKey(); }, t("settings.openRouterCleared"))}>{t("settings.openRouterClear")}</button>
          <button className="modal-button" type="button" disabled={busy} onClick={() => void run(async () => { setModels(await window.openRouterApi.refreshModels()); }, t("settings.openRouterModelsRefreshed"))}>{t("settings.openRouterRefreshModels")}</button>
        </div>
        <label className="settings-field">
          <span className="modal-label">{t("settings.openRouterFavorites")}</span>
          <input className="modal-input" type="search" value={query} placeholder={t("common.search")} onChange={event => setQuery(event.target.value)} />
        </label>
        <div className="openrouter-model-list">
          {compatibleModels.map(model => <div key={model.id} className="openrouter-model-row">
            <input type="checkbox" checked={config.favoriteModelIds.includes(model.id)} disabled={!config.favoriteModelIds.includes(model.id) && model.verification?.status !== "passed" && model.verification?.status !== "partial"} onChange={() => toggleFavorite(model.id)} />
            <span><strong>{model.name}</strong><small>{model.id}</small><small className="openrouter-model-price">{formatOpenRouterPricing(model.pricing, locale, { input: t("settings.openRouterPriceInput"), output: t("settings.openRouterPriceOutput"), unavailable: t("settings.openRouterPriceUnavailable") })}</small><small className={`openrouter-verification ${model.verification?.status || "pending"}`}>{verificationText(model)}</small></span>
            <span className="openrouter-model-actions">
              <button className="modal-button compact" type="button" disabled={busy || Boolean(verifyingModelId)} onClick={() => void verifyModel(model.id)}>{verifyingModelId === model.id ? t("settings.openRouterVerifying") : t("settings.openRouterVerifyRetry")}</button>
              {config.favoriteModelIds.includes(model.id) && <input type="radio" name="openrouter-default" checked={config.defaultModelId === model.id} aria-label={t("settings.openRouterDefaultModel")} onChange={() => setConfig(current => ({ ...current, defaultModelId: model.id }))} />}
            </span>
          </div>)}
          {!models.length && <p className="settings-help">{t("settings.openRouterRefreshHint")}</p>}
        </div>
        <button className="modal-button primary" type="button" disabled={busy || !config.favoriteModelIds.length} onClick={() => void run(async () => { await window.openRouterApi.setFavorites({ favoriteModelIds: config.favoriteModelIds, defaultModelId: config.defaultModelId }); }, t("settings.openRouterFavoritesSaved"))}>{t("settings.openRouterSaveFavorites")}</button>
        <p className="settings-help">{t("settings.openRouterNewSessionsHint")}</p>
        {result && <p className={`settings-result ${result.kind}`} role="status">{result.message}</p>}
      </>}
    </section>
  );
}
