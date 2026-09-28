import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatOpenRouterPricing } from "../../utils/openRouterPricing";
import type { CodexBackend, MiniMaxModel, NaraRouterModel, OpenRouterModel } from "../../vite-env";

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
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [naraModels, setNaraModels] = useState<NaraRouterModel[]>([]);
  const [naraHasApiKey, setNaraHasApiKey] = useState(false);
  const [naraLoading, setNaraLoading] = useState(false);
  const [miniMaxModels, setMiniMaxModels] = useState<MiniMaxModel[]>([]);
  const [miniMaxHasApiKey, setMiniMaxHasApiKey] = useState(false);
  const [miniMaxLoading, setMiniMaxLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    Promise.all([window.openRouterApi.getConfig(), window.openRouterApi.listModels()])
      .then(([config, catalog]) => {
        if (disposed) return;
        setHasApiKey(config.hasApiKey);
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
    if (backend !== "nararouter") return;
    let disposed = false;
    setNaraLoading(true);
    setError("");
    Promise.all([window.naraRouterApi.getConfig(), window.naraRouterApi.listModels()])
      .then(([config, catalog]) => {
        if (disposed) return;
        setNaraHasApiKey(config.hasApiKey);
        setNaraModels(catalog);
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
        setMiniMaxModels(catalog);
      })
      .catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!disposed) setMiniMaxLoading(false); });
    return () => { disposed = true; };
  }, [backend]);

  const verifiedModels = useMemo(() => models.filter(item => item.compatible && ["passed", "partial"].includes(item.verification?.status || "")), [models]);
  const selectedModel = models.find(item => item.id === model);
  const verificationStatus = selectedModel?.verification?.status;
  const naraVerifiedModels = useMemo(() => naraModels.filter(item => item.compatible && ["passed", "partial"].includes(item.verification?.status || "")), [naraModels]);
  const selectedNaraModel = naraModels.find(item => item.id === model);
  const naraVerificationStatus = selectedNaraModel?.verification?.status;
  const miniMaxVerifiedModels = useMemo(() => miniMaxModels.filter(item => item.compatible && ["passed", "partial"].includes(item.verification?.status || "")), [miniMaxModels]);
  const selectedMiniMaxModel = miniMaxModels.find(item => item.id === model);
  const miniMaxVerificationStatus = selectedMiniMaxModel?.verification?.status;
  const ready = backend === "openai"
    || (backend === "openrouter" && hasApiKey && verifiedModels.some(item => item.id === model) && (verificationStatus === "passed" || (verificationStatus === "partial" && experimentalAcknowledged)))
    || (backend === "nararouter" && naraHasApiKey && naraVerifiedModels.some(item => item.id === model) && (naraVerificationStatus === "passed" || (naraVerificationStatus === "partial" && experimentalAcknowledged)))
    || (backend === "minimax" && miniMaxHasApiKey && miniMaxVerifiedModels.some(item => item.id === model) && (miniMaxVerificationStatus === "passed" || (miniMaxVerificationStatus === "partial" && experimentalAcknowledged)))
;
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
      </div>
      {backend === "openrouter" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{t("session.codexModel")}</span>
            <select className="modal-input" value={model || ""} disabled={loading || verifiedModels.length === 0} onChange={(event) => onModelChange(event.target.value || undefined)}>
              <option value="">{loading ? t("common.loading") : t("session.codexModelSelect")}</option>
              {verifiedModels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id} · {verificationLabel(item)} · {formatOpenRouterPricing(item.pricing, locale, { input: t("settings.openRouterPriceInput"), output: t("settings.openRouterPriceOutput"), unavailable: t("settings.openRouterPriceUnavailable") })}</option>)}
            </select>
          </label>
          {verificationStatus === "partial" && <label className="openrouter-experimental-warning">
            <input type="checkbox" checked={experimentalAcknowledged} onChange={(event) => onExperimentalAcknowledgedChange?.(event.target.checked)} />
            <span>{t("session.openRouterExperimentalAcknowledge")}</span>
          </label>}
          {!ready && <div className="modal-error">{error || (!hasApiKey ? t("session.openRouterKeyRequired") : verificationStatus === "partial" ? t("session.openRouterExperimentalRequired") : verificationStatus === "failed" || verificationStatus === "unavailable" ? selectedModel?.verification?.error || verificationLabel(selectedModel!) : t("session.openRouterVerifiedRequired"))}</div>}
          <span className="modal-hint">{t("session.openRouterModelHint")}</span>
        </>
      )}
      {backend === "nararouter" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{t("session.naraRouterModel")}</span>
            <select className="modal-input" value={model || ""} disabled={naraLoading || naraVerifiedModels.length === 0} onChange={(event) => onModelChange(event.target.value || undefined)}>
              <option value="">{naraLoading ? t("common.loading") : t("session.codexModelSelect")}</option>
              {naraVerifiedModels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id} · {verificationLabel(item)} · {formatOpenRouterPricing(item.pricing, locale, { input: t("settings.openRouterPriceInput"), output: t("settings.openRouterPriceOutput"), unavailable: t("settings.openRouterPriceUnavailable") })}</option>)}
            </select>
          </label>
          {naraVerificationStatus === "partial" && <label className="openrouter-experimental-warning">
            <input type="checkbox" checked={experimentalAcknowledged} onChange={(event) => onExperimentalAcknowledgedChange?.(event.target.checked)} />
            <span>{t("session.openRouterExperimentalAcknowledge")}</span>
          </label>}
          {!ready && <div className="modal-error">{error || (!naraHasApiKey ? t("session.naraRouterKeyRequired") : naraVerificationStatus === "partial" ? t("session.openRouterExperimentalRequired") : naraVerificationStatus === "failed" || naraVerificationStatus === "unavailable" ? selectedNaraModel?.verification?.error || verificationLabel(selectedNaraModel!) : t("session.naraRouterVerifiedRequired"))}</div>}
          <span className="modal-hint">{t("session.naraRouterModelHint")}</span>
        </>
      )}
      {backend === "minimax" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{t("session.miniMaxModel")}</span>
            <select className="modal-input" value={model || ""} disabled={miniMaxLoading || miniMaxVerifiedModels.length === 0} onChange={(event) => onModelChange(event.target.value || undefined)}>
              <option value="">{miniMaxLoading ? t("common.loading") : t("session.codexModelSelect")}</option>
              {miniMaxVerifiedModels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id} · {verificationLabel(item)}</option>)}
            </select>
          </label>
          {miniMaxVerificationStatus === "partial" && <label className="openrouter-experimental-warning">
            <input type="checkbox" checked={experimentalAcknowledged} onChange={(event) => onExperimentalAcknowledgedChange?.(event.target.checked)} />
            <span>{t("session.openRouterExperimentalAcknowledge")}</span>
          </label>}
          {!ready && <div className="modal-error">{error || (!miniMaxHasApiKey ? t("session.miniMaxKeyRequired") : miniMaxVerificationStatus === "partial" ? t("session.openRouterExperimentalRequired") : miniMaxVerificationStatus === "failed" || miniMaxVerificationStatus === "unavailable" ? selectedMiniMaxModel?.verification?.error || verificationLabel(selectedMiniMaxModel!) : t("session.miniMaxVerifiedRequired"))}</div>}
          <span className="modal-hint">{t("session.miniMaxModelHint")}</span>
        </>
      )}
    </fieldset>
  );
}
