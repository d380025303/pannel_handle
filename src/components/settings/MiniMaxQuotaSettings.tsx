import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { MiniMaxUsageSection } from "./MiniMaxUsageSection";

export function MiniMaxQuotaSettings() {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void window.miniMaxApi.getConfig().then(config => {
      if (active) setConfigured(config.hasApiKey);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, []);

  return <section className="settings-section" aria-label={t("settings.miniMaxQuotaTitle")}>
    <h4>{t("settings.miniMaxQuotaTitle")}</h4>
    {configured === null && !error && <p className="settings-help" role="status">{t("usage.miniMaxLoading")}</p>}
    {error && <p className="settings-result error" role="alert">{error}</p>}
    {configured === false && <p className="settings-help">{t("settings.miniMaxQuotaConfigure")}</p>}
    {configured && <MiniMaxUsageSection hasApiKey defaultExpanded />}
  </section>;
}
