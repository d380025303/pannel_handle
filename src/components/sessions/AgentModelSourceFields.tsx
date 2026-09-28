import { useEffect, useState } from "react";
import type { AgentModelSource, AgentProvider, OpenRouterModel } from "../../vite-env";

type Source = Exclude<AgentModelSource, "codebuddy">;
const SOURCES: Array<{ id: Source; label: string }> = [
  { id: "native", label: "原生模型" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "nararouter", label: "NaraRouter" },
  { id: "minimax", label: "MiniMax" }
];

type Props = {
  agent: Extract<AgentProvider, "opencode" | "codebuddy">;
  source: Source;
  modelId?: string;
  onSourceChange: (source: Source) => void;
  onModelChange: (modelId?: string) => void;
  onReadyChange: (ready: boolean) => void;
};

export function AgentModelSourceFields({ agent, source, modelId, onSourceChange, onModelChange, onReadyChange }: Props) {
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (source === "native") { setModels([]); setFavoriteIds([]); setError(""); return; }
    let cancelled = false;
    const api = source === "openrouter" ? window.openRouterApi : source === "nararouter" ? window.naraRouterApi : window.miniMaxApi;
    setLoading(true);
    setError("");
    Promise.all([api.getConfig(), api.listModels()]).then(([config, catalog]) => {
      if (cancelled) return;
      setModels(catalog);
      setFavoriteIds(config.favoriteModelIds);
      setHasApiKey(config.hasApiKey);
      if (!modelId && config.defaultModelId) onModelChange(config.defaultModelId);
    }).catch(reason => { if (!cancelled) setError(String(reason?.message || reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source, agent]);
  const favorites = favoriteIds.map(id => models.find(model => model.id === id)).filter((model): model is OpenRouterModel => Boolean(model));
  const selected = favorites.find(model => model.id === modelId);
  const ready = source === "native" || Boolean(hasApiKey && selected?.agentVerifications?.[agent]?.status === "passed");
  useEffect(() => { onReadyChange(ready); }, [ready, onReadyChange]);
  return <fieldset className="modal-field codex-backend-fields">
    <span className="modal-label">模型来源</span>
    <div className="shell-list agent-provider-list">
      {SOURCES.map(option => <button key={option.id} type="button" className={`shell-item ${source === option.id ? "selected" : ""}`} onClick={() => onSourceChange(option.id)}>{option.label}</button>)}
    </div>
    {source !== "native" && <>
      <label className="modal-field"><span className="modal-label">模型</span>
        <select className="modal-input" value={modelId || ""} disabled={loading} onChange={event => onModelChange(event.target.value || undefined)}>
          <option value="">{loading ? "正在加载" : "选择模型"}</option>
          {favorites.map(model => <option key={model.id} value={model.id} disabled={model.agentVerifications?.[agent]?.status !== "passed"}>{model.name} · {model.id} · {model.agentVerifications?.[agent]?.status === "passed" ? "已验证" : "待验证"}</option>)}
        </select>
      </label>
      {!ready && <div className="modal-error">{error || (!hasApiKey ? "请先在模型设置中配置 API Key。" : selected?.agentVerifications?.[agent]?.error || "请在模型设置中收藏并验证该模型。")}</div>}
    </>}
  </fieldset>;
}
