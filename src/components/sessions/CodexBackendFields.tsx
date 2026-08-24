import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatOpenRouterPricing } from "../../utils/openRouterPricing";
import type { CodexBackend, OpenRouterModel } from "../../vite-env";

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
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    Promise.all([window.openRouterApi.getConfig(), window.openRouterApi.listModels()])
      .then(([config, catalog]) => {
        if (disposed) return;
        setHasApiKey(config.hasApiKey);
        setFavoriteIds(config.favoriteModelIds);
        setModels(catalog);
        if (!model && config.defaultModelId) onModelChange(config.defaultModelId);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, []);

  const favoriteModels = useMemo(() => {
    const byId = new Map(models.map(item => [item.id, item]));
    return favoriteIds.map(id => byId.get(id)).filter((item): item is OpenRouterModel => Boolean(item));
  }, [favoriteIds, models]);
  const selectedModel = favoriteModels.find(item => item.id === model);
  const verificationStatus = selectedModel?.verification?.status;
  const ready = backend === "openai" || (hasApiKey && Boolean(model) && (verificationStatus === "passed" || (verificationStatus === "partial" && experimentalAcknowledged)));
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
    </fieldset>
  );
}
