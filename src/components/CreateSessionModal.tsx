import { useEffect, useMemo, useState } from "react";
import { Box, Server, Terminal } from "lucide-react";
import { useI18n } from "../i18n";
import type { SshConfig } from "../vite-env";
import { TagInput } from "./TagInput";

export type CreateSessionRequest = {
  selectedShellId: string;
  title?: string;
  cwd?: string;
  initialCommand?: string;
  sshConfig?: SshConfig;
  tags?: string[];
};

type CreateSessionModalProps = {
  wslDistros: string[];
  tagSuggestions: string[];
  onCreate: (request: CreateSessionRequest) => Promise<void>;
  onCancel: () => void;
};

export function CreateSessionModal({ wslDistros, tagSuggestions, onCreate, onCancel }: CreateSessionModalProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [selectedShellId, setSelectedShellId] = useState("powershell");
  const [sshHost, setSshHost] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshIdentityFile, setSshIdentityFile] = useState("");
  const [sshSecret, setSshSecret] = useState("");
  const [sshRemark, setSshRemark] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSsh = selectedShellId === "ssh";
  const canCreate = useMemo(() => !isSsh || sshHost.trim().length > 0, [isSsh, sshHost]);

  const handleCreate = async () => {
    if (!canCreate) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        selectedShellId,
        title: title.trim() || undefined,
        cwd: cwd.trim() || undefined,
        initialCommand: commandInput.trim() || undefined,
        tags,
        sshConfig: isSsh ? {
          host: sshHost.trim(),
          username: sshUsername.trim() || undefined,
          port: Number(sshPort) || 22,
          identityFile: sshIdentityFile.trim() || undefined,
          secret: sshSecret || undefined,
          remark: sshRemark.trim() || undefined
        } : undefined
      });
    } catch (err: any) {
      setError(err?.message || t("session.createFailed"));
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

  return (
    <div className="modal-overlay">
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>{t("session.newTitle")}</h3>
        </div>
        <div className="modal-body">
          {error && <div className="modal-error">{error}</div>}
          <div className="shell-list">
            <button
              type="button"
              className={`shell-item ${selectedShellId === "powershell" ? "selected" : ""}`}
              onClick={() => setSelectedShellId("powershell")}
            >
              <Terminal aria-hidden="true" />
              PowerShell
            </button>
            {wslDistros.map((distro) => {
              const id = `wsl:${distro}`;
              return (
                <button
                  key={distro}
                  type="button"
                  className={`shell-item ${selectedShellId === id ? "selected" : ""}`}
                  onClick={() => setSelectedShellId(id)}
                >
                  <Box aria-hidden="true" />
                  {distro}
                </button>
              );
            })}
            <button
              type="button"
              className={`shell-item ${isSsh ? "selected" : ""}`}
              onClick={() => setSelectedShellId("ssh")}
            >
              <Server aria-hidden="true" />
              SSH
            </button>
          </div>
          {isSsh ? (
            <div className="ssh-form">
              <div className="modal-grid two">
                <label className="modal-field">
                  <span className="modal-label">{t("session.host")}</span>
                  <input
                    autoFocus
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
                    placeholder={t("session.passwordCreatePlaceholder")}
                    value={sshSecret}
                    onChange={(e) => setSshSecret(e.target.value)}
                  />
                </label>
              </div>
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
                <span className="modal-label">{t("session.remark")}</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder={t("session.remarkPlaceholder")}
                  value={sshRemark}
                  onChange={(e) => setSshRemark(e.target.value)}
                  rows={2}
                />
              </label>
              <input
                className="modal-input"
                placeholder={t("session.namePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <label className="modal-field">
                <span className="modal-label">{t("session.cwd")}</span>
                <input
                  className="modal-input"
                  placeholder="/srv/app"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">{t("session.initialCommand")}</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder={t("session.initialCommandPlaceholder", { example: "pnpm dev" })}
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  rows={3}
                />
              </label>
            </div>
          ) : (
            <>
              <input
                autoFocus
                className="modal-input"
                placeholder={t("session.namePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <label className="modal-field">
                <span className="modal-label">{t("session.cwd")}</span>
                <input
                  className="modal-input"
                  placeholder={selectedShellId.startsWith("wsl:") ? "/home/user/project" : "C:\\projects\\myapp"}
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">{t("session.initialCommand")}</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder={t("session.initialCommandPlaceholder", { example: "cd D:\\projects\\myapp" })}
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  rows={3}
                />
              </label>
            </>
          )}
          <label className="modal-field">
            <span className="modal-label">{t("session.tags")}</span>
            <TagInput tags={tags} suggestions={tagSuggestions} onChange={setTags} />
          </label>
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="modal-button primary" type="button" onClick={handleCreate} disabled={!canCreate || submitting}>
            {submitting ? t("session.creating") : t("session.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
