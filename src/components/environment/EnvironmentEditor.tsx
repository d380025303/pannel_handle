import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n";
import type { EnvironmentEntry } from "../../vite-env";

export function parseEnvironmentText(text: string): EnvironmentEntry[] {
  return text.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith("#")).map(line => {
    const split = line.indexOf("=");
    if (split < 1) throw new Error("每行应为 KEY=VALUE。");
    return { name: line.slice(0, split).trim(), value: line.slice(split + 1) };
  });
}

export function EnvironmentEditor({ value, onChange }: { value: EnvironmentEntry[]; onChange: (value: EnvironmentEntry[]) => void }) {
  const { t } = useI18n();
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");

  const appendPaste = () => {
    try {
      onChange([...value, ...parseEnvironmentText(paste)]);
      setPaste("");
      setError("");
    } catch {
      setError(t("settings.environmentPasteError"));
    }
  };

  return (
    <div className="environment-editor">
      <div className="environment-editor-heading">
        <div>
          <strong>{t("settings.environmentVariables")}</strong>
          <span>{t("settings.environmentVariableCount", { count: value.length })}</span>
        </div>
        <button className="modal-button compact" type="button" onClick={() => onChange([...value, { name: "", value: "" }])}>
          <Plus aria-hidden="true" />
          {t("settings.environmentAddVariable")}
        </button>
      </div>

      <div className="environment-table" role="table" aria-label={t("settings.environmentVariables")}>
        <div className="environment-row environment-row-header" role="row">
          <span role="columnheader">{t("settings.environmentVariableName")}</span>
          <span role="columnheader">{t("settings.environmentVariableValue")}</span>
          <span aria-hidden="true" />
        </div>
        {value.map((entry, index) => (
          <div className="environment-row" role="row" key={index}>
            <input
              className="modal-input"
              aria-label={`${t("settings.environmentVariableName")} ${index + 1}`}
              placeholder="HTTP_PROXY"
              value={entry.name}
              onChange={event => onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))}
            />
            <input
              className="modal-input environment-value-input"
              aria-label={`${t("settings.environmentVariableValue")} ${index + 1}`}
              placeholder="http://127.0.0.1:7892"
              value={entry.value}
              onChange={event => onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))}
            />
            <button
              type="button"
              className="icon-button danger environment-remove-button"
              title={t("settings.environmentRemoveVariable")}
              aria-label={`${t("settings.environmentRemoveVariable")} ${index + 1}`}
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        ))}
        {value.length === 0 && (
          <div className="environment-empty" role="row">
            <span>{t("settings.environmentEmpty")}</span>
            <button className="modal-button compact" type="button" onClick={() => onChange([{ name: "", value: "" }])}>
              <Plus aria-hidden="true" />
              {t("settings.environmentAddFirstVariable")}
            </button>
          </div>
        )}
      </div>

      <details className="environment-paste">
        <summary>{t("settings.environmentPasteTitle")}</summary>
        <div className="environment-paste-body">
          <p>{t("settings.environmentPasteHint")}</p>
          <textarea
            className="modal-input modal-textarea"
            aria-label={t("settings.environmentPasteAria")}
            rows={5}
            placeholder={"HTTP_PROXY=http://127.0.0.1:7892\nFEATURE_ENABLED=true"}
            value={paste}
            onChange={event => setPaste(event.target.value)}
          />
          <div className="environment-paste-actions">
            <button className="modal-button" type="button" disabled={!paste.trim()} onClick={appendPaste}>
              {t("settings.environmentAppend")}
            </button>
          </div>
          {error && <div role="alert" className="settings-result error">{error}</div>}
        </div>
      </details>
    </div>
  );
}
