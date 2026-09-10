import { Copy, FilePlus2, Save, Trash2 } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { EnvironmentEntry, EnvironmentProfile } from "../../vite-env";
import { EnvironmentEditor } from "./EnvironmentEditor";

type EnvironmentDraft = {
  id: string;
  name: string;
  entries: EnvironmentEntry[];
};

export type EnvironmentSettingsHandle = {
  save: () => Promise<boolean>;
  discard: () => void;
};

type EnvironmentSettingsProps = {
  onDirtyChange?: (dirty: boolean) => void;
  requestLeave?: (action: () => void) => void;
};

const EMPTY_DRAFT: EnvironmentDraft = { id: "", name: "", entries: [] };

function cloneDraft(draft: EnvironmentDraft): EnvironmentDraft {
  return { ...draft, entries: draft.entries.map(entry => ({ ...entry })) };
}

function profileDraft(profile?: EnvironmentProfile): EnvironmentDraft {
  return profile ? { id: profile.id, name: profile.name, entries: profile.entries.map(entry => ({ ...entry })) } : cloneDraft(EMPTY_DRAFT);
}

export const EnvironmentSettings = forwardRef<EnvironmentSettingsHandle, EnvironmentSettingsProps>(function EnvironmentSettings({ onDirtyChange, requestLeave }, ref) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [draft, setDraft] = useState<EnvironmentDraft>(() => cloneDraft(EMPTY_DRAFT));
  const [baseline, setBaseline] = useState<EnvironmentDraft>(() => cloneDraft(EMPTY_DRAFT));
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [baseline, draft]);
  const selectedProfile = profiles.find(profile => profile.id === draft.id);
  const references = [...new Set(selectedProfile?.references || [])];

  useEffect(() => {
    let disposed = false;
    window.environmentApi?.list().then(next => {
      if (!disposed) setProfiles(next);
    }).catch(error => {
      if (!disposed) setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const applyDraft = (next: EnvironmentDraft) => {
    const copy = cloneDraft(next);
    setDraft(copy);
    setBaseline(cloneDraft(copy));
    setMessage(null);
    setConfirmDelete(false);
  };

  const leaveThen = (action: () => void) => {
    if (dirty && requestLeave) requestLeave(action);
    else action();
  };

  const selectProfile = (id: string) => {
    if (id === draft.id) return;
    leaveThen(() => applyDraft(profileDraft(profiles.find(profile => profile.id === id))));
  };

  const saveDraft = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const nextProfiles = await window.environmentApi.save({ id: draft.id || undefined, name: draft.name, entries: draft.entries });
      const saved = nextProfiles.find(profile => profile.id === draft.id)
        || nextProfiles.find(profile => profile.name === draft.name.trim());
      const nextDraft = profileDraft(saved);
      setProfiles(nextProfiles);
      setDraft(nextDraft);
      setBaseline(cloneDraft(nextDraft));
      setMessage({ kind: "success", text: t("settings.environmentSaved") });
      return true;
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = () => {
    setDraft(cloneDraft(baseline));
    setMessage(null);
    setConfirmDelete(false);
  };

  useImperativeHandle(ref, () => ({ save: saveDraft, discard: discardDraft }));

  const copyProfile = () => {
    setDraft(current => ({ id: "", name: `${current.name}${t("settings.environmentCopySuffix")}`, entries: current.entries.map(entry => ({ ...entry })) }));
    setBaseline(cloneDraft(EMPTY_DRAFT));
    setMessage(null);
    setConfirmDelete(false);
  };

  const deleteProfile = async () => {
    if (!draft.id || references.length > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const nextProfiles = await window.environmentApi.delete(draft.id);
      setProfiles(nextProfiles);
      applyDraft(EMPTY_DRAFT);
      setMessage({ kind: "success", text: t("settings.environmentDeleted") });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="environment-settings-workspace">
      <aside className="environment-profile-panel" aria-label={t("settings.environmentProfiles")}>
        <div className="environment-profile-panel-header">
          <div>
            <strong>{t("settings.environmentProfiles")}</strong>
            <span>{t("settings.environmentProfileCount", { count: profiles.length })}</span>
          </div>
          <button className="icon-button primary" type="button" title={t("settings.environmentNewProfile")} aria-label={t("settings.environmentNewProfile")} disabled={busy} onClick={() => leaveThen(() => applyDraft(EMPTY_DRAFT))}>
            <FilePlus2 aria-hidden="true" />
          </button>
        </div>
        <div className="environment-profile-list">
          <button type="button" className={`environment-profile-item new${draft.id === "" ? " active" : ""}`} aria-current={draft.id === "" ? "page" : undefined} onClick={() => selectProfile("")}>
            <span><strong>{t("settings.environmentNewProfile")}</strong><small>{t("settings.environmentNewProfileHint")}</small></span>
          </button>
          {profiles.map(profile => {
            const referenceCount = new Set(profile.references || []).size;
            return (
              <button type="button" key={profile.id} className={`environment-profile-item${draft.id === profile.id ? " active" : ""}`} aria-current={draft.id === profile.id ? "page" : undefined} onClick={() => selectProfile(profile.id)}>
                <span><strong>{profile.name}</strong><small>{t("settings.environmentVariableCount", { count: profile.entries.length })}</small></span>
                {referenceCount > 0 && <small className="environment-reference-badge">{t("settings.environmentReferenceCount", { count: referenceCount })}</small>}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="environment-profile-editor" aria-label={draft.id ? draft.name : t("settings.environmentNewProfile")}>
        <fieldset disabled={busy}>
          <div className="environment-editor-title">
            <div>
              <h4>{draft.id ? draft.name : t("settings.environmentNewProfile")}</h4>
              <p>{t("settings.environmentDescription")}</p>
            </div>
            {dirty && <span className="environment-dirty-badge">{t("settings.environmentUnsaved")}</span>}
          </div>

          <label className="settings-field environment-name-field">
            <span className="modal-label">{t("settings.environmentProfileName")}</span>
            <input className="modal-input" aria-label={t("settings.environmentProfileName")} value={draft.name} placeholder={t("settings.environmentProfileNamePlaceholder")} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
          </label>

          <EnvironmentEditor value={draft.entries} onChange={entries => setDraft(current => ({ ...current, entries }))} />

          {references.length > 0 && (
            <div className="environment-references">
              <strong>{t("settings.environmentReferencedBy")}</strong>
              <span>{references.join(t("settings.environmentReferenceSeparator"))}</span>
              <small>{t("settings.environmentDeleteReferencedHint")}</small>
            </div>
          )}

          <div className="environment-actions">
            <button type="button" className="modal-button primary" disabled={!draft.name.trim()} onClick={() => void saveDraft()}>
              <Save aria-hidden="true" />
              {t("settings.environmentSave")}
            </button>
            <button type="button" className="modal-button" disabled={!draft.id} onClick={copyProfile}>
              <Copy aria-hidden="true" />
              {t("settings.environmentCopy")}
            </button>
            <button type="button" className={`modal-button danger${confirmDelete ? " confirm" : ""}`} disabled={!draft.id || references.length > 0} onClick={() => confirmDelete ? void deleteProfile() : setConfirmDelete(true)}>
              <Trash2 aria-hidden="true" />
              {confirmDelete ? t("settings.environmentConfirmDelete") : t("settings.environmentDelete")}
            </button>
            {confirmDelete && <button type="button" className="modal-button compact" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</button>}
          </div>
        </fieldset>
        {message && <div className={`settings-result environment-result ${message.kind}`} role="status">{message.text}</div>}
      </section>
    </div>
  );
});
