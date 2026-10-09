import { useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { graphicalMenuActions, graphicalMenuProviders, normalizeGraphicalMenuConfig } from "../../utils/graphicalMenu";
import { useGraphicalMenuConfig } from "../../utils/useGraphicalMenuConfig";

const providerNames: Record<string, string> = { codex: "Codex", codebuddy: "CodeBuddy", opencode: "OpenCode", claude: "Claude", qoder: "Qoder", gemini: "Gemini", grok: "Grok" };

export function GraphicalMenuSettings({ initialProvider = "codex", onBusyChange }: { initialProvider?: string; onBusyChange?: (busy: boolean) => void }) {
  const { t, locale } = useI18n();
  const { config, setConfig, loading, error: loadError } = useGraphicalMenuConfig();
  const [provider, setProvider] = useState(() => graphicalMenuProviders.includes(initialProvider) ? initialProvider : "codex");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const selected = config[provider] || [];
  async function save(actions: string[]) {
    if (pending.current || loading || loadError) return;
    pending.current = true;
    setBusy(true); onBusyChange?.(true); setError("");
    try {
      const value = await window.terminalApi.setConfig({ graphicalMenuSecondaryActions: { ...config, [provider]: actions } });
      setConfig(normalizeGraphicalMenuConfig(value.graphicalMenuSecondaryActions));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); onBusyChange?.(false); }
  }
  return <section className="graphical-menu-settings">
    <p className="settings-help">{t("settings.graphicalMenuHint")}</p>
    <div className="graphical-menu-settings-toolbar">
      <label>{t("settings.graphicalMenuAgent")}
        <select aria-label={t("settings.graphicalMenuAgent")} value={provider} disabled={busy} onChange={event => setProvider(event.target.value)}>
          {graphicalMenuProviders.map(id => <option key={id} value={id}>{providerNames[id]}</option>)}
        </select>
      </label>
      <button className="modal-button" type="button" disabled={loading || busy || Boolean(loadError) || !selected.length} onClick={() => void save([])}>{t("settings.graphicalMenuReset")}</button>
    </div>
    <div className="graphical-menu-settings-list">
      {graphicalMenuActions.filter(action => action.providers.includes(provider)).map(action => {
        const platform = action.platform || (action.platforms as Record<string, string> | undefined)?.[provider];
        const label = locale === "en-US" ? action.labelEn : action.label;
        return <label key={action.id} className="graphical-menu-settings-row">
          <input type="checkbox" checked={selected.includes(action.id)} disabled={loading || busy || Boolean(loadError)}
            aria-label={t("settings.graphicalMenuCollect", { name: label })}
            onChange={event => void save(event.target.checked ? [...selected, action.id] : selected.filter(id => id !== action.id))} />
          <span>{label}</span>
          {platform && <small>{t(platform === "mobile" ? "settings.graphicalMenuMobileOnly" : "settings.graphicalMenuDesktopOnly")}</small>}
        </label>;
      })}
    </div>
    {(error || loadError) && <p className="settings-result error" role="alert">{error || loadError}</p>}
  </section>;
}
