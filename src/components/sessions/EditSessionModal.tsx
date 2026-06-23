import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { AgentProvider, QuickCommand, SshConfig, TerminalSession } from "../../vite-env";
import { AgentProviderSelect } from "./AgentProviderSelect";
import { TagInput } from "../shared/TagInput";
import { SearchableSelect } from "../shared/SearchableSelect";
import { generateId } from "../../utils/id";

type EditSessionModalProps = {
  session: TerminalSession;
  tagSuggestions: string[];
  onSave: (id: string, title: string, cwd: string, initialCommand: string, agentProvider?: AgentProvider, quickCommands?: QuickCommand[], sshConfig?: SshConfig, tags?: string[]) => Promise<void>;
  onCancel: () => void;
};

export function EditSessionModal({ session, tagSuggestions, onSave, onCancel }: EditSessionModalProps) {
  const { t } = useI18n();
  const [editTitle, setEditTitle] = useState(session.title);
  const [editCwd, setEditCwd] = useState(session.cwd);
  const [editCommand, setEditCommand] = useState(session.initialCommand || session.sshConfig?.remoteCommand || "");
  const [agentProvider, setAgentProvider] = useState<AgentProvider | undefined>(session.agentProvider);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(
    () => (session.quickCommands ?? []).map((qc) => ({ ...qc, mode: qc.mode || "write" as const }))
  );
  const [sshHost, setSshHost] = useState(session.sshConfig?.host || "");
  const [sshUsername, setSshUsername] = useState(session.sshConfig?.username || "");
  const [sshPort, setSshPort] = useState(String(session.sshConfig?.port || 22));
  const [sshIdentityFile, setSshIdentityFile] = useState(session.sshConfig?.identityFile || "");
  const [sshExtraArgs, setSshExtraArgs] = useState((session.sshConfig?.extraArgs || []).join(" "));
  const [sshSecret, setSshSecret] = useState("");
  const [clearSshSecret, setClearSshSecret] = useState(false);
  const [sshRemark, setSshRemark] = useState(session.sshConfig?.remark || "");
  const [showAdvancedSsh, setShowAdvancedSsh] = useState(false);
  const [tags, setTags] = useState<string[]>(session.tags ?? []);
  const isSsh = session.type === "ssh";

  const handleSave = async () => {
    if (agentProvider && !editCwd.trim()) {
      setError(t("session.agentCwdRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSave(
      session.id,
      editTitle,
      editCwd,
      editCommand,
      agentProvider,
      quickCommands.filter((qc) => qc.command.trim().length > 0),
      isSsh ? {
        host: sshHost.trim(),
        username: sshUsername.trim() || undefined,
        port: Number(sshPort) || 22,
        identityFile: sshIdentityFile.trim() || undefined,
        secret: clearSshSecret ? undefined : sshSecret || undefined,
        clearSecret: clearSshSecret,
        remark: sshRemark.trim() || undefined
      } : undefined,
      tags
      );
    } catch (err: any) {
      setError(err?.message || t("session.updateFailed"));
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleAddCommand = () => {
    setQuickCommands((prev) => [
      ...prev,
      { id: generateId(), command: "", mode: "one-time" }
    ]);
  };

  const handleRemoveCommand = (id: string) => {
    setQuickCommands((prev) => prev.filter((qc) => qc.id !== id));
  };

  const handleCommandChange = (id: string, field: "command" | "mode", value: string) => {
    setQuickCommands((prev) =>
      prev.map((qc) => (qc.id === id ? { ...qc, [field]: value } : qc))
    );
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>{t("session.editTitle")}</h3>
        </div>
        <div className="modal-body">
          {error && <div className="modal-error">{error}</div>}
          <label className="modal-field">
            <span className="modal-label">{t("session.name")}</span>
            <input
              autoFocus
              className="modal-input"
              placeholder={t("session.namePlaceholder")}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
            />
          </label>
          <AgentProviderSelect value={agentProvider} onChange={setAgentProvider} />
          {isSsh ? (
            <div className="ssh-form">
              <div className="modal-grid two">
                <label className="modal-field">
                  <span className="modal-label">{t("session.host")}</span>
                  <input
                    className="modal-input"
                    placeholder={t("session.hostPlaceholder")}
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                  />
                </label>
                <label className="modal-field">
                  <span className="modal-label">{t("session.port")}</span>
                  <input
                    className="modal-input"
                    placeholder="22"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                  />
                </label>
              </div>
              <div className="modal-grid two">
                <label className="modal-field">
                  <span className="modal-label">{t("session.username")}</span>
                  <input
                    className="modal-input"
                    placeholder="root"
                    value={sshUsername}
                    onChange={(e) => setSshUsername(e.target.value)}
                  />
                </label>
                <label className="modal-field">
                  <span className="modal-label">{t("session.passwordOrKeyPassphrase")}</span>
                  <input
                    className="modal-input"
                    type="password"
                    placeholder={session.sshConfig?.hasSecret ? t("session.passwordEditPlaceholder") : t("session.passwordCreatePlaceholder")}
                    value={sshSecret}
                    disabled={clearSshSecret}
                    onChange={(e) => setSshSecret(e.target.value)}
                  />
                </label>
              </div>
              {session.sshConfig?.hasSecret && (
                <label className="modal-checkbox-field">
                  <input
                    type="checkbox"
                    checked={clearSshSecret}
                    onChange={(e) => {
                      setClearSshSecret(e.target.checked);
                      if (e.target.checked) {
                        setSshSecret("");
                      }
                    }}
                  />
                  <span>{t("session.clearSavedPassword")}</span>
                </label>
              )}
              <button
                type="button"
                className="ssh-advanced-toggle"
                onClick={() => setShowAdvancedSsh((v) => !v)}
              >
                {showAdvancedSsh ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{t("session.advancedSsh")}</span>
              </button>
              {showAdvancedSsh && (
                <>
                  <label className="modal-field">
                    <span className="modal-label">{t("session.identityFile")}</span>
                    <input
                      className="modal-input"
                      placeholder="C:\\Users\\me\\.ssh\\id_rsa"
                      value={sshIdentityFile}
                      onChange={(e) => setSshIdentityFile(e.target.value)}
                    />
                  </label>
                  <label className="modal-field">
                    <span className="modal-label">{t("session.sshArgs")}</span>
                    <input
                      className="modal-input"
                      placeholder="-o ServerAliveInterval=30"
                      value={sshExtraArgs}
                      disabled
                      onChange={(e) => setSshExtraArgs(e.target.value)}
                    />
                  </label>
                  <label className="modal-field">
                    <span className="modal-label">{t("session.remark")}</span>
                    <textarea
                      className="modal-input modal-textarea"
                      placeholder={t("session.remarkPlaceholder")}
                      value={sshRemark}
                      onChange={(e) => setSshRemark(e.target.value)}
                      rows={2}
                    />
                  </label>
                </>
              )}
              <label className="modal-field">
                <span className="modal-label">{t("session.cwd")}</span>
                <input
                  className="modal-input"
                  placeholder="/srv/app"
                  value={editCwd}
                  onChange={(e) => setEditCwd(e.target.value)}
                />
              </label>
              <label className="modal-field">
                  <span className="modal-label">{agentProvider ? t("session.preLaunchCommand") : t("session.initialCommand")}</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder={t("session.initialCommandPlaceholder", { example: "pnpm dev" })}
                  value={editCommand}
                  onChange={(e) => setEditCommand(e.target.value)}
                  rows={3}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">{t("session.tags")}</span>
                <TagInput tags={tags} suggestions={tagSuggestions} onChange={setTags} />
              </label>
            </div>
          ) : (
            <>
              <label className="modal-field">
                <span className="modal-label">{t("session.cwd")}</span>
                <input
                  className="modal-input"
                  placeholder={session.type === "wsl" ? "/home/user/project" : "C:\\projects\\myapp"}
                  value={editCwd}
                  onChange={(e) => setEditCwd(e.target.value)}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">{agentProvider ? t("session.preLaunchCommand") : t("session.initialCommand")}</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder={t("session.initialCommandPlaceholder", { example: "cd D:\\projects\\myapp" })}
                  value={editCommand}
                  onChange={(e) => setEditCommand(e.target.value)}
                  rows={3}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">{t("session.tags")}</span>
                <TagInput tags={tags} suggestions={tagSuggestions} onChange={setTags} />
              </label>
            </>
          )}
        </div>
        <div className="quick-command-section">
          <label className="quick-command-heading">
            {t("quickCommand.heading")}
          </label>
          <div className="quick-command-edit-list">
            {quickCommands.map((qc) => (
              <div key={qc.id} className="quick-command-edit-row">
                <input
                  className="modal-input quick-cmd-input"
                  placeholder={t("quickCommand.commandPlaceholder")}
                  value={qc.command}
                  onChange={(e) => handleCommandChange(qc.id, "command", e.target.value)}
                />
                <SearchableSelect
                  className="quick-cmd-mode-select"
                  value={qc.mode || "write"}
                  options={[
                    { value: "write", label: t("quickCommand.write") },
                    { value: "auto-enter", label: t("quickCommand.autoEnter") },
                    { value: "one-time", label: t("quickCommand.oneTime") }
                  ]}
                  ariaLabel={t("quickCommand.heading")}
                  menuMinWidth={180}
                  onChange={(mode) => handleCommandChange(qc.id, "mode", mode)}
                />
                <button
                  type="button"
                  className="mini-action danger"
                  onClick={() => handleRemoveCommand(qc.id)}
                  title={t("common.delete")}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="quick-command-add-btn"
              onClick={handleAddCommand}
            >
              <Plus size={14} />
              <span>{t("quickCommand.add")}</span>
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="modal-button primary" type="button" onClick={handleSave} disabled={submitting || (isSsh && sshHost.trim().length === 0) || Boolean(agentProvider && !editCwd.trim())}>
            {submitting ? t("session.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
