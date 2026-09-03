import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatOpenRouterPricing } from "../../utils/openRouterPricing";
import type { CodeBuddyCodexConfig, CodeBuddyCodexModel, CodexBackend, MiniMaxModel, NaraRouterModel, OpenRouterModel } from "../../vite-env";

type CodexBackendFieldsProps = {
  backend: CodexBackend;
  model?: string;
  experimentalAcknowledged?: boolean;
  onBackendChange: (backend: CodexBackend) => void;
  onModelChange: (model?: string) => void;
  onExperimentalAcknowledgedChange?: (acknowledged: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
};

export function CodexBackendFields({ backend, model, experimentalAcknowledged = false, onBackendChange, onModelChange, onExperimentalAcknowledgedChange, onReadyChange }: CodexBackendFieldsProps) {
  const { locale, t } = useI18n();
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [openRouterDefaultModelId, setOpenRouterDefaultModelId] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [naraModels, setNaraModels] = useState<NaraRouterModel[]>([]);
  const [naraFavoriteIds, setNaraFavoriteIds] = useState<string[]>([]);
  const [naraHasApiKey, setNaraHasApiKey] = useState(false);
  const [naraLoading, setNaraLoading] = useState(false);
  const [miniMaxModels, setMiniMaxModels] = useState<MiniMaxModel[]>([]);
  const [miniMaxFavoriteIds, setMiniMaxFavoriteIds] = useState<string[]>([]);
  const [miniMaxHasApiKey, setMiniMaxHasApiKey] = useState(false);
  const [miniMaxLoading, setMiniMaxLoading] = useState(false);
  const [error, setError] = useState("");
  const [codeBuddyModels, setCodeBuddyModels] = useState<CodeBuddyCodexModel[]>([]);
  const [codeBuddyConfig, setCodeBuddyConfig] = useState<CodeBuddyCodexConfig>({ favoriteModelIds: [], experimentalAcknowledged: false });
  const [codeBuddyLoading, setCodeBuddyLoading] = useState(false);

  useEffect(() => {
    let disposed = false;
    Promise.all([window.openRouterApi.getConfig(), window.openRouterApi.listModels()])
      .then(([config, catalog]) => {
        if (disposed) return;
        setHasApiKey(config.hasApiKey);
        setFavoriteIds(config.favoriteModelIds);
        setOpenRouterDefaultModelId(config.defaultModelId || "");
        setModels(catalog);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (backend === "openrouter" && !model && openRouterDefaultModelId) onModelChange(openRouterDefaultModelId);
  }, [backend, model, onModelChange, openRouterDefaultModelId]);

  useEffect(() => {
    if (backend !== "nararouter") return;
    let disposed = false;
    setNaraLoading(true);
    setError("");
    Promise.all([window.naraRouterApi.getConfig(), window.naraRouterApi.listModels()])
      .then(([config, catalog]) => {
        if (disposed) return;
        setNaraHasApiKey(config.hasApiKey);
        setNaraFavoriteIds(config.favoriteModelIds);
        setNaraModels(catalog);
        if (!model && config.defaultModelId) onModelChange(config.defaultModelId);
      })
      .catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!disposed) setNaraLoading(false); });
    return () => { disposed = true; };
  }, [backend]);

  useEffect(() => {
    if (backend !== "minimax") return;
    let disposed = false;
    setMiniMaxLoading(true);
    setError("");
    Promise.all([window.miniMaxApi.getConfig(), window.miniMaxApi.listModels()])
      .then(([config, catalog]) => {
        if (disposed) return;
        setMiniMaxHasApiKey(config.hasApiKey);
        setMiniMaxFavoriteIds(config.favoriteModelIds);
        setMiniMaxModels(catalog);
        if (!model && config.defaultModelId) onModelChange(config.defaultModelId);
      })
      .catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!disposed) setMiniMaxLoading(false); });
    return () => { disposed = true; };
  }, [backend]);

  useEffect(() => {
    if (backend !== "codebuddy") return;
    let disposed = false;
    setCodeBuddyLoading(true);
    setError("");
    Promise.all([window.codeBuddyCodexApi.getConfig(), window.codeBuddyCodexApi.listModels()])
      .then(([config, catalog]) => {
        if (disposed) return;
        setCodeBuddyConfig(config);
        const byId = new Map(catalog.map(item => [item.id, item]));
        setCodeBuddyModels(config.favoriteModelIds.map(id => byId.get(id)).filter((item): item is CodeBuddyCodexModel => item?.verification?.status === "passed"));
        if (!model && config.defaultModelId) onModelChange(config.defaultModelId);
      })
      .catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!disposed) setCodeBuddyLoading(false); });
    return () => { disposed = true; };
  }, [backend]);

  const favoriteModels = useMemo(() => {
    const byId = new Map(models.map(item => [item.id, item]));
    return favoriteIds.map(id => byId.get(id)).filter((item): item is OpenRouterModel => Boolean(item));
  }, [favoriteIds, models]);
  const selectedModel = favoriteModels.find(item => item.id === model);
  const verificationStatus = selectedModel?.verification?.status;
  const naraFavoriteModels = useMemo(() => {
    const byId = new Map(naraModels.map(item => [item.id, item]));
    return naraFavoriteIds.map(id => byId.get(id)).filter((item): item is NaraRouterModel => Boolean(item));
  }, [naraFavoriteIds, naraModels]);
  const selectedNaraModel = naraFavoriteModels.find(item => item.id === model);
  const naraVerificationStatus = selectedNaraModel?.verification?.status;
  const miniMaxFavoriteModels = useMemo(() => {
    const byId = new Map(miniMaxModels.map(item => [item.id, item]));
    return miniMaxFavoriteIds.map(id => byId.get(id)).filter((item): item is MiniMaxModel => Boolean(item));
  }, [miniMaxFavoriteIds, miniMaxModels]);
  const selectedMiniMaxModel = miniMaxFavoriteModels.find(item => item.id === model);
  const miniMaxVerificationStatus = selectedMiniMaxModel?.verification?.status;
  const selectedCodeBuddyModel = codeBuddyModels.find(item => item.id === model);
  const codeBuddyReady = codeBuddyConfig.experimentalAcknowledged && selectedCodeBuddyModel?.verification?.status === "passed";
  const ready = backend === "openai"
    || (backend === "openrouter" && hasApiKey && Boolean(model) && (verificationStatus === "passed" || (verificationStatus === "partial" && experimentalAcknowledged)))
    || (backend === "nararouter" && naraHasApiKey && Boolean(model) && (naraVerificationStatus === "passed" || (naraVerificationStatus === "partial" && experimentalAcknowledged)))
    || (backend === "minimax" && miniMaxHasApiKey && Boolean(model) && (miniMaxVerificationStatus === "passed" || (miniMaxVerificationStatus === "partial" && experimentalAcknowledged)))
    || (backend === "codebuddy" && codeBuddyReady);
  const verificationLabel = (item: OpenRouterModel) => item.verification?.status === "passed"
    ? t("settings.openRouterVerificationPassed")
    : item.verification?.status === "partial"
      ? t("settings.openRouterVerificationPartial")
      : item.verification?.status === "unavailable"
        ? t("settings.openRouterVerificationUnavailable")
        : item.verification?.status === "failed"
          ? t("settings.openRouterVerificationFailed")
          : t("settings.openRouterVerificationPending");

  useEffect(() => {
    onReadyChange?.(ready);
  }, [onReadyChange, ready]);

  return (
    <fieldset className="modal-field codex-backend-fields">
      <span className="modal-label">{t("session.codexBackend")}</span>
      <div className="shell-list agent-provider-list">
        <button type="button" className={`shell-item ${backend === "openai" ? "selected" : ""}`} onClick={() => onBackendChange("openai")}>{t("session.codexBackendOpenAI")}</button>
        <button type="button" className={`shell-item ${backend === "openrouter" ? "selected" : ""}`} onClick={() => onBackendChange("openrouter")}>OpenRouter</button>
        <button type="button" className={`shell-item ${backend === "nararouter" ? "selected" : ""}`} onClick={() => onBackendChange("nararouter")}>NaraRouter</button>
        <button type="button" className={`shell-item ${backend === "minimax" ? "selected" : ""}`} onClick={() => onBackendChange("minimax")}>MiniMax</button>
        <button type="button" className={`shell-item ${backend === "codebuddy" ? "selected" : ""}`} onClick={() => onBackendChange("codebuddy")}>CodeBuddy</button>
      </div>
      {backend === "openrouter" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{t("session.codexModel")}</span>
            <select className="modal-input" value={model || ""} disabled={loading || favoriteModels.length === 0} onChange={(event) => onModelChange(event.target.value || undefined)}>
              <option value="">{loading ? t("common.loading") : t("session.codexModelSelect")}</option>
              {favoriteModels.map(item => <option key={item.id} value={item.id} disabled={item.verification?.status !== "passed" && item.verification?.status !== "partial"}>{item.name} · {item.id} · {verificationLabel(item)} · {formatOpenRouterPricing(item.pricing, locale, { input: t("settings.openRouterPriceInput"), output: t("settings.openRouterPriceOutput"), unavailable: t("settings.openRouterPriceUnavailable") })}</option>)}
            </select>
          </label>
          {verificationStatus === "partial" && <label className="openrouter-experimental-warning">
            <input type="checkbox" checked={experimentalAcknowledged} onChange={(event) => onExperimentalAcknowledgedChange?.(event.target.checked)} />
            <span>{t("session.openRouterExperimentalAcknowledge")}</span>
          </label>}
          {!ready && <div className="modal-error">{error || (!hasApiKey ? t("session.openRouterKeyRequired") : verificationStatus === "partial" ? t("session.openRouterExperimentalRequired") : verificationStatus === "failed" || verificationStatus === "unavailable" ? selectedModel?.verification?.error || verificationLabel(selectedModel!) : favoriteModels.length ? t("session.openRouterVerifiedRequired") : t("session.openRouterFavoriteRequired"))}</div>}
          <span className="modal-hint">{t("session.openRouterModelHint")}</span>
        </>
      )}
      {backend === "nararouter" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{t("session.naraRouterModel")}</span>
            <select className="modal-input" value={model || ""} disabled={naraLoading || naraFavoriteModels.length === 0} onChange={(event) => onModelChange(event.target.value || undefined)}>
              <option value="">{naraLoading ? t("common.loading") : t("session.codexModelSelect")}</option>
              {naraFavoriteModels.map(item => <option key={item.id} value={item.id} disabled={item.verification?.status !== "passed" && item.verification?.status !== "partial"}>{item.name} · {item.id} · {verificationLabel(item)} · {formatOpenRouterPricing(item.pricing, locale, { input: t("settings.openRouterPriceInput"), output: t("settings.openRouterPriceOutput"), unavailable: t("settings.openRouterPriceUnavailable") })}</option>)}
            </select>
          </label>
          {naraVerificationStatus === "partial" && <label className="openrouter-experimental-warning">
            <input type="checkbox" checked={experimentalAcknowledged} onChange={(event) => onExperimentalAcknowledgedChange?.(event.target.checked)} />
            <span>{t("session.openRouterExperimentalAcknowledge")}</span>
          </label>}
          {!ready && <div className="modal-error">{error || (!naraHasApiKey ? t("session.naraRouterKeyRequired") : naraVerificationStatus === "partial" ? t("session.openRouterExperimentalRequired") : naraVerificationStatus === "failed" || naraVerificationStatus === "unavailable" ? selectedNaraModel?.verification?.error || verificationLabel(selectedNaraModel!) : naraFavoriteModels.length ? t("session.naraRouterVerifiedRequired") : t("session.naraRouterFavoriteRequired"))}</div>}
          <span className="modal-hint">{t("session.naraRouterModelHint")}</span>
        </>
      )}
      {backend === "minimax" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{t("session.miniMaxModel")}</span>
            <select className="modal-input" value={model || ""} disabled={miniMaxLoading || miniMaxFavoriteModels.length === 0} onChange={(event) => onModelChange(event.target.value || undefined)}>
              <option value="">{miniMaxLoading ? t("common.loading") : t("session.codexModelSelect")}</option>
              {miniMaxFavoriteModels.map(item => <option key={item.id} value={item.id} disabled={item.verification?.status !== "passed" && item.verification?.status !== "partial"}>{item.name} · {item.id} · {verificationLabel(item)}</option>)}
            </select>
          </label>
          {miniMaxVerificationStatus === "partial" && <label className="openrouter-experimental-warning">
            <input type="checkbox" checked={experimentalAcknowledged} onChange={(event) => onExperimentalAcknowledgedChange?.(event.target.checked)} />
            <span>{t("session.openRouterExperimentalAcknowledge")}</span>
          </label>}
          {!ready && <div className="modal-error">{error || (!miniMaxHasApiKey ? t("session.miniMaxKeyRequired") : miniMaxVerificationStatus === "partial" ? t("session.openRouterExperimentalRequired") : miniMaxVerificationStatus === "failed" || miniMaxVerificationStatus === "unavailable" ? selectedMiniMaxModel?.verification?.error || verificationLabel(selectedMiniMaxModel!) : miniMaxFavoriteModels.length ? t("session.miniMaxVerifiedRequired") : t("session.miniMaxFavoriteRequired"))}</div>}
          <span className="modal-hint">{t("session.miniMaxModelHint")}</span>
        </>
      )}
      {backend === "codebuddy" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{t("session.codeBuddyCodexModel")}</span>
            <select className="modal-input" value={model || ""} disabled={codeBuddyLoading || codeBuddyModels.length === 0} onChange={(event) => onModelChange(event.target.value || undefined)}>
              <option value="">{codeBuddyLoading ? t("common.loading") : t("session.codexModelSelect")}</option>
              {codeBuddyModels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
          {!ready && <div className="modal-error">{error || t("session.codeBuddyCodexConfigRequired")}</div>}
          <span className="modal-hint">{t("session.codeBuddyCodexModelHint")}</span>
        </>
      )}
    </fieldset>
  );
}
