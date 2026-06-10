import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { QuickCommand, SshConfig, TerminalSession } from "../vite-env";

type EditSessionModalProps = {
  session: TerminalSession;
  onSave: (id: string, title: string, cwd: string, initialCommand: string, quickCommands?: QuickCommand[], sshConfig?: SshConfig) => void;
  onCancel: () => void;
};

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

export function EditSessionModal({ session, onSave, onCancel }: EditSessionModalProps) {
  const [editTitle, setEditTitle] = useState(session.title);
  const [editCwd, setEditCwd] = useState(session.cwd);
  const [editCommand, setEditCommand] = useState(session.initialCommand || "");
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(
    () => session.quickCommands ?? []
  );
  const [sshHost, setSshHost] = useState(session.sshConfig?.host || "");
  const [sshUsername, setSshUsername] = useState(session.sshConfig?.username || "");
  const [sshPort, setSshPort] = useState(String(session.sshConfig?.port || 22));
  const [sshIdentityFile, setSshIdentityFile] = useState(session.sshConfig?.identityFile || "");
  const [sshRemoteCommand, setSshRemoteCommand] = useState(session.sshConfig?.remoteCommand || "");
  const [sshExtraArgs, setSshExtraArgs] = useState((session.sshConfig?.extraArgs || []).join(" "));
  const [sshSecret, setSshSecret] = useState("");
  const [clearSshSecret, setClearSshSecret] = useState(false);
  const [sshRemark, setSshRemark] = useState(session.sshConfig?.remark || "");
  const isSsh = session.type === "ssh";

  const handleSave = () => {
    onSave(
      session.id,
      editTitle,
      editCwd,
      editCommand,
      quickCommands,
      isSsh ? {
        host: sshHost.trim(),
        username: sshUsername.trim() || undefined,
        port: Number(sshPort) || 22,
        identityFile: sshIdentityFile.trim() || undefined,
        remoteCommand: sshRemoteCommand.trim() || undefined,
        extraArgs: [],
        secret: clearSshSecret ? undefined : sshSecret || undefined,
        clearSecret: clearSshSecret,
        remark: sshRemark.trim() || undefined
      } : undefined
    );
  };

  const handleEscape = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    }
  };

  const handleAddCommand = () => {
    setQuickCommands((prev) => [
      ...prev,
      { id: generateId(), label: "", command: "" }
    ]);
  };

  const handleRemoveCommand = (id: string) => {
    setQuickCommands((prev) => prev.filter((qc) => qc.id !== id));
  };

  const handleCommandChange = (id: string, field: "label" | "command", value: string) => {
    setQuickCommands((prev) =>
      prev.map((qc) => (qc.id === id ? { ...qc, [field]: value } : qc))
    );
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>编辑会话</h3>
        </div>
        <div className="modal-body">
          <label className="modal-field">
            <span className="modal-label">会话名称</span>
            <input
              autoFocus
              className="modal-input"
              placeholder="输入会话名称"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleEscape}
            />
          </label>

          {isSsh ? (
            <div className="ssh-form">
              <div className="modal-grid two">
                <label className="modal-field">
                  <span className="modal-label">主机</span>
                  <input
                    className="modal-input"
                    placeholder="example.com 或 192.168.1.10"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    onKeyDown={handleEscape}
                  />
                </label>
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
              </div>
              <div className="modal-grid two">
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
                <label className="modal-field">
                  <span className="modal-label">密码或密钥口令</span>
                  <input
                    className="modal-input"
                    type="password"
                    placeholder={session.sshConfig?.hasSecret ? "已保存密码，留空保持不变" : "加密保存，用于自动登录"}
                    value={sshSecret}
                    disabled={clearSshSecret}
                    onChange={(e) => setSshSecret(e.target.value)}
                    onKeyDown={handleEscape}
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
                  <span>清除已保存密码</span>
                </label>
              )}
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
                  disabled
                  onChange={(e) => setSshExtraArgs(e.target.value)}
                  onKeyDown={handleEscape}
                />
              </label>
              <label className="modal-field">
                <span className="modal-label">备注</span>
                <textarea
                  className="modal-input modal-textarea"
                  placeholder="备注信息（可选）"
                  value={sshRemark}
                  onChange={(e) => setSshRemark(e.target.value)}
                  onKeyDown={handleEscape}
                  rows={2}
                />
              </label>
            </div>
          ) : (
            <>
            <label className="modal-field">
              <span className="modal-label">工作目录</span>
              <input
                className="modal-input"
                placeholder={session.type === "wsl" ? "/home/user/project" : "C:\\projects\\myapp"}
                value={editCwd}
                onChange={(e) => setEditCwd(e.target.value)}
                onKeyDown={handleEscape}
              />
            </label>
            <label className="modal-field">
              <span className="modal-label">初始命令</span>
              <textarea
                className="modal-input modal-textarea"
                placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
                value={editCommand}
                onChange={(e) => setEditCommand(e.target.value)}
                onKeyDown={handleEscape}
                rows={3}
              />
            </label>
            </>
          )}
          <label className="modal-label quick-command-heading">
            快捷命令
          </label>
          <div className="quick-command-edit-list">
            {quickCommands.map((qc) => (
              <div key={qc.id} className="quick-command-edit-row">
                <input
                  className="modal-input quick-cmd-input"
                  placeholder="显示名称"
                  value={qc.label}
                  onChange={(e) => handleCommandChange(qc.id, "label", e.target.value)}
                />
                <input
                  className="modal-input quick-cmd-input"
                  placeholder="命令内容"
                  value={qc.command}
                  onChange={(e) => handleCommandChange(qc.id, "command", e.target.value)}
                />
                <button
                  type="button"
                  className="mini-action danger"
                  onClick={() => handleRemoveCommand(qc.id)}
                  title="删除"
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
              <span>添加命令</span>
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-button" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="modal-button primary" type="button" onClick={handleSave} disabled={isSsh && sshHost.trim().length === 0}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
