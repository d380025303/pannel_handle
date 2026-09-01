import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatOpenRouterPricing } from "../../utils/openRouterPricing";
import type { CodeBuddyCodexModel, CodeBuddyCodexStatus, CodexBackend, OpenRouterModel } from "../../vite-env";

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
  const [codeBuddyModels, setCodeBuddyModels] = useState<CodeBuddyCodexModel[]>([]);
  const [codeBuddyStatus, setCodeBuddyStatus] = useState<CodeBuddyCodexStatus>();
  const [codeBuddyLoading, setCodeBuddyLoading] = useState(false);
  const [verifyingModel, setVerifyingModel] = useState("");

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

  useEffect(() => {
    if (backend !== "codebuddy") return;
    let disposed = false;
    setCodeBuddyLoading(true);
    setError("");
    Promise.all([window.codeBuddyCodexApi.getStatus(), window.codeBuddyCodexApi.listModels()])
      .then(([status, catalog]) => {
        if (disposed) return;
        setCodeBuddyStatus(status);
        setCodeBuddyModels(catalog);
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
  const selectedCodeBuddyModel = codeBuddyModels.find(item => item.id === model);
  const codeBuddyReady = codeBuddyStatus?.available === true && selectedCodeBuddyModel?.verification?.status === "passed" && experimentalAcknowledged;
  const ready = backend === "openai"
    || (backend === "openrouter" && hasApiKey && Boolean(model) && (verificationStatus === "passed" || (verificationStatus === "partial" && experimentalAcknowledged)))
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

  const selectCodeBuddyModel = async (modelId?: string) => {
    onModelChange(modelId);
    onExperimentalAcknowledgedChange?.(false);
    if (!modelId) return;
    setVerifyingModel(modelId);
    setError("");
    try {
      const verification = await window.codeBuddyCodexApi.verifyModel({ modelId });
      setCodeBuddyModels(current => current.map(item => item.id === modelId ? { ...item, verification } : item));
      if (verification.status !== "passed") setError(verification.error || (locale === "en-US" ? "The model failed Codex compatibility verification." : "该模型未通过 Codex 兼容性检测。"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVerifyingModel("");
    }
  };

  return (
    <fieldset className="modal-field codex-backend-fields">
      <span className="modal-label">{t("session.codexBackend")}</span>
      <div className="shell-list agent-provider-list">
        <button type="button" className={`shell-item ${backend === "openai" ? "selected" : ""}`} onClick={() => onBackendChange("openai")}>{t("session.codexBackendOpenAI")}</button>
        <button type="button" className={`shell-item ${backend === "openrouter" ? "selected" : ""}`} onClick={() => onBackendChange("openrouter")}>OpenRouter</button>
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
      {backend === "codebuddy" && (
        <>
          <label className="modal-field">
            <span className="modal-label">{locale === "en-US" ? "CodeBuddy model" : "CodeBuddy 模型"}</span>
            <select className="modal-input" value={model || ""} disabled={codeBuddyLoading || Boolean(verifyingModel) || codeBuddyModels.length === 0} onChange={(event) => void selectCodeBuddyModel(event.target.value || undefined)}>
              <option value="">{codeBuddyLoading ? t("common.loading") : locale === "en-US" ? "Select a model" : "选择模型"}</option>
              {codeBuddyModels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.verification?.status === "passed" ? (locale === "en-US" ? "verified" : "已验证") : (locale === "en-US" ? "verification required" : "需要验证")}</option>)}
            </select>
          </label>
          {verifyingModel && <span className="modal-hint">{locale === "en-US" ? `Verifying ${verifyingModel} with three live requests...` : `正在用 3 次真实请求验证 ${verifyingModel}...`}</span>}
          {selectedCodeBuddyModel?.verification?.status === "passed" && <label className="openrouter-experimental-warning">
            <input type="checkbox" checked={experimentalAcknowledged} onChange={(event) => onExperimentalAcknowledgedChange?.(event.target.checked)} />
            <span>{locale === "en-US" ? `I understand this private bridge is pinned to CodeBuddy ${codeBuddyStatus?.supportedMinor || "2.142"}.x and may break after an upgrade.` : `我已了解该私有桥仅兼容 CodeBuddy ${codeBuddyStatus?.supportedMinor || "2.142"}.x，升级后可能失效。`}</span>
          </label>}
          {!ready && <div className="modal-error">{error || codeBuddyStatus?.error || (selectedCodeBuddyModel?.verification?.status === "passed" ? (locale === "en-US" ? "Acknowledge the experimental risk to continue." : "请确认实验性风险后继续。") : (locale === "en-US" ? "Select a model and complete compatibility verification." : "请选择模型并完成兼容性检测。"))}</div>}
          <span className="modal-hint">{locale === "en-US" ? `Codex remains the agent; model requests use the signed-in Windows CodeBuddy ${codeBuddyStatus?.version || ""}.` : `Agent 仍为 Codex；模型请求复用 Windows 已登录的 CodeBuddy ${codeBuddyStatus?.version || ""}。`}</span>
        </>
      )}
    </fieldset>
  );
}
