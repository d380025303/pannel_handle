import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatOpenRouterPricing } from "../../utils/openRouterPricing";
import { MiniMaxUsageSection } from "./MiniMaxUsageSection";
import type { OpenRouterConfig, OpenRouterModel } from "../../vite-env";

function verificationStageKey(stage?: string) {
  if (stage === "responses") return "settings.openRouterStageResponses" as const;
  if (stage === "function_tools") return "settings.openRouterStageFunctionTools" as const;
  return "settings.openRouterStageCodexTools" as const;
}

function isFreeOpenRouterModel(model: OpenRouterModel) {
  const id = model.id.toLowerCase();
  return id === "openrouter/free" || id.endsWith(":free");
}

function isFreeRouterModel(model: OpenRouterModel, isNaraRouter: boolean) {
  return isNaraRouter ? model.freeTierEligible === true : isFreeOpenRouterModel(model);
}

type RouterSettingsProps = {
  provider?: "openrouter" | "nararouter" | "minimax";
};

export function OpenRouterSettings({ provider = "openrouter" }: RouterSettingsProps) {
  const { locale, t } = useI18n();
  const isNaraRouter = provider === "nararouter";
  const isMiniMax = provider === "minimax";
  const providerName = isNaraRouter ? "NaraRouter" : isMiniMax ? "MiniMax" : "OpenRouter";
  const routerApi = isNaraRouter ? window.naraRouterApi : isMiniMax ? window.miniMaxApi : window.openRouterApi;
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<OpenRouterConfig>({ hasApiKey: false });
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifyingModelId, setVerifyingModelId] = useState("");
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const load = async () => {
    const [nextConfig, nextModels] = await Promise.all([routerApi.getConfig(), routerApi.listModels()]);
    setConfig(nextConfig);
    setModels(nextModels);
  };

  useEffect(() => { void load().catch((error) => setResult({ kind: "error", message: String(error?.message || error) })); }, []);

  const compatibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter(model => (!needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))
      && (!freeOnly || isFreeRouterModel(model, isNaraRouter)));
  }, [freeOnly, isNaraRouter, models, query]);

  const verificationText = (model: OpenRouterModel) => {
    return verificationResultText(model.verification);
  };

  const verificationResultText = (verification: OpenRouterModel["verification"]) => {
    if (!verification) return t("settings.openRouterVerificationPending");
    if (verification.status === "passed") return t("settings.openRouterVerificationPassed");
    const stage = verification.failedStage ? `${t(verificationStageKey(verification.failedStage))} · ` : "";
    if (verification.status === "partial") {
      const detail = verification.error ? ` ${t("settings.openRouterProviderDetail")}：${verification.error}` : "";
      const message = verification.errorKind === "rate_limit"
        ? t("settings.openRouterVerificationPartialRateLimit")
        : verification.error || "";
      return `${t("settings.openRouterVerificationPartial")}：${stage}${message}${verification.errorKind === "rate_limit" ? detail : ""}`;
    }
    if (verification.status === "unavailable") return `${t("settings.openRouterVerificationUnavailable")}：${stage}${verification.errorKind === "rate_limit" ? t(isNaraRouter ? "settings.naraRouterRateLimitHint" : isMiniMax ? "settings.miniMaxRateLimitHint" : "settings.openRouterRateLimitHint") : verification.error || ""}`;
    if (verification.failedStage === "responses" && verification.errorKind === "unsupported") {
      const detail = verification.error ? ` ${t("settings.openRouterProviderDetail")}：${verification.error}` : "";
      return `${t("settings.openRouterVerificationFailed")}：${stage}${t("settings.openRouterResponsesRejected")}${detail}`;
    }
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

  const verifyModel = async (modelId: string) => {
    setVerifyingModelId(modelId);
    setResult(null);
    try {
      const [verification] = await routerApi.verifyModels({ modelIds: [modelId], force: true });
      await load();
      if (verification.status === "failed" || verification.status === "unavailable") {
        throw new Error(`${modelId}：${verificationResultText(verification)}`);
      }
      setResult({ kind: "success", message: verification.status === "partial" ? t("settings.openRouterVerificationPartialSuccess") : t(isNaraRouter ? "settings.naraRouterVerificationSuccess" : isMiniMax ? "settings.miniMaxVerificationSuccess" : "settings.openRouterVerificationSuccess") });
    } catch (error) {
      setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setVerifyingModelId("");
    }
  };

  const verifyAgentModel = async (modelId: string, agent: "opencode" | "codebuddy") => {
    setVerifyingModelId(`${agent}:${modelId}`);
    setResult(null);
    try {
      const [verification] = await routerApi.verifyAgentModels({ agent, modelIds: [modelId], force: true });
      await load();
      if (verification.status !== "passed") throw new Error(`${agent} · ${modelId}：${verification.error || "验证失败"}`);
      setResult({ kind: "success", message: `${agent} · ${modelId} 验证通过` });
    } catch (error) {
      setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally { setVerifyingModelId(""); }
  };

  return (
    <section className="settings-section openrouter-settings">
      <div className="collapsible-header" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(value => !value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(value => !value); } }}>
        <span className={`collapsible-chevron${open ? "" : " collapsed"}`} aria-hidden="true">▾</span>
        <h4>{providerName}</h4>
        <span className="settings-section-status">{config.hasApiKey ? t("settings.openRouterConfigured") : t("settings.openRouterNotConfigured")}</span>
      </div>
      {open && <>
        <p className="settings-help">{t(isNaraRouter ? "settings.naraRouterDescription" : isMiniMax ? "settings.miniMaxDescription" : "settings.openRouterDescription")}</p>
        <label className="settings-field">
          <span className="modal-label">API Key</span>
          <input className="modal-input" type="password" autoComplete="off" disabled={busy} value={apiKey} placeholder={config.hasApiKey ? t("settings.openRouterKeyStored") : isNaraRouter ? "sk-nry-..." : isMiniMax ? "sk-cp-... / sk-api-..." : "sk-or-v1-..."} onChange={event => setApiKey(event.target.value)} />
        </label>
        <div className="settings-actions">
          <button className="modal-button primary" type="button" disabled={busy || !apiKey.trim()} onClick={() => void run(async () => { await routerApi.saveApiKey(apiKey.trim()); setApiKey(""); }, t(isNaraRouter ? "settings.naraRouterSaved" : isMiniMax ? "settings.miniMaxSaved" : "settings.openRouterSaved"))}>{t("common.save")}</button>
          <button className="modal-button" type="button" disabled={busy || !config.hasApiKey} onClick={() => void run(async () => { await routerApi.test(); }, t(isNaraRouter ? "settings.naraRouterTestSuccess" : isMiniMax ? "settings.miniMaxTestSuccess" : "settings.openRouterTestSuccess"))}>{t("settings.openRouterTest")}</button>
          <button className="modal-button danger" type="button" disabled={busy || !config.hasApiKey} onClick={() => void run(async () => { await routerApi.clearApiKey(); }, t(isNaraRouter ? "settings.naraRouterCleared" : isMiniMax ? "settings.miniMaxCleared" : "settings.openRouterCleared"))}>{t("settings.openRouterClear")}</button>
          <button className="modal-button" type="button" disabled={busy || ((isNaraRouter || isMiniMax) && !config.hasApiKey)} onClick={() => void run(async () => { setModels(await routerApi.refreshModels()); }, t(isNaraRouter ? "settings.naraRouterModelsRefreshed" : isMiniMax ? "settings.miniMaxModelsRefreshed" : "settings.openRouterModelsRefreshed"))}>{t("settings.openRouterRefreshModels")}</button>
        </div>
        {isMiniMax && <MiniMaxUsageSection hasApiKey={config.hasApiKey} />}
        <label className="settings-field">
          <span className="modal-label">{t("settings.openRouterModels")}</span>
          <input className="modal-input" type="search" value={query} placeholder={t("common.search")} onChange={event => setQuery(event.target.value)} />
        </label>
        {!isMiniMax && <label className="auto-restore-label">
          <input type="checkbox" className="auto-restore-checkbox" checked={freeOnly} onChange={event => setFreeOnly(event.target.checked)} />
          <span className="auto-restore-track" />
          <span className="auto-restore-text">{t("settings.openRouterFreeModelsOnly")}</span>
        </label>}
        <div className="openrouter-model-list">
          {compatibleModels.map(model => <div key={model.id} className="openrouter-model-row">
            <span><strong>{model.name}</strong><small>{model.id}</small><small className="openrouter-model-price">{formatOpenRouterPricing(model.pricing, locale, { input: t("settings.openRouterPriceInput"), output: t("settings.openRouterPriceOutput"), unavailable: t("settings.openRouterPriceUnavailable") })}</small><small className={`openrouter-verification ${model.verification?.status || "pending"}`}>Codex：{verificationText(model)}</small>{(["opencode", "codebuddy"] as const).map(agent => <small key={agent} className={`openrouter-verification ${model.agentVerifications?.[agent]?.status || "pending"}`}>{agent === "opencode" ? "OpenCode" : "CodeBuddy"}：{model.agentVerifications?.[agent]?.status === "passed" ? "已通过" : model.agentVerifications?.[agent]?.error || "待验证"}</small>)}</span>
            <span className="openrouter-model-actions">
              <button className="modal-button compact" type="button" disabled={busy || Boolean(verifyingModelId)} onClick={() => void verifyModel(model.id)}>{verifyingModelId === model.id ? t("settings.openRouterVerifying") : t("settings.openRouterVerifyRetry")}</button>
              {(["opencode", "codebuddy"] as const).map(agent => <button key={agent} className="modal-button compact" type="button" disabled={busy || Boolean(verifyingModelId) || !config.hasApiKey} onClick={() => void verifyAgentModel(model.id, agent)}>{verifyingModelId === `${agent}:${model.id}` ? "验证中" : `验证 ${agent === "opencode" ? "OpenCode" : "CodeBuddy"}`}</button>)}
            </span>
          </div>)}
          {!models.length && <p className="settings-help">{t(isNaraRouter ? "settings.naraRouterRefreshHint" : isMiniMax ? "settings.miniMaxRefreshHint" : "settings.openRouterRefreshHint")}</p>}
          {Boolean(models.length) && !compatibleModels.length && <p className="settings-help">{t("settings.openRouterNoMatchingModels")}</p>}
        </div>
        <p className="settings-help">{t("settings.openRouterNewSessionsHint")}</p>
        {result && <p className={`settings-result ${result.kind}`} role="status">{result.message}</p>}
      </>}
    </section>
  );
}
