import { useEffect, useState } from "react";

type CreateSessionModalProps = {
  wslDistros: string[];
  onCreate: (selectedShellId: string, title?: string, initialCommand?: string) => void;
  onCancel: () => void;
};

export function CreateSessionModal({ wslDistros, onCreate, onCancel }: CreateSessionModalProps) {
  const [title, setTitle] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [selectedShellId, setSelectedShellId] = useState("powershell");

  useEffect(() => {
    setSelectedShellId(wslDistros.length > 0 ? `wsl:${wslDistros[0]}` : "powershell");
  }, [wslDistros]);

  const handleCreate = () => {
    onCreate(selectedShellId, title.trim() || undefined, commandInput.trim() || undefined);
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
                  {distro}
                </button>
              );
            })}
          </div>
          <input
            className="modal-input"
            placeholder="会话名称（可选）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onCancel();
              }
            }}
          />
          <textarea
            autoFocus
            className="modal-input modal-textarea"
            placeholder="输入初始命令（可选），如：cd D:\\projects\\myapp"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onCancel();
              }
            }}
            rows={3}
          />
        </div>
        <div className="modal-footer">
          <button
            className="modal-button"
            type="button"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="modal-button primary"
            type="button"
            onClick={handleCreate}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
