import { useMemo, useState } from "react";
import { Box, Server, Terminal } from "lucide-react";
import type { SshConfig } from "../vite-env";

export type CreateSessionRequest = {
  selectedShellId: string;
  title?: string;
  initialCommand?: string;
  sshConfig?: SshConfig;
};

type CreateSessionModalProps = {
  wslDistros: string[];
  onCreate: (request: CreateSessionRequest) => void;
  onCancel: () => void;
};

function parseExtraArgs(value: string) {
  return value
    .split(/\s+/)
    .map(arg => arg.trim())
    .filter(Boolean);
}

export function CreateSessionModal({ wslDistros, onCreate, onCancel }: CreateSessionModalProps) {
  const [title, setTitle] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [selectedShellId, setSelectedShellId] = useState("powershell");
  const [sshHost, setSshHost] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshIdentityFile, setSshIdentityFile] = useState("");
  const [sshRemoteCommand, setSshRemoteCommand] = useState("");
  const [sshExtraArgs, setSshExtraArgs] = useState("");
  const [sshSecret, setSshSecret] = useState("");

  const isSsh = selectedShellId === "ssh";
  const canCreate = useMemo(() => !isSsh || sshHost.trim().length > 0, [isSsh, sshHost]);

  const handleCreate = () => {
    if (!canCreate) {
      return;
    }
    onCreate({
      selectedShellId,
      title: title.trim() || undefined,
      initialCommand: isSsh ? undefined : commandInput.trim() || undefined,
      sshConfig: isSsh ? {
        host: sshHost.trim(),
        username: sshUsername.trim() || undefined,
        port: Number(sshPort) || 22,
        identityFile: sshIdentityFile.trim() || undefined,
        remoteCommand: sshRemoteCommand.trim() || undefined,
        extraArgs: parseExtraArgs(sshExtraArgs),
        secret: sshSecret || undefined
      } : undefined
    });
  };

  const handleEscape = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>新建会话</h3>
        </div>
        <div className="modal-body">
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
          <input
            className="modal-input"
            placeholder="会话名称（可选）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleEscape}
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
                    onChange={(e) => setSshHost(e.target.value)}
                    onKeyDown={handleEscape}
                  />
                </label>
                <label className="modal-field">
                  <span className="modal-label">用户名</span>
                  <input
                    className="modal-input"
                    placeholder="root"
                    value={sshUsername}
                    onChange={(e) => setSshUsername(e.target.value)}
                    onKeyDown={handleEscape}
                  />
                </label>
              </div>
              <div className="modal-grid two">
                <label className="modal-field">
                  <span className="modal-label">端口</span>
                  <input
                    className="modal-input"
                    placeholder="22"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    onKeyDown={handleEscape}
                  />
                </label>
                <label className="modal-field">
                  <span className="modal-label">密钥路径</span>
                  <input
                    className="modal-input"
                    placeholder="C:\\Users\\me\\.ssh\\id_rsa"
                    value={sshIdentityFile}
                    onChange={(e) => setSshIdentityFile(e.target.value)}
                    onKeyDown={handleEscape}
                  />
                </label>
              </div>
              <label className="modal-field">
                <span className="modal-label">远程启动命令</span>
                <input
                  className="modal-input"
                  placeholder="cd /srv/app && bash"
                  value={sshRemoteCommand}
                  onChange={(e) => setSshRemoteCommand(e.target.value)}
                  onKeyDown={handleEscape}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">额外 SSH 参数</span>
                <input
                  className="modal-input"
                  placeholder="-o ServerAliveInterval=30"
                  value={sshExtraArgs}
                  onChange={(e) => setSshExtraArgs(e.target.value)}
                  onKeyDown={handleEscape}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">密码或密钥口令</span>
                <input
                  className="modal-input"
                  type="password"
                  placeholder="加密保存，用于自动登录"
                  value={sshSecret}
                  onChange={(e) => setSshSecret(e.target.value)}
                  onKeyDown={handleEscape}
                />
              </label>
            </div>
          ) : (
            <textarea
              autoFocus
              className="modal-input modal-textarea"
              placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              onKeyDown={handleEscape}
              rows={3}
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="modal-button primary" type="button" onClick={handleCreate} disabled={!canCreate}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
