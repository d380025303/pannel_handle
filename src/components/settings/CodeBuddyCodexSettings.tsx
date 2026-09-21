import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { CodeBuddyCodexConfig, CodeBuddyCodexModel } from "../../vite-env";
import { CodeBuddyQuotaSettings } from "./CodeBuddyQuotaSettings";

const EMPTY_CONFIG: CodeBuddyCodexConfig = { favoriteModelIds: [], experimentalAcknowledged: false };

export function CodeBuddyCodexSettings() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<CodeBuddyCodexConfig>(EMPTY_CONFIG);
  const [models, setModels] = useState<CodeBuddyCodexModel[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyingModelId, setVerifyingModelId] = useState("");
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const load = async () => {
    const [nextConfig, nextModels] = await Promise.all([window.codeBuddyCodexApi.getConfig(), window.codeBuddyCodexApi.listModels()]);
    setConfig(nextConfig);
    setModels(nextModels);
  };

  useEffect(() => { void load().catch(error => setResult({ kind: "error", message: String(error?.message || error) })); }, []);

  const visibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter(model => !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle));
  }, [models, query]);

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

  const verifyModel = async (modelId: string) => {
    setVerifyingModelId(modelId);
    setResult(null);
    try {
      const verification = await window.codeBuddyCodexApi.verifyModel({ modelId, force: true });
      await load();
      if (verification.status !== "passed") throw new Error(verification.error || t("settings.codeBuddyCodexVerificationFailed"));
      setResult({ kind: "success", message: t("settings.codeBuddyCodexVerificationSuccess") });
    } catch (error) {
      setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setVerifyingModelId("");
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

  return (
    <section className="settings-section openrouter-settings">
      <div className="collapsible-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(value => !value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(value => !value); } }}>
        <span className={`collapsible-chevron${open ? "" : " collapsed"}`} aria-hidden="true">▾</span>
        <h4>{t("settings.codeBuddyCodexTitle")}</h4>
        <span className="settings-section-status">{config.catalogVersion ? `CodeBuddy ${config.catalogVersion}` : t("settings.codeBuddyCodexNotConfigured")}</span>
      </div>
      {open && <>
        <p className="settings-help">{t("settings.codeBuddyCodexDescription")}</p>
        <CodeBuddyQuotaSettings />
        <div className="settings-actions">
          <button className="modal-button" type="button" disabled={busy || Boolean(verifyingModelId)} onClick={() => void run(async () => { await window.codeBuddyCodexApi.refreshModels(); }, t("settings.codeBuddyCodexModelsRefreshed"))}>{t("settings.codeBuddyCodexRefreshModels")}</button>
        </div>
        <label className="settings-field">
          <span className="modal-label">{t("settings.codeBuddyCodexModels")}</span>
          <input className="modal-input" type="search" value={query} placeholder={t("common.search")} onChange={event => setQuery(event.target.value)} />
        </label>
        <div className="openrouter-model-list">
          {visibleModels.map(model => <div key={model.id} className="openrouter-model-row">
            <input type="checkbox" aria-label={model.id} checked={config.favoriteModelIds.includes(model.id)} disabled={!config.favoriteModelIds.includes(model.id) && model.verification?.status !== "passed"} onChange={() => toggleFavorite(model.id)} />
            <span><span className="codebuddy-model-title"><strong>{model.name}</strong>{model.promotions?.map(promotion => <small key={promotion.id} className="codebuddy-promotion-badge" style={promotion.color ? { color: promotion.color, borderColor: promotion.color } : undefined}>{promotion.label}</small>)}</span><small>{model.id}</small>{model.promotions?.map(promotion => { const description = locale === "zh-CN" ? promotion.descriptionZh || promotion.descriptionEn : promotion.descriptionEn || promotion.descriptionZh; return description ? <small key={`${promotion.id}-description`} className="codebuddy-promotion-description">{description}</small> : null; })}<small className={`openrouter-verification ${model.verification?.status || "pending"}`}>{model.verification?.status === "passed" ? t("settings.codeBuddyCodexVerified") : model.verification?.status === "failed" ? `${t("settings.codeBuddyCodexVerificationFailed")}：${model.verification.error || ""}` : t("settings.codeBuddyCodexVerificationPending")}</small></span>
            <span className="openrouter-model-actions">
              <button className="modal-button compact" type="button" disabled={busy || Boolean(verifyingModelId)} onClick={() => void verifyModel(model.id)}>{verifyingModelId === model.id ? t("settings.codeBuddyCodexVerifying") : t("settings.codeBuddyCodexVerify")}</button>
              {config.favoriteModelIds.includes(model.id) && <input type="radio" name="codebuddy-codex-default" checked={config.defaultModelId === model.id} aria-label={t("settings.codeBuddyCodexDefaultModel")} onChange={() => setConfig(current => ({ ...current, defaultModelId: model.id }))} />}
            </span>
          </div>)}
          {!models.length && <p className="settings-help">{t("settings.codeBuddyCodexRefreshHint")}</p>}
        </div>
        <button className="modal-button primary" type="button" disabled={busy} onClick={() => void run(async () => { await window.codeBuddyCodexApi.setFavorites({ favoriteModelIds: config.favoriteModelIds, defaultModelId: config.defaultModelId }); }, t("settings.codeBuddyCodexFavoritesSaved"))}>{t("settings.codeBuddyCodexSaveFavorites")}</button>
        <label className="openrouter-experimental-warning">
          <input type="checkbox" disabled={!config.catalogVersion || busy} checked={config.experimentalAcknowledged} onChange={(event) => void run(async () => { await window.codeBuddyCodexApi.setExperimentalAcknowledged({ acknowledged: event.target.checked }); }, t("settings.codeBuddyCodexAcknowledgementSaved"))} />
          <span>{t("settings.codeBuddyCodexAcknowledge")}</span>
        </label>
        <p className="settings-help">{t("settings.codeBuddyCodexNewSessionsHint")}</p>
        {result && <p className={`settings-result ${result.kind}`} role="status">{result.message}</p>}
      </>}
    </section>
  );
}
