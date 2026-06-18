import { useEffect, useMemo, useState } from "react";
import { Box, Server, Terminal } from "lucide-react";
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
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [selectedShellId, setSelectedShellId] = useState("powershell");
  const [sshHost, setSshHost] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshIdentityFile, setSshIdentityFile] = useState("");
  const [sshExtraArgs, setSshExtraArgs] = useState("");
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
      setError(err?.message || "创建会话失败");
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
          <h3>新建会话</h3>
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
          <label className="modal-field">
            <span className="modal-label">标签</span>
            <TagInput tags={tags} suggestions={tagSuggestions} onChange={setTags} />
          </label>
          <input
            className="modal-input"
            placeholder="会话名称（可选）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
                      />

          {isSsh ? (
            <div className="ssh-form">
              <div className="modal-grid two">
                <label className="modal-field">
                  <span className="modal-label">主机</span>
                  <input
                    autoFocus
                    className="modal-input"
                    placeholder="example.com 或 192.168.1.10"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}                  />
                </label>
                <label className="modal-field">
                  <span className="modal-label">端口</span>
                  <input
                    className="modal-input"
                    placeholder="22"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}                  />
                </label>
              </div>
              <div className="modal-grid two">
                <label className="modal-field">
                  <span className="modal-label">用户名</span>
                  <input
                    className="modal-input"
                    placeholder="root"
                    value={sshUsername}
                    onChange={(e) => setSshUsername(e.target.value)}                  />
                </label>
                <label className="modal-field">
                  <span className="modal-label">密码或密钥口令</span>
                  <input
                    className="modal-input"
                    type="password"
                    placeholder="加密保存，用于自动登录"
                    value={sshSecret}
                    onChange={(e) => setSshSecret(e.target.value)}                  />
                </label>
              </div>
              <label className="modal-field">
                <span className="modal-label">密钥路径</span>
                <input
                  className="modal-input"
                  placeholder="C:\\Users\\me\\.ssh\\id_rsa"
                  value={sshIdentityFile}
                  onChange={(e) => setSshIdentityFile(e.target.value)}
                                  />
              </label>
              <label className="modal-field">
                <span className="modal-label">工作目录</span>
                <input
                  className="modal-input"
                  placeholder="/srv/app"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                                  />
              </label>
              <label className="modal-field">
                <span className="modal-label">初始命令</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder="输入初始命令（可选），如：pnpm dev"
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  rows={3}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">额外 SSH 参数</span>
                <input
                  className="modal-input"
                  placeholder="-o ServerAliveInterval=30"
                  value={sshExtraArgs}
                  disabled
                  onChange={(e) => setSshExtraArgs(e.target.value)}
                                  />
              </label>
              <label className="modal-field">
                <span className="modal-label">备注</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder="备注信息（可选）"
                  value={sshRemark}
                  onChange={(e) => setSshRemark(e.target.value)}
                                    rows={2}
                />
              </label>
            </div>
          ) : (
            <>
              <label className="modal-field">
                <span className="modal-label">工作目录</span>
                <input
                  autoFocus
                  className="modal-input"
                  placeholder={selectedShellId.startsWith("wsl:") ? "/home/user/project" : "C:\\projects\\myapp"}
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                                  />
              </label>
              <textarea
              className="modal-input modal-textarea"
              placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
                              rows={3}
              />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="modal-button primary" type="button" onClick={handleCreate} disabled={!canCreate || submitting}>
            {submitting ? "创建中..." : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
