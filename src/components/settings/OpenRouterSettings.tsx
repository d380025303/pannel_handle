import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatOpenRouterPricing } from "../../utils/openRouterPricing";
import type { OpenRouterApi, OpenRouterConfig, OpenRouterModel } from "../../vite-env";

type Provider = "openrouter" | "nararouter" | "minimax";
type Agent = "codex" | "opencode" | "codebuddy";
const providers: Array<{ id: Provider; name: string }> = [
  { id: "openrouter", name: "OpenRouter" },
  { id: "nararouter", name: "NaraRouter" },
  { id: "minimax", name: "MiniMax" }
];
const agents: Array<{ id: Agent; name: string }> = [
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "codebuddy", name: "CodeBuddy" }
];
const providerApi = (provider: Provider): OpenRouterApi => provider === "nararouter" ? window.naraRouterApi : provider === "minimax" ? window.miniMaxApi : window.openRouterApi;

export function ModelServicesSettings() {
  const { t } = useI18n();
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [configured, setConfigured] = useState<Partial<Record<Provider, boolean>>>({});
  const [drafts, setDrafts] = useState<Record<Provider, string>>({ openrouter: "", nararouter: "", minimax: "" });
  useEffect(() => {
    let disposed = false;
    void Promise.allSettled(providers.map(item => Promise.resolve().then(() => providerApi(item.id).getConfig()))).then(results => {
      if (disposed) return;
      const next: Partial<Record<Provider, boolean>> = {};
      results.forEach((result, index) => { if (result.status === "fulfilled") next[providers[index].id] = result.value.hasApiKey; });
      setConfigured(next);
    });
    return () => { disposed = true; };
  }, []);
  return <div className="model-services-workflow">
    <div className="model-provider-switcher" role="group" aria-label={t("settings.modelProviderSelect")}>
      {providers.map(item => <button key={item.id} type="button" className={`model-provider-option${provider === item.id ? " active" : ""}`} aria-pressed={provider === item.id} onClick={() => setProvider(item.id)}><strong>{item.name}</strong><small>{configured[item.id] === undefined ? t("common.loading") : configured[item.id] ? t("settings.openRouterConfigured") : t("settings.openRouterNotConfigured")}</small></button>)}
    </div>
    <OpenRouterSettings key={provider} provider={provider} apiKeyDraft={drafts[provider]} onApiKeyDraftChange={value => setDrafts(current => ({ ...current, [provider]: value }))} onConfigChange={hasApiKey => setConfigured(current => ({ ...current, [provider]: hasApiKey }))} />
  </div>;
}

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
  provider?: Provider;
  onConfigChange?: (hasApiKey: boolean) => void;
  apiKeyDraft?: string;
  onApiKeyDraftChange?: (value: string) => void;
};

