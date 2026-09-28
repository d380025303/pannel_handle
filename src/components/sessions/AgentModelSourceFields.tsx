import { useEffect, useState } from "react";
import type { AgentModelSource, AgentProvider, OpenRouterModel } from "../../vite-env";

type Source = AgentModelSource;
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
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (source === "native") { setModels([]); setError(""); return; }
    let cancelled = false;
    const api = source === "openrouter" ? window.openRouterApi : source === "nararouter" ? window.naraRouterApi : window.miniMaxApi;
    setLoading(true);
    setError("");
    Promise.all([api.getConfig(), api.listModels()]).then(([config, catalog]) => {
      if (cancelled) return;
      setModels(catalog);
      setHasApiKey(config.hasApiKey);
    }).catch(reason => { if (!cancelled) setError(String(reason?.message || reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source, agent]);
  const verifiedModels = models.filter(model => model.agentVerifications?.[agent]?.status === "passed");
  const selected = verifiedModels.find(model => model.id === modelId);
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
          {verifiedModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id} · 已验证</option>)}
        </select>
      </label>
      {!ready && <div className="modal-error">{error || (!hasApiKey ? "请先在模型设置中配置 API Key。" : "请选择已通过对应 Agent 验证的模型。")}</div>}
    </>}
  </fieldset>;
}
