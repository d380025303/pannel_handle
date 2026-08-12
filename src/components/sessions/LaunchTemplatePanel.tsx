import { useMemo, useState } from "react";
import { GripVertical, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import type { LaunchTemplate, LaunchTemplateResult, LaunchTemplateSaveInput, TerminalSession } from "../../vite-env";

type LaunchTemplatePanelProps = {
  launchTemplates: LaunchTemplate[];
  sessionTemplates: TerminalSession[];
  onCreate: (input: LaunchTemplateSaveInput) => Promise<LaunchTemplate>;
  onUpdate: (id: string, input: LaunchTemplateSaveInput) => Promise<LaunchTemplate>;
  onDelete: (id: string) => Promise<void>;
  onLaunch: (id: string) => Promise<LaunchTemplateResult>;
};

export function moveLaunchTemplateMember(ids: string[], draggedId: string, targetId: string) {
  const fromIndex = ids.indexOf(draggedId);
  const toIndex = ids.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return ids;
  const next = [...ids];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function LaunchTemplateEditor({
  launchTemplate,
  sessionTemplates,
  reservedNames,
  onSave,
  onCancel
}: {
  launchTemplate?: LaunchTemplate;
  sessionTemplates: TerminalSession[];
  reservedNames: string[];
  onSave: (input: LaunchTemplateSaveInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(launchTemplate?.name ?? "");
  const [sessionTemplateIds, setSessionTemplateIds] = useState<string[]>(launchTemplate?.sessionTemplateIds ?? []);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionById = useMemo(() => new Map(sessionTemplates.map(item => [item.id, item])), [sessionTemplates]);

  const toggleMember = (id: string) => {
    setSessionTemplateIds((current) => (
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    ));
  };

  const handleSave = async () => {
    if (!name.trim() || isSaving) return;
    if (reservedNames.some(item => item.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) {
      setError(t("launchTemplate.nameExists"));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave({ name, sessionTemplateIds });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="launch-template-editor">
      <label className="settings-field">
        <span className="modal-label">{t("launchTemplate.name")}</span>
        <input
          className="modal-input"
          value={name}
          autoFocus
          placeholder={t("launchTemplate.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className="launch-template-editor-section">
        <span className="modal-label">{t("launchTemplate.selectedMembers")}</span>
        {sessionTemplateIds.length === 0 ? (
          <p className="launch-template-hint">{t("launchTemplate.noMembersSelected")}</p>
        ) : (
          <div className="launch-template-selected-list">
            {sessionTemplateIds.map((id) => (
              <div
                className={`launch-template-selected-item${draggedId === id ? " dragging" : ""}`}
                key={id}
                draggable
                onDragStart={(event) => {
                  setDraggedId(id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedId) setSessionTemplateIds((current) => moveLaunchTemplateMember(current, draggedId, id));
                  setDraggedId(null);
                }}
                onDragEnd={() => setDraggedId(null)}
              >
                <GripVertical aria-hidden="true" />
                <span>{sessionById.get(id)?.title ?? id}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <fieldset className="launch-template-member-picker">
        <legend>{t("launchTemplate.members")}</legend>
        {sessionTemplates.length === 0 ? (
          <p className="launch-template-hint">{t("picker.empty")}</p>
        ) : sessionTemplates.map((session) => (
          <label key={session.id}>
            <input
              type="checkbox"
              checked={sessionTemplateIds.includes(session.id)}
              onChange={() => toggleMember(session.id)}
            />
            <span>{session.title}</span>
            <small>{session.type === "ssh" ? "SSH" : session.type === "wsl" ? session.wslDistro || "WSL" : "PS"}</small>
          </label>
        ))}
      </fieldset>

      {error && <div className="picker-library-status error" role="alert">{error}</div>}
      <div className="launch-template-editor-actions">
        <button className="modal-button" type="button" disabled={isSaving} onClick={onCancel}>{t("common.cancel")}</button>
        <button className="modal-button primary" type="button" disabled={isSaving || !name.trim()} onClick={() => void handleSave()}>
          {isSaving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}

export function LaunchTemplatePanel({
  launchTemplates,
  sessionTemplates,
  onCreate,
  onUpdate,
  onDelete,
  onLaunch
}: LaunchTemplatePanelProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<LaunchTemplate | "new" | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<LaunchTemplateResult | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const sessionById = useMemo(() => new Map(sessionTemplates.map(item => [item.id, item])), [sessionTemplates]);

  if (editing) {
    const current = editing === "new" ? undefined : editing;
    return (
      <LaunchTemplateEditor
        key={current?.id ?? "new"}
        launchTemplate={current}
        sessionTemplates={sessionTemplates}
        reservedNames={launchTemplates.filter(item => item.id !== current?.id).map(item => item.name)}
        onCancel={() => setEditing(null)}
        onSave={async (input) => {
          if (current) await onUpdate(current.id, input);
          else await onCreate(input);
          setEditing(null);
        }}
      />
    );
  }

  const handleLaunch = async (id: string) => {
    if (launchingId) return;
    setLaunchingId(id);
    setLaunchResult(null);
    setLaunchError(null);
    try {
      const result = await onLaunch(id);
      if (result.failures.length > 0) setLaunchResult(result);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunchingId(null);
    }
  };

  return (
    <div className="launch-template-panel">
      <div className="launch-template-toolbar">
        <p>{t("launchTemplate.description")}</p>
        <button className="modal-button primary" type="button" onClick={() => setEditing("new")}>
          <Plus aria-hidden="true" />
          {t("launchTemplate.new")}
        </button>
      </div>

      {launchResult && (
        <div className="picker-library-status error launch-template-failures" role="alert">
          <strong>{t("launchTemplate.partialFailure", { count: launchResult.failures.length })}</strong>
          <ul>
            {launchResult.failures.map((failure) => (
              <li key={failure.templateId}>{failure.title ?? failure.templateId}: {failure.error}</li>
            ))}
          </ul>
        </div>
      )}
      {launchError && <div className="picker-library-status error" role="alert">{launchError}</div>}

      {launchTemplates.length === 0 ? (
        <div className="picker-empty"><p>{t("launchTemplate.empty")}</p></div>
      ) : (
        <div className="launch-template-list">
          {launchTemplates.map((template) => {
            const members = template.sessionTemplateIds.map(id => sessionById.get(id)?.title ?? id);
            const isEmpty = members.length === 0;
            return (
              <div className="launch-template-item" key={template.id}>
                <div className="launch-template-item-content">
                  <strong>{template.name}</strong>
                  <span>{isEmpty ? t("launchTemplate.noMembers") : members.join(" · ")}</span>
                  <small>{t("launchTemplate.memberCount", { count: members.length })}</small>
                </div>
                <div className="launch-template-actions">
                  <button
                    className="icon-button primary"
                    type="button"
                    title={t("launchTemplate.launch")}
                    aria-label={`${t("launchTemplate.launch")}: ${template.name}`}
                    disabled={isEmpty || Boolean(launchingId)}
                    onClick={() => void handleLaunch(template.id)}
                  >
                    <Play aria-hidden="true" />
                  </button>
                  <button className="icon-button" type="button" title={t("picker.editSession")} aria-label={`${t("picker.editSession")}: ${template.name}`} disabled={Boolean(launchingId)} onClick={() => setEditing(template)}>
                    <Pencil aria-hidden="true" />
                  </button>
                  <button
                    className={`icon-button danger${confirmDeleteId === template.id ? " confirm" : ""}`}
                    type="button"
                    title={confirmDeleteId === template.id ? t("picker.confirmDelete") : t("common.delete")}
                    aria-label={`${confirmDeleteId === template.id ? t("common.confirm") : t("common.delete")}: ${template.name}`}
                    disabled={Boolean(launchingId)}
                    onClick={() => {
                      if (confirmDeleteId === template.id) {
                        void onDelete(template.id).catch((err) => {
                          setLaunchError(err instanceof Error ? err.message : String(err));
                        });
                        setConfirmDeleteId(null);
                      } else {
                        setConfirmDeleteId(template.id);
                      }
                    }}
                  >
                    {confirmDeleteId === template.id ? t("common.confirm") : <Trash2 aria-hidden="true" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