export function OpenRouterSettings({ provider = "openrouter", onConfigChange, apiKeyDraft, onApiKeyDraftChange }: RouterSettingsProps) {
  const { locale, t } = useI18n();
  const isNaraRouter = provider === "nararouter";
  const isMiniMax = provider === "minimax";
  const providerName = isNaraRouter ? "NaraRouter" : isMiniMax ? "MiniMax" : "OpenRouter";
  const routerApi = isNaraRouter ? window.naraRouterApi : isMiniMax ? window.miniMaxApi : window.openRouterApi;
  const [config, setConfig] = useState<OpenRouterConfig>({ hasApiKey: false });
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [localApiKey, setLocalApiKey] = useState("");
  const apiKey = apiKeyDraft ?? localApiKey;
  const setApiKey = onApiKeyDraftChange ?? setLocalApiKey;
  const [query, setQuery] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifyingAgent, setVerifyingAgent] = useState<Agent | null>(null);
  const [connectionResult, setConnectionResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [catalogResult, setCatalogResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [verificationResult, setVerificationResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [verificationResultModelId, setVerificationResultModelId] = useState("");

  const load = async () => {
    const [nextConfig, nextModels] = await Promise.all([routerApi.getConfig(), routerApi.listModels()]);
    setConfig(nextConfig);
    setModels(nextModels);
    onConfigChange?.(nextConfig.hasApiKey);
  };

  useEffect(() => { void load().catch((error) => setCatalogResult({ kind: "error", message: String(error?.message || error) })).finally(() => setLoading(false)); }, []);

  const compatibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter(model => (!needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))
      && (!freeOnly || isFreeRouterModel(model, isNaraRouter)));
  }, [freeOnly, isNaraRouter, models, query]);
  const selectedModel = compatibleModels.find(model => model.id === selectedModelId) || compatibleModels[0];
  const modelStatus = (model: OpenRouterModel, agent: Agent) => agent === "codex" ? model.verification?.status || "pending" : model.agentVerifications?.[agent]?.status || "pending";
  const statusText = (status: string) => t(status === "passed" ? "settings.openRouterVerificationPassed" : status === "partial" ? "settings.openRouterVerificationPartial" : status === "failed" ? "settings.openRouterVerificationFailed" : status === "unavailable" ? "settings.openRouterVerificationUnavailable" : "settings.openRouterVerificationPending");

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

  const run = async (action: () => Promise<void>, successMessage: string, area: "connection" | "catalog") => {
    setBusy(true);
    const setResult = area === "connection" ? setConnectionResult : setCatalogResult;
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
    setVerifyingAgent("codex");
    setVerificationResult(null);
    setVerificationResultModelId(modelId);
    try {
      const [verification] = await routerApi.verifyModels({ modelIds: [modelId], force: true });
      await load();
      if (verification.status === "failed" || verification.status === "unavailable") {
        throw new Error(`${modelId}：${verificationResultText(verification)}`);
      }
      setVerificationResult({ kind: "success", message: verification.status === "partial" ? t("settings.openRouterVerificationPartialSuccess") : t(isNaraRouter ? "settings.naraRouterVerificationSuccess" : isMiniMax ? "settings.miniMaxVerificationSuccess" : "settings.openRouterVerificationSuccess") });
    } catch (error) {
      setVerificationResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setVerifyingAgent(null);
    }
  };

  const verifyAgentModel = async (modelId: string, agent: "opencode" | "codebuddy") => {
    setVerifyingAgent(agent);
    setVerificationResult(null);
    setVerificationResultModelId(modelId);
    try {
      const [verification] = await routerApi.verifyAgentModels({ agent, modelIds: [modelId], force: true });
      await load();
      if (verification.status !== "passed") throw new Error(`${agent} · ${modelId}：${verification.error || "验证失败"}`);
      setVerificationResult({ kind: "success", message: `${agents.find(item => item.id === agent)!.name} · ${modelId} ${t("settings.openRouterVerificationPassed")}` });
    } catch (error) {
      setVerificationResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally { setVerifyingAgent(null); }
  };

  return <div className="model-service-steps">
    <section className="settings-section model-service-step" aria-labelledby="model-connection-heading">
      <div className="model-step-heading"><span className="model-step-number">1</span><div><h3 id="model-connection-heading">{t("settings.modelConnectionTitle")}</h3><p>{t(isNaraRouter ? "settings.naraRouterDescription" : isMiniMax ? "settings.miniMaxDescription" : "settings.openRouterDescription")}</p></div><span className={`model-step-state${config.hasApiKey ? " ready" : ""}`}>{loading ? t("common.loading") : config.hasApiKey ? t("settings.openRouterConfigured") : t("settings.openRouterNotConfigured")}</span></div>
      <label className="settings-field"><span className="modal-label">{providerName} API Key</span><input className="modal-input" type="password" autoComplete="off" disabled={busy} value={apiKey} placeholder={config.hasApiKey ? t("settings.openRouterKeyStored") : isNaraRouter ? "sk-nry-..." : isMiniMax ? "sk-cp-... / sk-api-..." : "sk-or-v1-..."} onChange={event => setApiKey(event.target.value)} /></label>
      <div className="settings-actions">
        <button className="modal-button primary" type="button" disabled={busy || !apiKey.trim()} onClick={() => void run(async () => { await routerApi.saveApiKey(apiKey.trim()); setApiKey(""); }, t(isNaraRouter ? "settings.naraRouterSaved" : isMiniMax ? "settings.miniMaxSaved" : "settings.openRouterSaved"), "connection")}>{t("common.save")}</button>
        <button className="modal-button" type="button" disabled={busy || !config.hasApiKey} onClick={() => void run(async () => { await routerApi.test(); }, t(isNaraRouter ? "settings.naraRouterTestSuccess" : isMiniMax ? "settings.miniMaxTestSuccess" : "settings.openRouterTestSuccess"), "connection")}>{t("settings.openRouterTest")}</button>
        <button className="modal-button danger" type="button" disabled={busy || !config.hasApiKey} onClick={() => void run(async () => { await routerApi.clearApiKey(); }, t(isNaraRouter ? "settings.naraRouterCleared" : isMiniMax ? "settings.miniMaxCleared" : "settings.openRouterCleared"), "connection")}>{t("settings.openRouterClear")}</button>
      </div>
      {connectionResult && <p className={`settings-result ${connectionResult.kind}`} role="status">{connectionResult.message}</p>}
    </section>
    <section className="settings-section model-service-step" aria-labelledby="model-catalog-heading">
      <div className="model-step-heading"><span className="model-step-number">2</span><div><h3 id="model-catalog-heading">{t("settings.modelCatalogTitle")}</h3><p>{t("settings.modelCatalogHint")}</p></div><button className="modal-button" type="button" disabled={busy || Boolean(verifyingAgent) || ((isNaraRouter || isMiniMax) && !config.hasApiKey)} onClick={() => void run(async () => { await routerApi.refreshModels(); }, t(isNaraRouter ? "settings.naraRouterModelsRefreshed" : isMiniMax ? "settings.miniMaxModelsRefreshed" : "settings.openRouterModelsRefreshed"), "catalog")}>{t("settings.openRouterRefreshModels")}</button></div>
      <div className="model-catalog-filters"><label className="settings-field"><span className="modal-label">{t("settings.modelSearchLabel")}</span><input className="modal-input" type="search" value={query} placeholder={t("common.search")} onChange={event => setQuery(event.target.value)} /></label>{!isMiniMax && <label className="auto-restore-label"><input type="checkbox" className="auto-restore-checkbox" checked={freeOnly} onChange={event => setFreeOnly(event.target.checked)} /><span className="auto-restore-track" /><span className="auto-restore-text">{t("settings.openRouterFreeModelsOnly")}</span></label>}</div>
      <div className="model-catalog-list" aria-label={t("settings.modelCatalogTitle")}>
        {compatibleModels.map(model => <button key={model.id} type="button" className={`model-catalog-item${selectedModel?.id === model.id ? " selected" : ""}`} aria-pressed={selectedModel?.id === model.id} onClick={() => { setSelectedModelId(model.id); setVerificationResult(null); }}><span className="model-catalog-name"><strong>{model.name}</strong><small>{model.id}</small></span><small className="model-catalog-price">{formatOpenRouterPricing(model.pricing, locale, { input: t("settings.openRouterPriceInput"), output: t("settings.openRouterPriceOutput"), unavailable: t("settings.openRouterPriceUnavailable") })}</small><span className="model-catalog-statuses">{agents.map(agent => <small key={agent.id} className={`model-status ${modelStatus(model, agent.id)}`}>{agent.name} · {statusText(modelStatus(model, agent.id))}</small>)}</span></button>)}
        {!models.length && <p className="settings-help">{t(isNaraRouter ? "settings.naraRouterRefreshHint" : isMiniMax ? "settings.miniMaxRefreshHint" : "settings.openRouterRefreshHint")}</p>}
        {Boolean(models.length) && !compatibleModels.length && <p className="settings-help">{t("settings.openRouterNoMatchingModels")}</p>}
      </div>
      {catalogResult && <p className={`settings-result ${catalogResult.kind}`} role="status">{catalogResult.message}</p>}
    </section>
    <section className="settings-section model-service-step" aria-labelledby="model-verification-heading">
      <div className="model-step-heading"><span className="model-step-number">3</span><div><h3 id="model-verification-heading">{t("settings.modelVerificationTitle")}</h3><p>{t("settings.modelVerificationHint")}</p></div></div>
      {selectedModel ? <><div className="model-selection-summary"><strong>{selectedModel.name}</strong><small>{selectedModel.id}</small></div><div className="model-agent-list">{agents.map(agent => {
        const currentStatus = modelStatus(selectedModel, agent.id);
        const detail = agent.id === "codex" ? verificationResultText(selectedModel.verification) : selectedModel.agentVerifications?.[agent.id]?.error || statusText(currentStatus);
        return <div key={agent.id} className="model-agent-row"><div><strong>{agent.name}</strong><span className={`model-status ${currentStatus}`}>{statusText(currentStatus)}</span><p>{detail}</p></div><button className="modal-button compact" type="button" disabled={busy || Boolean(verifyingAgent) || !config.hasApiKey} onClick={() => void (agent.id === "codex" ? verifyModel(selectedModel.id) : verifyAgentModel(selectedModel.id, agent.id))}>{verifyingAgent === agent.id ? t("settings.openRouterVerifying") : t("settings.openRouterVerifyRetry")}</button></div>;
      })}</div><p className="settings-help">{t("settings.openRouterNewSessionsHint")}</p></> : <p className="settings-help">{t("settings.modelSelectHint")}</p>}
      {verificationResult && selectedModel?.id === verificationResultModelId && <p className={`settings-result ${verificationResult.kind}`} role="status">{verificationResult.message}</p>}
    </section>
  </div>;
}
