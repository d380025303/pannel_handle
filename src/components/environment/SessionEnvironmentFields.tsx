import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import type { EnvironmentProfile, EnvironmentSelection, EnvironmentPreview } from "../../vite-env";
import { EnvironmentEditor } from "./EnvironmentEditor";

type Props = {
  value: EnvironmentSelection;
  onChange: (value: EnvironmentSelection) => void;
  type: string;
  agentProvider?: string;
  agentLocation?: string;
  embedded?: boolean;
};

export function SessionEnvironmentFields({ value, onChange, type, agentProvider, agentLocation, embedded = false }: Props) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [preview, setPreview] = useState<EnvironmentPreview[]>([]);
  const [error, setError] = useState("");

  useEffect(() => { window.environmentApi?.list().then(setProfiles).catch((error) => setError(String(error))); }, []);
  useEffect(() => {
    let disposed = false;
    window.environmentApi?.preview({ ...value, type, agentProvider, agentLocation })
      .then((result) => { if (!disposed) { setPreview(result); setError(""); } })
      .catch((error) => { if (!disposed) { setPreview([]); setError(String(error)); } });
    return () => { disposed = true; };
  }, [value, type, agentProvider, agentLocation]);

  const content = <>
    <p>{t("session.environmentHint")}</p>
    <label className="modal-field">
      <span className="modal-label">{t("session.environmentProfile")}</span>
      <select className="modal-input" value={value.environmentProfileId || ""} onChange={(event) => onChange({ ...value, environmentProfileId: event.target.value || null })}>
        <option value="">{t("session.environmentProfileNone")}</option>
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
    </label>
    <EnvironmentEditor value={value.environmentOverrides || []} onChange={(environmentOverrides) => onChange({ ...value, environmentOverrides })} />
    {error && <div role="alert" className="modal-error">{error}</div>}
    {preview.length > 0 && <><p>{t("session.environmentPreview")}</p><table className="environment-preview"><thead><tr><th>{t("session.environmentVariable")}</th><th>{t("session.environmentValue")}</th><th>{t("session.environmentSource")}</th></tr></thead><tbody>{preview.map((entry) => <tr key={entry.name}><td>{entry.name}</td><td>{entry.value === "" ? t("session.environmentEmptyValue") : entry.value}</td><td>{entry.source}</td></tr>)}</tbody></table></>}
    <p>{t("session.environmentPrecedenceHint")}</p>
    {type === "ssh" && <p>{agentProvider && agentLocation === "local" ? t("session.environmentLocalSshHint") : t("session.environmentRemoteSshHint")}</p>}
  </>;

  if (embedded) return <div className="environment-settings embedded">{content}</div>;
  return <details className="environment-settings"><summary>{t("session.environment")}{value.environmentProfileId || value.environmentOverrides?.length ? `（${t("session.configured")}）` : ""}</summary>{content}</details>;
}
