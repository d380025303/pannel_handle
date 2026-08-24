import { useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n";
import type { CodexBackend, OpenRouterModel } from "../../vite-env";
import { SearchableSelect } from "../shared/SearchableSelect";

type CodexBackendFieldsProps = {
  backend: CodexBackend;
  model: string;
  onBackendChange: (backend: CodexBackend) => void;
  onModelChange: (model: string) => void;
};

function formatModelLabel(model: OpenRouterModel) {
  const details = [model.name];
  if (model.contextLength) details.push(`${Math.round(model.contextLength / 1000)}K ctx`);
  const prompt = Number(model.promptPrice);
  const completion = Number(model.completionPrice);
  if (Number.isFinite(prompt) && Number.isFinite(completion)) {
    details.push(`$${(prompt * 1_000_000).toFixed(2)}/$${(completion * 1_000_000).toFixed(2)} per M`);
  }
  return details.join(" · ");
}

export function CodexBackendFields({ backend, model, onBackendChange, onModelChange }: CodexBackendFieldsProps) {
  const { t } = useI18n();
  const listId = useId();
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadModels = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const result = await window.openRouterApi.listModels({ force });
      setModels(result.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (backend === "openrouter") void loadModels();
  }, [backend]);

  return (
    <div className="codex-backend-fields">
      <label className="modal-field">
        <span className="modal-label">{t("session.codexBackend")}</span>
        <SearchableSelect
          value={backend}
          options={[{ value: "openai", label: "OpenAI" }, { value: "openrouter", label: "OpenRouter" }]}
          ariaLabel={t("session.codexBackend")}
          onChange={(value) => onBackendChange(value as CodexBackend)}
        />
      </label>
      {backend === "openrouter" && (
        <label className="modal-field">
          <span className="modal-label codex-model-label">
            {t("session.openRouterModel")}
            <button type="button" className="inline-link-button" disabled={loading} onClick={() => void loadModels(true)}>
              {loading ? t("common.loading") : t("common.refresh")}
            </button>
          </span>
          <input className="modal-input" list={listId} value={model} placeholder="openai/gpt-5.4" autoComplete="off" onChange={(event) => onModelChange(event.target.value)} />
          <datalist id={listId}>
            {models.map((entry) => <option key={entry.id} value={entry.id} label={formatModelLabel(entry)} />)}
          </datalist>
          {error
            ? <span className="settings-help error">{error}</span>
            : <span className="settings-help">{t("session.openRouterModelHint")}</span>}
        </label>
      )}
    </div>
  );
}
