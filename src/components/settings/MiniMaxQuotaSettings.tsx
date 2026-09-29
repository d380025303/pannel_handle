import { useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n";
import { MiniMaxUsageSection } from "./MiniMaxUsageSection";

export function MiniMaxQuotaSettings() {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();

  useEffect(() => {
    let active = true;
    void window.miniMaxApi.getConfig().then(config => {
      if (active) setConfigured(config.hasApiKey);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, []);

  return <section className="settings-section codebuddy-quota-settings" aria-label={t("settings.miniMaxQuotaTitle")}>
    <div className="codebuddy-quota-settings-header">
      <h5><button type="button" className="quota-collapse-button" aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}>
        <span className={`collapsible-chevron${expanded ? "" : " collapsed"}`} aria-hidden="true">▾</span>
        {t("settings.miniMaxQuotaTitle")}
      </button></h5>
    </div>
    <div id={contentId} className="quota-collapsible-body" hidden={!expanded}>
      {configured === null && !error && <p className="settings-help" role="status">{t("usage.miniMaxLoading")}</p>}
      {error && <p className="settings-result error" role="alert">{error}</p>}
      {configured === false && <p className="settings-help">{t("settings.miniMaxQuotaConfigure")}</p>}
      {configured && <MiniMaxUsageSection hasApiKey defaultExpanded />}
    </div>
  </section>;
}
